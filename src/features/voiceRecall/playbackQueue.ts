/**
 * 播放队列与抖动缓冲（§13.1、§13.2）。
 *
 * 句界缓冲器得到首个可朗读短句后请求 TTS；音频分片进入抖动缓冲后播放；
 * 后续句子并行排队。播放队列使用递增 generation；只有当前 generation 的异步结果可入队。
 * 用户打断时取消后续 TTS 队列，晚到的旧 generation 结果必须被丢弃，不能重新开始播放。
 */

import type { VoiceAudioFrame } from "./providerContracts";

export interface QueuedPlaybackFrame {
  frame: VoiceAudioFrame;
  generation: number;
  enqueuedAtMs: number;
}

export class VoicePlaybackQueue {
  private readonly queue: QueuedPlaybackFrame[] = [];
  private readonly invalidatedGenerations = new Set<number>();
  /** 每个 generation 已播放完成的帧数，用于写回 VoiceRecallTurnLocal.playbackCompletedRange。 */
  private readonly playedByGeneration = new Map<number, number>();

  /** 入队。旧 generation 或已作废 generation 返回 false（§13.2 晚到结果丢弃）。 */
  enqueue(frame: VoiceAudioFrame, generation: number, nowMs: number): boolean {
    if (this.invalidatedGenerations.has(generation)) return false;
    this.queue.push({ frame, generation, enqueuedAtMs: nowMs });
    return true;
  }

  /** 出队下一帧（FIFO）。跳过已被作废 generation 的帧。 */
  dequeue(): QueuedPlaybackFrame | null {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (this.invalidatedGenerations.has(next.generation)) continue;
      this.playedByGeneration.set(next.generation, (this.playedByGeneration.get(next.generation) ?? 0) + 1);
      return next;
    }
    return null;
  }

  /** 作废某代次：丢弃该 generation 已排队但未播放的帧；此后该 generation 入队直接拒绝。 */
  invalidateGeneration(generation: number): void {
    this.invalidatedGenerations.add(generation);
  }

  /** 用户打断（§13.2）：取消后续 TTS 队列，清空未播放帧。 */
  clear(): void {
    this.queue.length = 0;
  }

  get size(): number {
    return this.queue.filter((item) => !this.invalidatedGenerations.has(item.generation)).length;
  }

  /** 已完成播放的代次范围（写入 VoiceRecallTurnLocal.playbackCompletedRange）。 */
  completedPlaybackRange(generation: number): { startTurn: number; endTurn: number } | null {
    const played = this.playedByGeneration.get(generation) ?? 0;
    return played > 0 ? { startTurn: 0, endTurn: played - 1 } : null;
  }
}
