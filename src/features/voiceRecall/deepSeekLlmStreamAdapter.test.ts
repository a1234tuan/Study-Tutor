import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekLlmStreamAdapter } from "./deepSeekLlmStreamAdapter";
import { VoiceStreamEmitterImpl } from "./runtime";
import type { AiProviderProfile } from "../../types";
import type { VoiceStreamEvent } from "./providerContracts";

const DEEPSEEK_PROFILE: AiProviderProfile = {
  id: "default",
  providerName: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  temperature: 0.7,
  maxTokens: 256,
  contextWindowTokens: 65_536,
  memoryTurns: 12,
  builtIn: "deepseek",
};

/** 构造一个 Mock fetch，返回给定 SSE 文本切片序列。 */
const makeSseFetch = (chunks: string[], init: { status?: number; contentType?: string } = {}) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return vi.fn(async () =>
    new Response(init.status && init.status !== 200 ? null : stream, {
      status: init.status ?? 200,
      headers: { "content-type": init.contentType ?? "text/event-stream" },
    }),
  );
};

const drain = async (emitter: VoiceStreamEmitterImpl): Promise<VoiceStreamEvent[]> => {
  const events: VoiceStreamEvent[] = [];
  for await (const event of emitter) {
    events.push(event);
  }
  return events;
};

const noopController = () => new AbortController();

describe("DeepSeekLlmStreamAdapter (§13.1, Gate 1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses SSE delta tokens and emits llm-token + llm-completed with full text", async () => {
    const fetchImpl = makeSseFetch([
      'data: {"choices":[{"delta":{"content":"比例"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"原则"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"要求"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const adapter = new DeepSeekLlmStreamAdapter({
      provider: DEEPSEEK_PROFILE,
      apiKey: "test-key-fixture",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const emitter = new VoiceStreamEmitterImpl();
    const controller = noopController();

    const streamPromise = adapter.stream({
      emitter,
      signal: controller.signal,
      messages: [{ role: "user", content: "讲比例原则" }],
    });
    const drainPromise = drain(emitter);
    await streamPromise;
    emitter.close();
    const events = await drainPromise;

    const tokens = events.filter((e) => e.type === "llm-token").map((e) => (e as { type: "llm-token"; text: string }).text);
    expect(tokens).toEqual(["比例", "原则", "要求"]);
    const completed = events.find((e) => e.type === "llm-completed") as { type: "llm-completed"; fullText: string };
    expect(completed.fullText).toBe("比例原则要求");
    expect(events.some((e) => e.type === "provider-completed")).toBe(true);
    // 请求体携带 stream:true 与 Bearer。
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.stream).toBe(true);
    expect(body.model).toBe("deepseek-v4-flash");
    expect(call[1].headers).toMatchObject({
      Authorization: "Bearer test-key-fixture",
    });
  });

  it("handles chunk boundaries that split a data line (reassembles into one delta)", async () => {
    const fetchImpl = makeSseFetch([
      'data: {"choices":[{"delta":{"content":"比例',
      '原则"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const adapter = new DeepSeekLlmStreamAdapter({
      provider: DEEPSEEK_PROFILE,
      apiKey: "test-key-fixture",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const emitter = new VoiceStreamEmitterImpl();
    await adapter.stream({
      emitter,
      signal: noopController().signal,
      messages: [{ role: "user", content: "讲比例原则" }],
    });
    emitter.close();
    const events = await drain(emitter);
    const tokens = events.filter((e) => e.type === "llm-token").map((e) => (e as { text: string }).text);
    // 跨 chunk 的 data 行被重组为一条 delta，token 不被字节边界截断。
    expect(tokens).toEqual(["比例原则"]);
  });

  it("emits a desensitized error when apiKey is missing (no key in message)", async () => {
    const adapter = new DeepSeekLlmStreamAdapter({
      provider: DEEPSEEK_PROFILE,
      apiKey: "",
      fetchImpl: makeSseFetch([]) as unknown as typeof fetch,
    });
    const emitter = new VoiceStreamEmitterImpl();
    await adapter.stream({
      emitter,
      signal: noopController().signal,
      messages: [{ role: "user", content: "x" }],
    });
    emitter.close();
    const events = await drain(emitter);
    const error = events.find((e) => e.type === "error") as {
      type: "error";
      error: { stage: string; message: string; retryable: boolean; diagnosticId?: string };
    };
    expect(error).toBeDefined();
    expect(error.error.stage).toBe("llm");
    expect(error.error.retryable).toBe(false);
    expect(error.error.diagnosticId).toMatch(/^VR-/);
    // 密钥与原始响应不得出现在错误消息。
    expect(error.error.message).not.toContain("test-key");
  });

  it("emits a retryable network error on non-200 response without leaking provider body", async () => {
    const fetchImpl = makeSseFetch([], { status: 500, contentType: "application/json" });
    const adapter = new DeepSeekLlmStreamAdapter({
      provider: DEEPSEEK_PROFILE,
      apiKey: "test-key-fixture",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const emitter = new VoiceStreamEmitterImpl();
    await adapter.stream({
      emitter,
      signal: noopController().signal,
      messages: [{ role: "user", content: "x" }],
    });
    emitter.close();
    const events = await drain(emitter);
    const error = events.find((e) => e.type === "error") as {
      type: "error";
      error: { stage: string; message: string; retryable: boolean };
    };
    expect(error.error.stage).toBe("network");
    expect(error.error.retryable).toBe(true);
    expect(error.error.message).toContain("500");
  });

  it("aborts silently when the turn signal fires (no error emitted)", async () => {
    // 返回一个永不自行结束的流。
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // 不 close，模拟持续流。
      },
    });
    const fetchImpl = vi.fn(async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const adapter = new DeepSeekLlmStreamAdapter({
      provider: DEEPSEEK_PROFILE,
      apiKey: "test-key-fixture",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const emitter = new VoiceStreamEmitterImpl();
    const controller = new AbortController();
    const streamPromise = adapter.stream({
      emitter,
      signal: controller.signal,
      messages: [{ role: "user", content: "x" }],
    });
    controller.abort();
    await streamPromise;
    emitter.close();
    const events = await drain(emitter);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("emits a timeout error when timeoutMs elapses without response", async () => {
    vi.useFakeTimers();
    // 永不自行 resolve；监听 signal，被超时 controller abort 后拒绝。
    const fetchImpl = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
    );
    const adapter = new DeepSeekLlmStreamAdapter({
      provider: DEEPSEEK_PROFILE,
      apiKey: "test-key-fixture",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
    });
    const emitter = new VoiceStreamEmitterImpl();
    const streamPromise = adapter.stream({
      emitter,
      signal: noopController().signal,
      messages: [{ role: "user", content: "x" }],
    });
    await vi.advanceTimersByTimeAsync(1100);
    await streamPromise;
    emitter.close();
    const events = await drain(emitter);
    const error = events.find((e) => e.type === "error") as {
      type: "error";
      error: { stage: string; message: string; retryable: boolean };
    };
    expect(error.error.stage).toBe("network");
    expect(error.error.retryable).toBe(true);
    expect(error.error.message).toContain("超时");
  });
});
