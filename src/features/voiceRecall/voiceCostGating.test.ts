import { describe, expect, it } from "vitest";

import {
  COST_ESTIMATE_DISCLAIMER,
  DEFAULT_MAX_SESSION_MINUTES,
  DEFAULT_SESSION_BUDGET,
  SOFT_CAP_MINUTES,
  createSessionBudget,
} from "./voiceCostGating";

describe("voice cost gating (§16)", () => {
  it("exposes the documented defaults: 10min budget, 20min soft cap, 80% reminder", () => {
    expect(DEFAULT_MAX_SESSION_MINUTES).toBe(10);
    expect(SOFT_CAP_MINUTES).toBe(20);
    expect(DEFAULT_SESSION_BUDGET.reminderPercent).toBe(80);
    expect(COST_ESTIMATE_DISCLAIMER).toContain("仅供参考");
    expect(COST_ESTIMATE_DISCLAIMER).toContain("Provider 账单");
  });

  it("fires the reminder once at 80% of the budget and not before", () => {
    const budget = createSessionBudget();
    expect(budget.statusAt(7 * 60_000, false).reminderDue).toBe(false);
    expect(budget.statusAt(8 * 60_000, false).reminderDue).toBe(true); // 80% of 10min
    // 已提醒过则不再重复触发（提醒只一次）。
    expect(budget.statusAt(9 * 60_000, true).reminderDue).toBe(false);
  });

  it("reaches the soft cap at 20min and keeps the reminder from re-firing", () => {
    const budget = createSessionBudget();
    const at19 = budget.statusAt(19 * 60_000, true);
    expect(at19.softCapReached).toBe(false);
    const at20 = budget.statusAt(20 * 60_000, true);
    expect(at20.softCapReached).toBe(true); // 请求门控：不再开新轮次
    expect(at20.reminderDue).toBe(false); // 已提醒过
  });

  it("clamps progress to 1.0 and annotates the estimate with the disclaimer", () => {
    const budget = createSessionBudget();
    const over = budget.statusAt(99 * 60_000, true);
    expect(over.progress).toBe(1);
    expect(over.estimateText).toContain("99:00");
    expect(over.estimateText).toContain("10:00");
    expect(over.estimateText).toContain(COST_ESTIMATE_DISCLAIMER);
  });

  it("supports a custom budget for acceptance runs without changing defaults", () => {
    const budget = createSessionBudget({ maxSessionMinutes: 5, softCapMinutes: 7, reminderPercent: 60 });
    expect(budget.statusAt(2 * 60_000, false).reminderDue).toBe(false);
    expect(budget.statusAt(3 * 60_000, false).reminderDue).toBe(true); // 60% of 5min
    expect(budget.statusAt(7 * 60_000, true).softCapReached).toBe(true);
  });
});
