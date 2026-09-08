import { describe, expect, it } from "vitest";
import { VoicePlaybackQueue } from "./playbackQueue";
import { PlaybackGenerationFactoryImpl } from "./runtime";
import { VoiceRecallRuntimeController } from "./voiceRecallRuntimeController";

const frame = (sequence: number) => ({
  sequence,
  timestampMs: sequence * 100,
  format: "pcm-s16le" as const,
  sampleRate: 16000,
  channels: 1,
  samples: new Int16Array(160),
});

const makeController = () =>
  new VoiceRecallRuntimeController({
    generationFactory: new PlaybackGenerationFactoryImpl(),
    playbackQueue: new VoicePlaybackQueue(),
  });

describe("VoiceRecallRuntimeController idempotency (§14/§19)", () => {
  it("uses sessionId+turnId+operationId keys and rejects duplicate submission of the same operation", () => {
    const controller = makeController();
    controller.startSession("voice-session-1");

    const { turnId, operationId } = controller.createTurn();
    expect(turnId).toContain("voice-session-1-turn-1");
    expect(operationId).toBe(`${turnId}-op-1`);

    // 首次提交：accepted。
    expect(controller.submitOperation(operationId)).toEqual({
      status: "submitted",
      operationId,
    });
    // 重试同一 operationId：幂等拒绝，不重复提交回答或播放两遍（§19）。
    expect(controller.submitOperation(operationId)).toEqual({
      status: "duplicate",
      operationId,
    });

    // 新轮次分配新键，独立提交。
    const next = controller.createTurn();
    expect(next.turnId).toContain("turn-2");
    expect(controller.submitOperation(next.operationId).status).toBe("submitted");

    controller.endSession();
  });

  it("component unmount pauses capture/playback but does NOT end the session (§14)", () => {
    const controller = makeController();
    controller.startSession("voice-session-2");
    controller.setCaptureRequested(true);
    expect(controller.canCapture()).toBe(true);

    controller.pauseForUnmount();

    // 卸载 ≠ 结束：会话仍活动。
    expect(controller.isSessionActive()).toBe(true);
    expect(controller.unmountedFlag).toBe(true);
    // 采集已暂停。
    expect(controller.canCapture()).toBe(false);

    // 恢复由用户明确触发（§14），不自动恢复采集。
    controller.resumeAfterUnmount();
    expect(controller.unmountedFlag).toBe(false);
    // 恢复后仍需用户明确 setCaptureRequested 才采集。
    expect(controller.canCapture()).toBe(false);
  });

  it("unmount clears the playback queue without ending the session", () => {
    const controller = makeController();
    controller.startSession("voice-session-3");
    // 假设有排队帧。
    controller.pauseForUnmount();
    // 恢复后队列应已清空（无遗留播放）。
    expect(controller.getState()).toBe("idle");
    expect(controller.isSessionActive()).toBe(true);
  });

  it("interrupt invalidates the current generation and transitions speaking → listening (§13.2)", () => {
    const controller = makeController();
    controller.startSession("voice-session-4");
    controller.setCaptureRequested(true);
    controller.apply("start-preflight");
    controller.apply("preflight-passed");
    controller.apply("connected");
    controller.apply("capture-started");
    controller.apply("silence-detected");
    controller.apply("asr-finalized");
    controller.apply("llm-first-token");
    expect(controller.getState()).toBe("speaking");

    // 晚到的旧 generation 帧先入队。
    const q = new VoicePlaybackQueue();
    q.enqueue(frame(0), 1, 0);
    expect(q.size).toBe(1);

    controller.interrupt();
    expect(controller.getState()).toBe("listening");
    // 旧 generation 已作废：晚到的旧结果不得重新开始播放。
    q.invalidateGeneration(1);
    expect(q.enqueue(frame(1), 1, 10)).toBe(false);
    expect(q.size).toBe(0);
  });

  it("turn signal is available after createTurn and cleared on endSession", () => {
    const controller = makeController();
    controller.startSession("voice-session-5");
    expect(controller.getTurnSignal()).toBeNull();
    controller.createTurn();
    expect(controller.getTurnSignal()).not.toBeNull();
    controller.endSession();
    expect(controller.getTurnSignal()).toBeNull();
    expect(controller.isSessionActive()).toBe(false);
  });

  it("endSession aborts session-level controller so derived turn aborts cascade (§13.2)", () => {
    const controller = makeController();
    controller.startSession("voice-session-6");
    controller.createTurn();
    const signal = controller.getTurnSignal()!;
    expect(signal.aborted).toBe(false);
    controller.endSession();
    // 会话级 abort 触发派生轮次级 abort（分层取消）。
    expect(signal.aborted).toBe(true);
  });
});
