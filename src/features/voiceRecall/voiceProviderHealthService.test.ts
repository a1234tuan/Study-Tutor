import { describe, expect, it } from "vitest";
import {
  CircuitBreaker,
  DEFAULT_CIRCUIT_CONFIG,
  testProviderConnection,
  VoiceProviderHealthService,
} from "./voiceProviderHealthService";

describe("CircuitBreaker (§17 per-provider)", () => {
  it("stays closed below the failure threshold", () => {
    const breaker = new CircuitBreaker("llm", { ...DEFAULT_CIRCUIT_CONFIG, failureThreshold: 3 });
    expect(breaker.canAttempt(0)).toBe(true);
    breaker.recordFailure(0);
    breaker.recordFailure(1);
    expect(breaker.currentState).toBe("closed");
    expect(breaker.canAttempt(2)).toBe(true);
  });

  it("opens after the failure threshold and blocks attempts until cooldown", () => {
    const breaker = new CircuitBreaker("llm", {
      failureThreshold: 2,
      cooldownMs: 1000,
      halfOpenMaxAttempts: 1,
    });
    breaker.recordFailure(0);
    breaker.recordFailure(1);
    expect(breaker.currentState).toBe("open");
    // 冷却未到：拒绝。
    expect(breaker.canAttempt(500)).toBe(false);
    // 冷却到达：转为 half-open，允许一次试探。
    expect(breaker.canAttempt(1001)).toBe(true);
    expect(breaker.currentState).toBe("half-open");
  });

  it("closes after a successful half-open probe", () => {
    const breaker = new CircuitBreaker("tts", {
      failureThreshold: 1,
      cooldownMs: 500,
      halfOpenMaxAttempts: 1,
    });
    breaker.recordFailure(0);
    expect(breaker.currentState).toBe("open");
    expect(breaker.canAttempt(501)).toBe(true);
    breaker.recordSuccess();
    expect(breaker.currentState).toBe("closed");
  });

  it("reopens after a failed half-open probe", () => {
    const breaker = new CircuitBreaker("asr", {
      failureThreshold: 1,
      cooldownMs: 500,
      halfOpenMaxAttempts: 1,
    });
    breaker.recordFailure(0);
    expect(breaker.canAttempt(501)).toBe(true); // half-open
    breaker.recordFailure(502, "ASR-001");
    expect(breaker.currentState).toBe("open");
    expect(breaker.lastDiagnosticId).toBe("ASR-001");
  });
});

describe("VoiceProviderHealthService (§17 independent breakers + §16 usage)", () => {
  it("keeps ASR/LLM/TTS breakers independent — one failing does not block the others", () => {
    const service = new VoiceProviderHealthService({
      failureThreshold: 1,
      cooldownMs: 1000,
      halfOpenMaxAttempts: 1,
    });
    service.recordFailure("asr", 0, "ASR-ERR");
    // ASR 开路，但 LLM/TTS 仍可用。
    expect(service.canAttempt("asr", 10)).toBe(false);
    expect(service.canAttempt("llm", 10)).toBe(true);
    expect(service.canAttempt("tts", 10)).toBe(true);
  });

  it("usage snapshot is desensitized — counts and diagnostic ID only, no raw response or key", () => {
    const service = new VoiceProviderHealthService(DEFAULT_CIRCUIT_CONFIG);
    service.recordSuccess("llm");
    service.recordFailure("llm", 0, "VR-AB123");
    const snap = service.snapshot("llm");
    expect(snap.usage.attempts).toBe(2);
    expect(snap.usage.failures).toBe(1);
    expect(snap.usage.lastDiagnosticId).toBe("VR-AB123");
    // 快照不暴露 Provider 原始响应或凭据字段。
    expect(JSON.stringify(snap)).not.toContain("apiKey");
    expect(JSON.stringify(snap)).not.toContain("Authorization");
  });

  it("snapshotAll returns all three stages", () => {
    const service = new VoiceProviderHealthService(DEFAULT_CIRCUIT_CONFIG);
    const all = service.snapshotAll();
    expect(all.map((s) => s.stage)).toEqual(["asr", "llm", "tts"]);
  });
});

describe("testProviderConnection (§12.2 connection test + §17 retry/breaker)", () => {
  it("returns ok on first success and records success", () => {
    const service = new VoiceProviderHealthService(DEFAULT_CIRCUIT_CONFIG);
    const result = testProviderConnection({
      health: service,
      stage: "llm",
      nowMs: 0,
      attempt: async () => ({ ok: true }),
    });
    return result.then((r) => {
      expect(r).toEqual({ ok: true });
      expect(service.snapshot("llm").usage.attempts).toBe(1);
      expect(service.snapshot("llm").state).toBe("closed");
    });
  });

  it("retries on retryable failure then succeeds", () => {
    const service = new VoiceProviderHealthService(DEFAULT_CIRCUIT_CONFIG);
    let calls = 0;
    return testProviderConnection({
      health: service,
      stage: "llm",
      nowMs: 0,
      maxRetries: 2,
      backoffMs: 100,
      attempt: async () => {
        calls += 1;
        return calls < 2 ? { ok: false, retryable: true, diagnosticId: "VR-001" } : { ok: true };
      },
    }).then((r) => {
      expect(r.ok).toBe(true);
      expect(calls).toBe(2);
    });
  });

  it("gives up after maxRetries and records failures", () => {
    const service = new VoiceProviderHealthService(DEFAULT_CIRCUIT_CONFIG);
    return testProviderConnection({
      health: service,
      stage: "asr",
      nowMs: 0,
      maxRetries: 1,
      backoffMs: 0,
      attempt: async () => ({ ok: false, retryable: true, diagnosticId: "ASR-1" }),
    }).then((r) => {
      expect(r.ok).toBe(false);
      expect(r.diagnosticId).toBe("ASR-1");
      expect(service.snapshot("asr").usage.failures).toBe(2);
    });
  });

  it("is blocked when the breaker is open", () => {
    const service = new VoiceProviderHealthService({
      failureThreshold: 1,
      cooldownMs: 10_000,
      halfOpenMaxAttempts: 1,
    });
    service.recordFailure("tts", 0);
    return testProviderConnection({
      health: service,
      stage: "tts",
      nowMs: 100,
      attempt: async () => ({ ok: true }),
    }).then((r) => {
      // 熔断 open：直接拒绝，不调用 attempt。
      expect(r.ok).toBe(false);
    });
  });
});
