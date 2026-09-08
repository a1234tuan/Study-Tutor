/**
 * 停顿与一句话结束判定（§9）。
 *
 * 不能把一次短暂停顿等同于"用户说完"。本地 TurnEndpointController 统一决定提交时机：
 *   1. ASR partial 只用于屏幕预览，不触发 LLM。
 *   2. 约 1.8s 静音后进入"可能说完"，而非立即发送。
 *   3. 文本以连接词/未完成枚举/半句结尾时继续等待，最长延长到约 4s。
 *   4. 用户重新开口时把前后 ASR 片段合并为同一轮。
 *   5. 单轮约 45s 提示"内容较长，可继续分段说"，但不截断已识别文本。
 *   6. 点击结束/松开长按/二次点击主按钮最高优先级，立即完成本轮。
 *
 * 时间参数必须可配置且不散落在组件内部成为魔法数字。所有时间以单调时钟 ms 计。
 */

export interface TurnEndpointConfig {
  /** 进入"可能说完"的静音阈值（§9 第 2 条）。默认 1800ms。 */
  possibleDoneSilenceMs: number;
  /** 含连接词/半句时最长等待（§9 第 3 条）。默认 4000ms。 */
  maxWaitMs: number;
  /** 长轮次提示阈值（§9 第 5 条）。默认 45000ms。 */
  longTurnMs: number;
}

export const DEFAULT_TURN_ENDPOINT_CONFIG: TurnEndpointConfig = {
  possibleDoneSilenceMs: 1800,
  maxWaitMs: 4000,
  longTurnMs: 45000,
};

export type TurnEndpointEvent =
  | { type: "possible-done" } // 进入"可能说完"状态（UI 提示，不发送）
  | { type: "finalize"; reason: "silence" | "manual" | "long-turn" } // 提交本轮
  | { type: "long-turn-prompt" } // 提示内容较长，可分段（不截断）
  | { type: "merge-resume" }; // 用户重新开口，合并片段继续本轮

/** 中文连接词/未完成枚举/半句结尾判定（§9 第 3 条）。保守：不确定时视为未完成以避免误提交。 */
const CONNECTIVE_SUFFIXES = [
  "因为", "所以", "但是", "而且", "然后", "并且", "以及", "此外", "另外",
  "然而", "虽然", "尽管", "如果", "只要", "只有", "由于", "为了", "从而",
  "进而", "接着", "随后", "于是", "因此", "不仅", "不但", "既", "或", "和",
  "与", "及", "第一", "第二", "第三", "其一", "其次", "再次", "最后",
  "一是", "二是", "首先", "接着",
];

const endsWithConnective = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (CONNECTIVE_SUFFIXES.some((suffix) => trimmed.endsWith(suffix))) return true;
  // 以顿号/逗号/冒号结尾视为半句未完成。
  return /[、，,：:]$/.test(trimmed);
};

const endsWithSentenceTerminal = (text: string): boolean => {
  const trimmed = text.trim();
  return /[。！？!?]$/.test(trimmed);
};

export interface TurnEndpointStateSnapshot {
  turnStartMs: number | null;
  lastPartialAtMs: number | null;
  lastPartialText: string;
  possibleDoneEmitted: boolean;
  longTurnEmitted: boolean;
}

/**
 * 纯逻辑控制器。不直接订阅 ASR；由调用方在收到 partial 与定时器 tick 时喂入。
 * 单调时钟由调用方注入（nowMs），便于测试用假时钟驱动，不依赖 Date.now。
 */
export class TurnEndpointController {
  private turnStartMs: number | null = null;
  private lastPartialAtMs: number | null = null;
  private lastPartialText = "";
  private possibleDoneEmitted = false;
  private longTurnEmitted = false;

  constructor(private readonly config: TurnEndpointConfig = DEFAULT_TURN_ENDPOINT_CONFIG) {}

  /** 开始新一轮。 */
  start(nowMs: number): void {
    this.turnStartMs = nowMs;
    this.lastPartialAtMs = null;
    this.lastPartialText = "";
    this.possibleDoneEmitted = false;
    this.longTurnEmitted = false;
  }

  /** 收到 ASR partial（§9 第 1 条：只用于预览，本方法不触发 LLM）。 */
  feedPartial(text: string, nowMs: number): TurnEndpointEvent[] {
    if (this.turnStartMs === null) this.start(nowMs);
    const wasPossibleDone = this.possibleDoneEmitted;
    this.lastPartialAtMs = nowMs;
    this.lastPartialText = text;
    const events: TurnEndpointEvent[] = [];
    if (wasPossibleDone) {
      // 用户重新开口：合并片段继续本轮（§9 第 4 条）。
      events.push({ type: "merge-resume" });
    }
    this.possibleDoneEmitted = false;
    return events;
  }

  /** 定时器调用，返回该 tick 产生的事件。 */
  tick(nowMs: number): TurnEndpointEvent[] {
    const events: TurnEndpointEvent[] = [];
    if (this.turnStartMs === null) return events;

    const turnElapsed = nowMs - this.turnStartMs;
    if (!this.longTurnEmitted && turnElapsed >= this.config.longTurnMs) {
      this.longTurnEmitted = true;
      events.push({ type: "long-turn-prompt" });
      // 不截断、不强制提交（§9 第 5 条）。
    }

    if (this.lastPartialAtMs === null) return events;
    const silence = nowMs - this.lastPartialAtMs;

    if (!this.possibleDoneEmitted && silence >= this.config.possibleDoneSilenceMs) {
      this.possibleDoneEmitted = true;
      events.push({ type: "possible-done" });
      return events;
    }

    if (this.possibleDoneEmitted) {
      const incomplete = endsWithConnective(this.lastPartialText) && !endsWithSentenceTerminal(this.lastPartialText);
      // 文本完整（句末标点）且已过 possibleDone 阈值 → 提交。
      // 或文本未完成但已等满 maxWait → 提交（不再无限等）。
      if (!incomplete || silence >= this.config.maxWaitMs) {
        events.push({ type: "finalize", reason: "silence" });
      }
    }
    return events;
  }

  /** 手动结束（点击/松开/二次点击，§9 第 6 条）。最高优先级，立即提交。 */
  manualEnd(): TurnEndpointEvent {
    return { type: "finalize", reason: "manual" };
  }

  snapshot(): TurnEndpointStateSnapshot {
    return {
      turnStartMs: this.turnStartMs,
      lastPartialAtMs: this.lastPartialAtMs,
      lastPartialText: this.lastPartialText,
      possibleDoneEmitted: this.possibleDoneEmitted,
      longTurnEmitted: this.longTurnEmitted,
    };
  }
}
