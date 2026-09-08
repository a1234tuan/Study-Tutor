/**
 * 协议无关流式 Provider adapter 契约（§13.1、§12.2）。
 *
 * 上层只消费 VoiceStreamEvent，不感知底层是 SSE、WebSocket、HTTP chunked stream 还是原生 SDK。
 * 不得把 SSE/WebSocket 写进领域 orchestrator。具体 adapter（DeepSeek SSE、豆包 WS、Fish Audio）
 * 在 Phase 2 实现；Phase 0 只交付契约 + Mock adapter（见 mockProvider.ts）。
 *
 * 分层取消（§13.2）：会话级 controller 结束整场会话；活动轮次级打断当前 ASR/LLM/TTS 链；
 * 每个 Provider 请求有独立 controller，并与上级 signal 关联。播放队列使用递增 generation/token，
 * 只有当前 generation 的异步结果可以入队。
 */

import type { AbortScope, VoiceAudioFormat } from "./domain";

/** 采集层输出的规范音频帧（§8.3）。带 sequence、单调时钟时间戳和格式描述。 */
export interface VoiceAudioFrame {
  sequence: number;
  /** 单调时钟时间戳（ms）。不得使用挂钟时间，避免系统时钟跳变破坏端点判定。 */
  timestampMs: number;
  format: VoiceAudioFormat;
  sampleRate: number;
  channels: number;
  /** 16-bit PCM 时为 Int16Array；其它格式为底层字节。Phase 0 Mock 产生静音帧。 */
  samples: Int16Array | Uint8Array;
}

/** LLM token delta 流（§13.1）。DeepSeek SSE 在 Phase 2 真接入。 */
export interface VoiceLlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface VoiceLlmRequestOptions {
  messages: VoiceLlmMessage[];
  /** 口语化教学 Prompt（§11.1）：避免长列表/Markdown 表格/连续术语堆叠。 */
  systemPromptOverride?: string;
  temperature?: number;
  maxTokens?: number;
  thinkingMode?: "enabled" | "disabled";
}

export interface VoiceTtsRequestOptions {
  text: string;
  voiceId?: string;
  speed?: number;
}

/** Provider 归一化错误（§17）。原始异常必须经 uiError.ts，不直接展示 Provider 响应或密钥。 */
export interface VoiceProviderError {
  /** 归一化阶段：asr / llm / tts / capture / playback / network。 */
  stage: "asr" | "llm" | "tts" | "capture" | "playback" | "network";
  /** 不含密钥或 Provider 原始响应的归一化消息。 */
  message: string;
  /** 是否可重试（§17：每个 Provider 独立超时、最大重试和熔断）。 */
  retryable: boolean;
  /** 脱敏诊断 ID，对应 uiError.ts 的 diagnosticId。 */
  diagnosticId?: string;
  cause?: unknown;
}

/** 上层消费的异步事件（§13.1）。 */
export type VoiceStreamEvent =
  | { type: "asr-partial"; text: string; sequence: number }
  | { type: "asr-final"; text: string; sequence: number }
  | { type: "llm-token"; text: string }
  | { type: "llm-completed"; fullText: string }
  | { type: "tts-audio"; frame: VoiceAudioFrame; generation: number }
  | { type: "tts-completed"; generation: number }
  | { type: "error"; error: VoiceProviderError }
  | { type: "provider-completed"; stage: "asr" | "llm" | "tts" };

/**
 * 事件汇。Adapter 通过 emit 推送事件，运行态通过 async iterator 消费。
 * 容量受限：未消费的事件缓冲超限时丢弃旧的 partial/token（partial 只用于屏幕预览，§9 第 1 条）。
 */
export interface VoiceStreamEmitter {
  emit(event: VoiceStreamEvent): void;
  onAbort(handler: (scope: AbortScope) => void): void;
  readonly closed: boolean;
  close(): void;
  /** 运行态通过 for-await-of 消费事件。close() 后迭代终止。 */
  [Symbol.asyncIterator](): AsyncGenerator<VoiceStreamEvent, void, unknown>;
}

export interface VoiceStreamEmitOptions {
  emitter: VoiceStreamEmitter;
  signal: AbortSignal;
}

/** ASR 流式 adapter 契约。 */
export interface AsrStreamAdapter {
  readonly stage: "asr";
  stream(options: VoiceStreamEmitOptions & { audioInput: AsyncIterable<VoiceAudioFrame> }): Promise<void>;
}

/** LLM 流式 adapter 契约。保留原非流式 aiClientService 接口供结构化评估使用（§13.1）。 */
export interface LlmStreamAdapter {
  readonly stage: "llm";
  stream(options: VoiceStreamEmitOptions & VoiceLlmRequestOptions): Promise<void>;
}

/** TTS 流式 adapter 契约。低延迟流式队列，不复用整段播客合成流程（§22）。 */
export interface TtsStreamAdapter {
  readonly stage: "tts";
  /** generation 由运行态注入，标注 tts-audio/tts-completed，使旧代次结果可被丢弃（§13.2）。 */
  stream(options: VoiceStreamEmitOptions & VoiceTtsRequestOptions & { generation: number }): Promise<void>;
}

/** 播放代次（§13.2）。递增；只有当前 generation 的异步结果可以入队。 */
export interface PlaybackGeneration {
  readonly generation: number;
  /** 使该代次作废；晚到的旧 generation 结果必须被丢弃。 */
  invalidate(): void;
  readonly valid: boolean;
}

export interface PlaybackGenerationFactory {
  next(): PlaybackGeneration;
  /** 当前有效代次（用于 adapter 标注 tts-audio/tts-completed）。 */
  current(): PlaybackGeneration;
  invalidateAll(): void;
}

/** 分层取消（§13.2）：会话/活动轮次/单请求，下级与上级 signal 关联。 */
export interface LayeredAbortController {
  readonly scope: AbortScope;
  readonly signal: AbortSignal;
  /** 创建下级 controller，其 abort 会随上级 abort 而触发。 */
  derive(scope: AbortScope): LayeredAbortController;
  abort(reason?: unknown): void;
  /** 清理派生关系，避免泄漏。 */
  dispose(): void;
}
