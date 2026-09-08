/**
 * Provider 健康服务（§17 每个 Provider 独立超时/重试/熔断；§16 用量；脱敏诊断）。
 *
 * 熔断器三态：closed（正常）→ open（连续失败超阈值，拒绝请求，等待冷却）→ half-open
 * （冷却后允许一次试探；成功则 closed，失败则重新 open）。三个阶段（asr/llm/tts）各自独立熔断，
 * 一个 Provider 故障不拖垮另两个。
 *
 * 用量采集：每个阶段记录请求数、失败数、最近诊断 ID（不含密钥/原始响应）。
 * 诊断快照只暴露计数与归一化 ID，不暴露 Provider 原始响应或凭据（§17 脱敏）。
 *
 * 连接测试：用最小请求验证端点可达；真接入在 Gate 1 受控验收时启用，自动化测试只覆盖 Mock。
 */

export type VoiceStage = "asr" | "llm" | "tts";
export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenMaxAttempts: number;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  halfOpenMaxAttempts: 1,
};

export interface UsageCounters {
  attempts: number;
  failures: number;
  lastDiagnosticId?: string;
}

export interface HealthSnapshot {
  stage: VoiceStage;
  state: CircuitState;
  usage: UsageCounters;
}

/**
 * 单阶段熔断器。纯状态机，无定时器副作用：open→half-open 的转换由调用方在 canAttempt
 * 时按冷却时间判定（nowMs 由调用方注入，便于 fake timers 驱动测试）。
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAtMs: number | null = null;
  private halfOpenAttempts = 0;

  constructor(
    readonly stage: VoiceStage,
    private readonly config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
  ) {}

  /** 是否允许尝试。open 态在冷却后转为 half-open 并允许一次试探。 */
  canAttempt(nowMs: number): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (this.openedAtMs !== null && nowMs - this.openedAtMs >= this.config.cooldownMs) {
        this.state = "half-open";
        this.halfOpenAttempts = 0;
        return true;
      }
      return false;
    }
    // half-open：允许有限次试探。
    return this.halfOpenAttempts < this.config.halfOpenMaxAttempts;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAtMs = null;
    this.halfOpenAttempts = 0;
    this.state = "closed";
  }

  recordFailure(nowMs: number, diagnosticId?: string): void {
    this.consecutiveFailures += 1;
    this.lastDiagnosticId = diagnosticId;
    if (this.state === "half-open") {
      // 试探失败：重新开路。
      this.state = "open";
      this.openedAtMs = nowMs;
      return;
    }
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.state = "open";
      this.openedAtMs = nowMs;
    }
  }

  /** half-open 态记一次尝试（canAttempt 成功后调用）。 */
  noteHalfOpenAttempt(): void {
    if (this.state === "half-open") {
      this.halfOpenAttempts += 1;
    }
  }

  get currentState(): CircuitState {
    return this.state;
  }

  lastDiagnosticId?: string;
}

/**
 * 三阶段独立健康服务。连接测试与真接入在 Gate 1 受控验收；自动化测试只覆盖熔断与用量状态机。
 */
export class VoiceProviderHealthService {
  private readonly breakers: Record<VoiceStage, CircuitBreaker>;
  private readonly usage: Record<VoiceStage, UsageCounters>;

  constructor(config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG) {
    this.breakers = {
      asr: new CircuitBreaker("asr", config),
      llm: new CircuitBreaker("llm", config),
      tts: new CircuitBreaker("tts", config),
    };
    this.usage = {
      asr: { attempts: 0, failures: 0 },
      llm: { attempts: 0, failures: 0 },
      tts: { attempts: 0, failures: 0 },
    };
  }

  canAttempt(stage: VoiceStage, nowMs: number): boolean {
    const ok = this.breakers[stage].canAttempt(nowMs);
    if (ok && this.breakers[stage].currentState === "half-open") {
      this.breakers[stage].noteHalfOpenAttempt();
    }
    return ok;
  }

  recordSuccess(stage: VoiceStage): void {
    this.usage[stage].attempts += 1;
    this.breakers[stage].recordSuccess();
  }

  recordFailure(stage: VoiceStage, nowMs: number, diagnosticId?: string): void {
    this.usage[stage].attempts += 1;
    this.usage[stage].failures += 1;
    if (diagnosticId) this.usage[stage].lastDiagnosticId = diagnosticId;
    this.breakers[stage].recordFailure(nowMs, diagnosticId);
  }

  /** 脱敏快照：只含计数与归一化 ID，不含 Provider 原始响应或凭据。 */
  snapshot(stage: VoiceStage): HealthSnapshot {
    return {
      stage,
      state: this.breakers[stage].currentState,
      usage: { ...this.usage[stage] },
    };
  }

  /** 全阶段快照（用于结束页成本与可用性展示）。 */
  snapshotAll(): HealthSnapshot[] {
    return [this.snapshot("asr"), this.snapshot("llm"), this.snapshot("tts")];
  }
}

export interface ConnectionTestResult {
  ok: boolean;
  diagnosticId?: string;
}

/**
 * 连接测试 + 重试 + 熔断骨架（§12.2 连接测试、§17 重试/熔断）。
 *
 * 先过熔断器；熔断 open 时直接返回 not-ok。否则尝试一次，失败且 retryable 时按
 * maxRetries 重试（线性退避，nowMs 由调用方注入，便于 fake timers）。结果回写健康服务。
 *
 * 真接入在 Gate 1 受控验收；自动化测试用 Mock attempt 函数覆盖成功/重试/熔断路径。
 */
export const testProviderConnection = async (params: {
  health: VoiceProviderHealthService;
  stage: VoiceStage;
  nowMs: number;
  attempt: () => Promise<{ ok: boolean; retryable?: boolean; diagnosticId?: string }>;
  maxRetries?: number;
  backoffMs?: number;
}): Promise<ConnectionTestResult> => {
  const { health, stage, nowMs, attempt } = params;
  const maxRetries = params.maxRetries ?? 2;
  const backoffMs = params.backoffMs ?? 500;

  if (!health.canAttempt(stage, nowMs)) {
    return { ok: false };
  }

  let clock = nowMs;
  for (let attemptNumber = 0; attemptNumber <= maxRetries; attemptNumber += 1) {
    try {
      const result = await attempt();
      if (result.ok) {
        health.recordSuccess(stage);
        return { ok: true, diagnosticId: result.diagnosticId };
      }
      health.recordFailure(stage, clock, result.diagnosticId);
      if (!result.retryable || attemptNumber === maxRetries) {
        return { ok: false, diagnosticId: result.diagnosticId };
      }
      clock += backoffMs;
    } catch (error) {
      health.recordFailure(stage, clock);
      if (attemptNumber === maxRetries) {
        return { ok: false };
      }
      clock += backoffMs;
    }
  }
  return { ok: false };
};
