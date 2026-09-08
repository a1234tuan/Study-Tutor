/**
 * 语音通话成本门控（§16）。
 *
 * 纯函数 + 轻量预算控制器：默认 10min、软上限 20min、80% 提醒、达软上限请求门控（不再开新轮次）。
 * 真实 Provider 估算不可能精确，故结束页/估算标注一律"仅供参考，以 Provider 账单为准"。
 * Provider 级独立超时/重试/熔断见 voiceProviderHealthService.ts；本模块只管会话级时长预算。
 */

export const DEFAULT_MAX_SESSION_MINUTES = 10;
export const SOFT_CAP_MINUTES = 20;
export const REMINDER_PERCENT = 80;

/** 本机估算标注——所有展示位统一用此文案，避免用户误以为估算即账单。 */
export const COST_ESTIMATE_DISCLAIMER = "本机估算仅供参考，以 Provider 账单为准。";

export interface SessionBudgetConfig {
  maxSessionMinutes: number;
  softCapMinutes: number;
  reminderPercent: number;
}

export const DEFAULT_SESSION_BUDGET: SessionBudgetConfig = {
  maxSessionMinutes: DEFAULT_MAX_SESSION_MINUTES,
  softCapMinutes: SOFT_CAP_MINUTES,
  reminderPercent: REMINDER_PERCENT,
};

export interface SessionBudgetStatus {
  elapsedMs: number;
  /** 0–1 的预算进度（相对 maxSessionMinutes）。 */
  progress: number;
  /** 是否到达提醒阈值（默认 80%）。提醒只触发一次。 */
  reminderDue: boolean;
  /** 是否到达软上限——请求门控：不再开始新轮次，但允许当前轮次播完并优雅结束。 */
  softCapReached: boolean;
  /** 本机估算文案（含 disclaimer）。 */
  estimateText: string;
}

export const createSessionBudget = (config: Partial<SessionBudgetConfig> = {}): {
  statusAt: (elapsedMs: number, reminderAlreadyFired: boolean) => SessionBudgetStatus;
} => {
  const { maxSessionMinutes, softCapMinutes, reminderPercent } = { ...DEFAULT_SESSION_BUDGET, ...config };
  const maxMs = maxSessionMinutes * 60_000;
  const softCapMs = softCapMinutes * 60_000;
  const reminderMs = (maxMs * reminderPercent) / 100;
  return {
    statusAt: (elapsedMs, reminderAlreadyFired) => {
      const progress = maxMs > 0 ? Math.min(1, elapsedMs / maxMs) : 1;
      const reminderDue = !reminderAlreadyFired && elapsedMs >= reminderMs;
      const softCapReached = elapsedMs >= softCapMs;
      const minutes = Math.floor(elapsedMs / 60_000);
      const seconds = Math.floor((elapsedMs % 60_000) / 1000);
      const estimateText = `${minutes}:${String(seconds).padStart(2, "0")} / ${maxSessionMinutes}:00 · ${COST_ESTIMATE_DISCLAIMER}`;
      return { elapsedMs, progress, reminderDue, softCapReached, estimateText };
    },
  };
};
