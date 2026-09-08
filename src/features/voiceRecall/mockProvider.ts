/**
 * 确定性 Mock Provider（§12.3、§18 阶段 0）。
 *
 * 开源仓库、自动化测试和预览只使用确定性 Mock Provider。真实 Provider（豆包 ASR、
 * DeepSeek 流式 LLM、Fish Audio TTS）在 Phase 2 接入；本文件只提供契约实现 + 场景注入，
 * 不接触任何真实凭据或网络。
 *
 * 时序通过 injectable scheduler 与 clock 控制，便于 Vitest fake timers 驱动。
 * 不使用 Math.random：确定性意味着同一输入产生同一事件序列。
 */

import type { VoiceAudioFrame, VoiceLlmRequestOptions, VoiceTtsRequestOptions } from "./providerContracts";
import type {
  AsrStreamAdapter,
  LlmStreamAdapter,
  TtsStreamAdapter,
  VoiceStreamEmitOptions,
} from "./providerContracts";

const SILENCE_SAMPLE_COUNT = 160; // 16kHz / 100ms

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const id = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      globalThis.clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export interface VoiceMockScenario {
  /** 在第 N 个事件后注入错误（0=不注入）。 */
  errorAfter?: number;
  /** 在第 N 个事件后模拟断线。 */
  disconnectAfter?: number;
  /** 每个 token/partial 之间的间隔（ms）。 */
  stepMs?: number;
}

const DEFAULT_STEP_MS = 40;

const shouldFail = (scenario: VoiceMockScenario | undefined, emitted: number): "error" | "disconnect" | null => {
  if (scenario?.disconnectAfter && emitted >= scenario.disconnectAfter) return "disconnect";
  if (scenario?.errorAfter && emitted >= scenario.errorAfter) return "error";
  return null;
};

/** 固定 ASR 语料：把整句切成 partial，最后发 final。 */
const ASR_SENTENCE = "比例原则要求行政行为符合目的性、必要性以及均衡性";

const buildAsrPartials = (): string[] => {
  const words = ASR_SENTENCE.split("，").flatMap((segment) => segment.split(/(?=[，])/u));
  const partials: string[] = [];
  let acc = "";
  for (const word of words) {
    acc += word;
    partials.push(acc);
  }
  partials.push(ASR_SENTENCE);
  return partials;
};

const buildSilenceFrame = (sequence: number, timestampMs: number): VoiceAudioFrame => ({
  sequence,
  timestampMs,
  format: "pcm-s16le",
  sampleRate: 16000,
  channels: 1,
  samples: new Int16Array(SILENCE_SAMPLE_COUNT), // 全 0 = 静音
});

/** Mock ASR adapter：从 audioInput 读取帧（忽略内容），发固定 partial→final。 */
export class MockAsrStreamAdapter implements AsrStreamAdapter {
  readonly stage = "asr" as const;
  constructor(private readonly scenario?: VoiceMockScenario) {}

  async stream(options: VoiceStreamEmitOptions & { audioInput: AsyncIterable<VoiceAudioFrame> }): Promise<void> {
    const { emitter, signal, audioInput } = options;
    const stepMs = this.scenario?.stepMs ?? DEFAULT_STEP_MS;
    const partials = buildAsrPartials();
    let emitted = 0;
    for await (const _frame of audioInput) {
      if (signal.aborted) return;
      const failure = shouldFail(this.scenario, emitted);
      if (failure === "disconnect") {
        emitter.emit({ type: "error", error: { stage: "asr", message: "ASR 连接已断开，正在重连。", retryable: true } });
        return;
      }
      if (failure === "error") {
        emitter.emit({ type: "error", error: { stage: "asr", message: "ASR 暂时不可用，可切换为键盘回答。", retryable: true } });
        return;
      }
      const partial = partials[Math.min(emitted, partials.length - 1)];
      emitter.emit({ type: "asr-partial", text: partial, sequence: emitted });
      emitted += 1;
      await sleep(stepMs, signal);
    }
    emitter.emit({ type: "asr-final", text: ASR_SENTENCE, sequence: emitted });
    emitter.emit({ type: "provider-completed", stage: "asr" });
  }
}

const LLM_TOKENS = ["比例原则", "包含", "目的性", "、", "必要性", "与", "均衡性", "。", "其中", "必要性", "要求", "最小侵害", "。"];

/** Mock LLM adapter：发固定 token 序列，最后 completed。 */
export class MockLlmStreamAdapter implements LlmStreamAdapter {
  readonly stage = "llm" as const;
  constructor(private readonly scenario?: VoiceMockScenario) {}

  async stream(options: VoiceStreamEmitOptions & VoiceLlmRequestOptions): Promise<void> {
    const { emitter, signal } = options;
    const stepMs = this.scenario?.stepMs ?? DEFAULT_STEP_MS;
    let full = "";
    for (let i = 0; i < LLM_TOKENS.length; i += 1) {
      if (signal.aborted) return;
      const failure = shouldFail(this.scenario, i);
      if (failure === "disconnect") {
        emitter.emit({ type: "error", error: { stage: "llm", message: "LLM 连接已断开，正在重连。", retryable: true } });
        return;
      }
      if (failure === "error") {
        emitter.emit({ type: "error", error: { stage: "llm", message: "LLM 暂时不可用，已保留转写，可稍后重试。", retryable: false } });
        return;
      }
      const token = LLM_TOKENS[i];
      full += token;
      emitter.emit({ type: "llm-token", text: token });
      await sleep(stepMs, signal);
    }
    emitter.emit({ type: "llm-completed", fullText: full });
    emitter.emit({ type: "provider-completed", stage: "llm" });
  }
}

/** Mock TTS adapter：发静音音频帧，最后 completed，带 generation 标注。 */
export class MockTtsStreamAdapter implements TtsStreamAdapter {
  readonly stage = "tts" as const;
  constructor(private readonly scenario?: VoiceMockScenario) {}

  async stream(options: VoiceStreamEmitOptions & VoiceTtsRequestOptions & { generation: number }): Promise<void> {
    const { emitter, signal, generation } = options;
    const stepMs = this.scenario?.stepMs ?? DEFAULT_STEP_MS;
    const frameCount = 12;
    for (let i = 0; i < frameCount; i += 1) {
      if (signal.aborted) return;
      const failure = shouldFail(this.scenario, i);
      if (failure) {
        emitter.emit({ type: "error", error: { stage: "tts", message: "TTS 暂时不可用，展示文字回答。", retryable: true } });
        return;
      }
      emitter.emit({ type: "tts-audio", frame: buildSilenceFrame(i, i * stepMs), generation });
      await sleep(stepMs, signal);
    }
    emitter.emit({ type: "tts-completed", generation });
    emitter.emit({ type: "provider-completed", stage: "tts" });
  }
}

export const buildMockAsrAdapter = (scenario?: VoiceMockScenario): AsrStreamAdapter => new MockAsrStreamAdapter(scenario);
export const buildMockLlmAdapter = (scenario?: VoiceMockScenario): LlmStreamAdapter => new MockLlmStreamAdapter(scenario);
export const buildMockTtsAdapter = (scenario?: VoiceMockScenario): TtsStreamAdapter => new MockTtsStreamAdapter(scenario);
