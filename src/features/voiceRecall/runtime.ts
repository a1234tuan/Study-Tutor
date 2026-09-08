/**
 * 语音运行态基础设施（Phase 0 最小实现，Phase 1 扩展）。
 *
 * VoiceStreamEmitter：Adapter push 事件，运行态 async iterator 消费。
 * LayeredAbortController：会话/活动轮次/单请求分层取消（§13.2）。
 * PlaybackGenerationFactory：递增播放代次；旧 generation 结果必须被丢弃（§13.2）。
 *
 * 注意：Phase 0 仅提供可被 Mock 与原型驱动的最小实现；真实音频采集、WebSocket 生命周期、
 * 抖动缓冲在 Phase 1 落地。
 */

import type { AbortScope } from "./domain";
import type { VoiceStreamEvent } from "./providerContracts";
import type {
  LayeredAbortController,
  PlaybackGeneration,
  PlaybackGenerationFactory,
  VoiceStreamEmitter,
} from "./providerContracts";

const MAX_PARTIAL_BUFFER = 64;

export class VoiceStreamEmitterImpl implements VoiceStreamEmitter {
  private readonly queue: VoiceStreamEvent[] = [];
  private readonly waiters: Array<(event: VoiceStreamEvent | null) => void> = [];
  private readonly abortHandlers: Array<(scope: AbortScope) => void> = [];
  private closedState = false;

  emit(event: VoiceStreamEvent): void {
    if (this.closedState) return;
    // partial/token 是可丢弃的预览事件（§9 第 1 条）。缓冲超限时丢旧的，保留 final/completed/error。
    if (event.type === "asr-partial" || event.type === "llm-token") {
      const discardableCount = this.queue.filter(
        (item) => item.type === "asr-partial" || item.type === "llm-token",
      ).length;
      if (discardableCount >= MAX_PARTIAL_BUFFER) {
        const firstPartialIndex = this.queue.findIndex(
          (item) => item.type === "asr-partial" || item.type === "llm-token",
        );
        if (firstPartialIndex >= 0) this.queue.splice(firstPartialIndex, 1);
      }
    }
    this.queue.push(event);
    this.drain();
  }

  onAbort(handler: (scope: AbortScope) => void): void {
    this.abortHandlers.push(handler);
  }

  notifyAbort(scope: AbortScope): void {
    for (const handler of [...this.abortHandlers]) {
      try {
        handler(scope);
      } catch {
        // 防止单个 handler 抛出阻断其它取消逻辑。
      }
    }
  }

  get closed(): boolean {
    return this.closedState;
  }

  close(): void {
    this.closedState = true;
    for (const waiter of [...this.waiters]) {
      waiter(null);
    }
    this.waiters.length = 0;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<VoiceStreamEvent, void, unknown> {
    while (true) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closedState) return;
      const event = await new Promise<VoiceStreamEvent | null>((resolve) => {
        this.waiters.push(resolve);
      });
      if (event) yield event;
      else return;
    }
  }

  private drain(): void {
    while (this.queue.length > 0 && this.waiters.length > 0) {
      const event = this.queue.shift();
      const waiter = this.waiters.shift();
      if (event && waiter) waiter(event);
    }
  }
}

export class LayeredAbortControllerImpl implements LayeredAbortController {
  private readonly controller = new AbortController();
  private readonly children: LayeredAbortControllerImpl[] = [];
  private disposed = false;

  constructor(
    readonly scope: AbortScope,
    private readonly parent?: LayeredAbortControllerImpl,
  ) {
    if (parent) {
      parent.controller.signal.addEventListener("abort", () => this.abort(parent.signal.reason), {
        once: true,
      });
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  derive(scope: AbortScope): LayeredAbortController {
    const child = new LayeredAbortControllerImpl(scope, this);
    this.children.push(child);
    return child;
  }

  abort(reason?: unknown): void {
    if (this.disposed) return;
    this.controller.abort(reason);
  }

  dispose(): void {
    this.disposed = true;
    for (const child of [...this.children]) {
      child.dispose();
    }
    this.children.length = 0;
  }
}

class PlaybackGenerationImpl implements PlaybackGeneration {
  private validState = true;
  constructor(readonly generation: number, private readonly onInvalidate: () => void) {}
  invalidate(): void {
    this.validState = false;
    this.onInvalidate();
  }
  get valid(): boolean {
    return this.validState;
  }
}

export class PlaybackGenerationFactoryImpl implements PlaybackGenerationFactory {
  private counter = 0;
  private readonly invalidations = new Set<number>();
  private currentGeneration: PlaybackGenerationImpl | null = null;

  next(): PlaybackGeneration {
    this.counter += 1;
    const generation = this.counter;
    const impl = new PlaybackGenerationImpl(generation, () => this.invalidations.add(generation));
    this.currentGeneration = impl;
    return impl;
  }

  current(): PlaybackGeneration {
    return this.currentGeneration ?? this.next();
  }

  invalidateAll(): void {
    this.currentGeneration?.invalidate();
    this.currentGeneration = null;
  }

  isGenerationValid(generation: number): boolean {
    return !this.invalidations.has(generation) && generation === this.counter;
  }
}
