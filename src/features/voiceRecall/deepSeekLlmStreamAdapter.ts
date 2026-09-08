/**
 * DeepSeek 流式 LLM adapter（§13.1、Gate 1 真接入）。
 *
 * 复用 src/lib/aiProviders.ts 的 DeepSeek profile 与 src/services/aiClientService.ts 的
 * URL 归一化逻辑；本 adapter 只新增"流式"路径（stream:true SSE），保留原非流式
 * sendChatCompletion/sendChatCompletionDetailed 不动，供 AI 问答/播客/Coach JSON 调用。
 *
 * 安全约束（AGENTS.md / 设计方案 §17）：
 * - apiKey 在会话建立时由本机密钥引用注入到 adapter 实例，运行期驻留、会话结束丢弃；
 *   不入源码常量、不写日志、不进测试快照、不参与云同步/备份/导出。
 * - 错误经 VoiceProviderError 归一化（stage:"llm"），脱敏诊断 ID 对齐 uiError.ts；
 *   不展示 Provider 原始响应或密钥。
 * - 仓库自动化测试只使用 Mock fetch，不发真实网络请求。真接入仅在显式受控验收时启用。
 */

import { normalizeAiChatCompletionsUrl } from "../../services/aiClientService";
import { normalizeUiError } from "../../lib/uiError";
import type { AiProviderProfile } from "../../types";
import type {
  LlmStreamAdapter,
  VoiceLlmRequestOptions,
  VoiceProviderError,
  VoiceStreamEmitOptions,
} from "./providerContracts";
import { SseLineParser } from "./sseLineParser";

export interface DeepSeekLlmStreamAdapterOptions {
  provider: AiProviderProfile;
  /** 本机密钥引用：会话建立时注入，运行期驻留，会话结束丢弃。不入源码/日志/快照。 */
  apiKey: string;
  /** 测试注入 Mock fetch；默认全局 fetch。真实网络仅在受控验收时启用。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const extractDeltaContent = (payload: string): string | null => {
  if (payload === "[DONE]") return null;
  try {
    const value = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>;
    };
    const delta = value.choices?.[0]?.delta?.content;
    return typeof delta === "string" ? delta : "";
  } catch {
    // 非 JSON 负载（注释/keepalive）忽略，不阻断流。
    return "";
  }
};

const toProviderError = (stage: "llm" | "network", message: string, retryable: boolean): VoiceProviderError => {
  const normalized = normalizeUiError(new Error(message), "voice-recall");
  return { stage, message, retryable, diagnosticId: normalized.diagnosticId };
};

/**
 * DeepSeek 流式 LLM adapter。OpenAI 兼容 SSE：`stream:true`，`data: {choices:[{delta:{content}}]}`，
 * `data: [DONE]`。token delta 即时 emit 供 UI 流式显示与句界缓冲；流结束 emit llm-completed 全文。
 */
export class DeepSeekLlmStreamAdapter implements LlmStreamAdapter {
  readonly stage = "llm" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DeepSeekLlmStreamAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async stream(options: VoiceStreamEmitOptions & VoiceLlmRequestOptions): Promise<void> {
    const { emitter, signal, messages, systemPromptOverride, temperature, maxTokens, thinkingMode } = options;
    const { provider, apiKey, timeoutMs } = this.options;

    if (!apiKey.trim()) {
      emitter.emit({
        type: "error",
        error: toProviderError("llm", "未配置 DeepSeek 密钥，语音复述 LLM 暂不可用。", false),
      });
      return;
    }

    const requestUrl = normalizeAiChatCompletionsUrl(provider.baseUrl);
    const timeoutController = new AbortController();
    let timedOut = false;
    const timeoutId = timeoutMs && timeoutMs > 0
      ? globalThis.setTimeout(() => {
          timedOut = true;
          timeoutController.abort();
        }, timeoutMs)
      : undefined;
    const onCallerAbort = () => timeoutController.abort(signal.reason);
    signal.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const systemMessage = systemPromptOverride
        ? { role: "system" as const, content: systemPromptOverride }
        : undefined;
      const payloadMessages = [systemMessage, ...messages].filter(Boolean) as typeof messages;

      const response = await this.fetchImpl(requestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: provider.model,
          messages: payloadMessages,
          temperature: temperature ?? provider.temperature,
          max_tokens: maxTokens ?? provider.maxTokens,
          stream: true,
          ...(thinkingMode ? { thinking: { type: thinkingMode } } : {}),
        }),
        signal: timeoutController.signal,
      });

      if (!response.ok || !response.body) {
        const message = response.ok
          ? "DeepSeek 流式响应缺少 body，无法继续。"
          : `DeepSeek 流式请求失败（HTTP ${response.status}），请稍后重试。`;
        emitter.emit({ type: "error", error: toProviderError("network", message, true) });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseLineParser();
      let fullText = "";

      while (true) {
        if (signal.aborted) return;
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (const payload of parser.feed(decoder.decode(value, { stream: true }))) {
          if (payload === "[DONE]") {
            emitter.emit({ type: "llm-completed", fullText: fullText });
            emitter.emit({ type: "provider-completed", stage: "llm" });
            return;
          }
          const delta = extractDeltaContent(payload);
          if (delta) {
            fullText += delta;
            emitter.emit({ type: "llm-token", text: delta });
          }
        }
      }
      // 流自然结束但未发 [DONE]：用 flush 取回尾部 data 行并收尾。
      for (const payload of parser.flush()) {
        if (payload === "[DONE]") break;
        const delta = extractDeltaContent(payload);
        if (delta) {
          fullText += delta;
          emitter.emit({ type: "llm-token", text: delta });
        }
      }
      emitter.emit({ type: "llm-completed", fullText: fullText });
      emitter.emit({ type: "provider-completed", stage: "llm" });
    } catch (error) {
      if (signal.aborted && !timedOut) return; // 用户/轮次取消，静默退出。
      if (timedOut) {
        emitter.emit({
          type: "error",
          error: toProviderError("network", "LLM 流式请求超时，已保留转写，可重试。", true),
        });
        return;
      }
      if (error instanceof TypeError) {
        emitter.emit({
          type: "error",
          error: toProviderError("network", "Web 端流式请求失败，可能受 CORS 限制。请在 Android/桌面端使用或配置允许跨域的中转。", true),
        });
        return;
      }
      emitter.emit({
        type: "error",
        error: toProviderError("llm", "LLM 流式响应暂时不可用，已保留转写，可稍后重试。", true),
      });
    } finally {
      if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
      signal.removeEventListener("abort", onCallerAbort);
    }
  }
}
