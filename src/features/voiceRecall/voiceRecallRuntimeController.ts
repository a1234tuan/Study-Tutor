/**
 * App 级语音复述运行态控制器（§4.3、§14）。
 *
 * 持有活动连接、播放器与内存队列；组件卸载不能等同于会话结束，但必须触发采集/播放暂停。
 * 状态所有权分三层：本控制器持有运行态；导航状态只持有来源身份；schema 21 保存可恢复检查点。
 *
 * 幂等键（§14、§19）：sessionId + turnId + operationId。重试使用同一键，不重复提交回答或播放两遍。
 * 打断（§13.2）：作废当前 generation，丢弃晚到的旧结果。
 * 门控（§8.2）：userMuted 与 systemCaptureGate 分离；有效采集条件
 *   captureRequested && !userMuted && !systemCaptureGate。
 */

import type { VoiceCallState } from "./domain";
import type { LayeredAbortController, PlaybackGenerationFactory } from "./providerContracts";
import { LayeredAbortControllerImpl } from "./runtime";
import { transition } from "./stateMachine";
import type { VoiceCallEvent } from "./stateMachine";
import type { VoicePlaybackQueue } from "./playbackQueue";

export interface VoiceRecallRuntimeControllerOptions {
  generationFactory: PlaybackGenerationFactory;
  playbackQueue: VoicePlaybackQueue;
}

export interface TurnHandle {
  turnId: string;
  operationId: string;
}

export type SubmitResult =
  | { status: "submitted"; operationId: string }
  | { status: "duplicate"; operationId: string }; // 幂等：同一 operationId 不重复提交（§19）

export class VoiceRecallRuntimeController {
  private sessionId: string | null = null;
  private callState: VoiceCallState = "idle";
  private userMuted = false;
  private systemCaptureGate = false;
  private captureRequested = false;
  private turnSequence = 0;
  private operationSequence = 0;
  private readonly submittedOperations = new Set<string>();
  private sessionAbort: LayeredAbortController | null = null;
  private turnAbort: LayeredAbortController | null = null;
  private unmounted = false;

  constructor(private readonly options: VoiceRecallRuntimeControllerOptions) {}

  /** 开始会话。App 级 controller 持有运行态；导航只存来源身份。 */
  startSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.callState = "idle";
    this.turnSequence = 0;
    this.operationSequence = 0;
    this.submittedOperations.clear();
    this.unmounted = false;
    // 会话级取消 controller（§13.2）。活动轮次级由 createTurn 派生，下级随上级 abort。
    this.sessionAbort?.dispose();
    this.sessionAbort = new LayeredAbortControllerImpl("session");
    this.turnAbort = null;
  }

  /** 结束会话：释放麦克风、连接、播放器与临时音频（§14）。 */
  endSession(): void {
    // 会话级 abort 触发所有派生（活动轮次/单请求）取消。
    this.sessionAbort?.abort("session-end");
    this.sessionAbort?.dispose();
    this.sessionAbort = null;
    this.turnAbort = null;
    this.options.playbackQueue.clear();
    this.options.generationFactory.invalidateAll();
    this.captureRequested = false;
    this.systemCaptureGate = false;
    this.callState = "idle";
    this.sessionId = null;
  }

  isSessionActive(): boolean {
    return this.sessionId !== null;
  }

  getState(): VoiceCallState {
    return this.callState;
  }

  /** 组件卸载：暂停采集与播放，保留会话检查点（§14：卸载 ≠ 结束）。 */
  pauseForUnmount(): void {
    this.unmounted = true;
    this.captureRequested = false;
    this.turnAbort?.abort("unmount-pause");
    this.options.playbackQueue.clear();
    // 会话本身保留：isSessionActive 仍为 true，恢复时由用户明确继续。
  }

  /** 恢复会话：返回通话页后由用户明确继续（§14）。 */
  resumeAfterUnmount(): void {
    if (!this.unmounted) return;
    this.unmounted = false;
    // 不自动恢复采集；等待用户明确继续。
  }

  get unmountedFlag(): boolean {
    return this.unmounted;
  }

  /** 创建一轮新 turn，分配 turnId 与 operationId（幂等键组成，§14）。 */
  createTurn(): TurnHandle {
    this.turnSequence += 1;
    this.operationSequence += 1;
    const turnId = `${this.sessionId ?? "session"}-turn-${this.turnSequence}`;
    const operationId = `${turnId}-op-${this.operationSequence}`;
    // 派生轮次级 controller，与会话级 signal 关联（§13.2：下级随上级 abort）。
    this.turnAbort?.abort("turn-superseded");
    this.turnAbort = (this.sessionAbort ?? new LayeredAbortControllerImpl("session")).derive("turn");
    return { turnId, operationId };
  }

  /**
   * 幂等提交（§19：同一 operationId 不重复提交回答或播放两遍）。
   * 返回 duplicate 表示该操作已提交过，调用方不得再次触发 LLM/TTS。
   */
  submitOperation(operationId: string): SubmitResult {
    if (this.submittedOperations.has(operationId)) {
      return { status: "duplicate", operationId };
    }
    this.submittedOperations.add(operationId);
    return { status: "submitted", operationId };
  }

  /** 用户打断（§13.2）：作废当前 generation，丢弃晚到的旧 TTS 结果，取消本轮。 */
  interrupt(): void {
    this.options.generationFactory.invalidateAll();
    this.options.playbackQueue.clear();
    this.turnAbort?.abort("interrupt");
    this.systemCaptureGate = false;
    this.apply("interrupt");
  }

  /** 设置用户静音（跨轮次保持，只有用户再次操作才能解除，§8.2）。 */
  setUserMuted(value: boolean): void {
    this.userMuted = value;
  }

  /** 系统麦克风门控（TTS 播放/音频焦点/后台临时设置；条件消失后只恢复到 userMuted 允许的状态）。 */
  setSystemCaptureGate(value: boolean): void {
    this.systemCaptureGate = value;
  }

  /** 有效采集条件（§8.2）。 */
  canCapture(): boolean {
    return this.captureRequested && !this.userMuted && !this.systemCaptureGate;
  }

  setCaptureRequested(value: boolean): void {
    this.captureRequested = value;
  }

  /** 当前轮次取消信号（供 adapter 关联单请求级 controller，§13.2）。 */
  getTurnSignal(): AbortSignal | null {
    return this.turnAbort?.signal ?? null;
  }

  /** 状态迁移（非法迁移不变更状态）。 */
  apply(event: VoiceCallEvent): void {
    this.callState = transition(this.callState, event).state;
  }
}
