import { describe, expect, it } from "vitest";
import { VoicePlaybackQueue } from "./playbackQueue";

const frame = (sequence: number) => ({
  sequence,
  timestampMs: sequence * 100,
  format: "pcm-s16le" as const,
  sampleRate: 16000,
  channels: 1,
  samples: new Int16Array(160),
});

describe("VoicePlaybackQueue generation discard (§13.2)", () => {
  it("plays frames from the current generation in FIFO order", () => {
    const q = new VoicePlaybackQueue();
    expect(q.enqueue(frame(0), 1, 0)).toBe(true);
    expect(q.enqueue(frame(1), 1, 10)).toBe(true);
    expect(q.size).toBe(2);
    expect(q.dequeue()?.frame.sequence).toBe(0);
    expect(q.dequeue()?.frame.sequence).toBe(1);
    expect(q.dequeue()).toBeNull();
  });

  it("drops late frames from an invalidated generation — they are not played", () => {
    const q = new VoicePlaybackQueue();
    q.enqueue(frame(0), 1, 0);
    q.enqueue(frame(1), 1, 10);
    q.invalidateGeneration(1); // 用户打断：作废代次 1
    expect(q.enqueue(frame(2), 1, 20)).toBe(false); // 晚到的旧 generation 被拒绝入队
    expect(q.size).toBe(0); // 已排队的旧帧也被作废，size=0
    expect(q.dequeue()).toBeNull();
  });

  it("does not replay already-invalidated queued frames when a newer generation starts", () => {
    const q = new VoicePlaybackQueue();
    q.enqueue(frame(0), 1, 0);
    q.enqueue(frame(1), 1, 10);
    q.invalidateGeneration(1);
    // 新代次
    expect(q.enqueue(frame(2), 2, 30)).toBe(true);
    expect(q.enqueue(frame(3), 2, 40)).toBe(true);
    expect(q.dequeue()?.frame.sequence).toBe(2); // 旧代次帧被跳过，新代次帧播放
    expect(q.dequeue()?.frame.sequence).toBe(3);
    expect(q.dequeue()).toBeNull();
  });

  it("clear() cancels the pending TTS queue without affecting completed playback accounting", () => {
    const q = new VoicePlaybackQueue();
    q.enqueue(frame(0), 1, 0);
    q.enqueue(frame(1), 1, 10);
    q.dequeue(); // play frame 0
    q.clear(); // 用户打断，清空未播放
    expect(q.size).toBe(0);
    expect(q.completedPlaybackRange(1)).toEqual({ startTurn: 0, endTurn: 0 });
  });

  it("tracks completed playback range per generation for VoiceRecallTurnLocal", () => {
    const q = new VoicePlaybackQueue();
    q.enqueue(frame(0), 3, 0);
    q.enqueue(frame(1), 3, 10);
    q.enqueue(frame(2), 3, 20);
    q.dequeue();
    q.dequeue();
    q.dequeue();
    expect(q.completedPlaybackRange(3)).toEqual({ startTurn: 0, endTurn: 2 });
    expect(q.completedPlaybackRange(4)).toBeNull();
  });
});
