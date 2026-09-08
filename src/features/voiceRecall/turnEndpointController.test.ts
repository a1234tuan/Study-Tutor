import { describe, expect, it } from "vitest";
import { DEFAULT_TURN_ENDPOINT_CONFIG, TurnEndpointController } from "./turnEndpointController";

const config = { ...DEFAULT_TURN_ENDPOINT_CONFIG, possibleDoneSilenceMs: 1800, maxWaitMs: 4000, longTurnMs: 45000 };
const controller = () => new TurnEndpointController(config);

describe("TurnEndpointController short silence", () => {
  it("does not finalize after a brief pause below the possible-done threshold", () => {
    const c = controller();
    c.start(0);
    c.feedPartial("比例原则包含三个子原则", 100);
    const events = c.tick(1000); // 900ms silence — below 1800ms
    expect(events).toEqual([]);
  });

  it("enters possible-done but does not finalize immediately at the threshold", () => {
    const c = controller();
    c.start(0);
    c.feedPartial("比例原则包含三个子原则。", 100); // 句末标点 → 完整
    const events = c.tick(1900); // 1800ms silence
    expect(events).toEqual([{ type: "possible-done" }]);
  });
});

describe("TurnEndpointController manual end", () => {
  it("finalizes immediately on manual end, highest priority (§9 #6)", () => {
    const c = controller();
    c.start(0);
    c.feedPartial("任意文本", 100);
    expect(c.manualEnd()).toEqual({ type: "finalize", reason: "manual" });
  });
});

describe("TurnEndpointController merge-resume", () => {
  it("emits merge-resume when the user re-opens after possible-done (§9 #4)", () => {
    const c = controller();
    c.start(0);
    c.feedPartial("比例原则", 100);
    c.tick(1900); // → possible-done
    const events = c.feedPartial("包含目的性", 2000); // 用户重新开口
    expect(events).toContainEqual({ type: "merge-resume" });
    expect(c.snapshot().possibleDoneEmitted).toBe(false);
  });

  it("finalizes when silence continues past maxWait with incomplete text", () => {
    const c = controller();
    c.start(0);
    c.feedPartial("比例原则包含，", 100); // 以逗号结尾 → 未完成
    c.tick(1900); // possible-done
    const events = c.tick(4100); // > maxWait 4000
    expect(events).toContainEqual({ type: "finalize", reason: "silence" });
  });

  it("finalizes on complete sentence at possible-done threshold without waiting maxWait", () => {
    const c = controller();
    c.start(0);
    c.feedPartial("比例原则包含三个子原则。", 100); // 句末标点
    c.tick(1900); // possible-done
    const events = c.tick(2000); // 仍 < maxWait，但文本完整 → finalize
    expect(events).toContainEqual({ type: "finalize", reason: "silence" });
  });
});

describe("TurnEndpointController long turn", () => {
  it("emits a long-turn prompt but does not truncate or force finalize (§9 #5)", () => {
    const c = controller();
    c.start(0);
    c.feedPartial("很长的一段连续口述", 100);
    const events = c.tick(45100); // >= longTurnMs
    expect(events).toContainEqual({ type: "long-turn-prompt" });
    // 不应同时 finalize（长轮次只提示，不截断）
    expect(events.find((e) => e.type === "finalize")).toBeUndefined();
  });
});
