import { describe, expect, it } from "vitest";
import { cleanTranscript } from "./transcriptCleanup";

describe("cleanTranscript (§10)", () => {
  it("removes standalone filler tokens and collapses repeated punctuation", () => {
    const result = cleanTranscript("嗯，比例原则，啊，然后要求必要性。");
    expect(result.cleanText).toBe("比例原则 要求必要性。");
  });

  it("preserves numbers, terms and formulas (no fact drift)", () => {
    const result = cleanTranscript("圆周率约 3.14，嗯，GPT-4 是模型。");
    expect(result.cleanText).toBe("圆周率约 3.14 GPT-4 是模型。");
  });

  it("normalizes whitespace", () => {
    const result = cleanTranscript("比例   原则\n要求  必要性");
    expect(result.cleanText).toBe("比例 原则 要求 必要性");
  });

  it("detects uncertain spans and rates meaningRisk low/medium/high", () => {
    const low = cleanTranscript("比例原则要求必要性。");
    expect(low.uncertainSpans).toEqual([]);
    expect(low.meaningRisk).toBe("low");

    const medium = cleanTranscript("比例原则好像要求必要性。");
    expect(medium.uncertainSpans.length).toBe(1);
    expect(medium.meaningRisk).toBe("medium");

    const high = cleanTranscript("大概比例原则不确定，好像必要性也记不清。");
    expect(high.uncertainSpans.length).toBeGreaterThanOrEqual(2);
    expect(high.meaningRisk).toBe("high");
  });

  it("does not invent content when transcript is empty", () => {
    const result = cleanTranscript("");
    expect(result.cleanText).toBe("");
    expect(result.uncertainSpans).toEqual([]);
    expect(result.meaningRisk).toBe("low");
  });

  it("keeps uncertain span text bounded to its clause", () => {
    const result = cleanTranscript("目的性明确。大概必要性不成立。均衡性已满足。");
    expect(result.uncertainSpans).toEqual(["大概必要性不成立"]);
  });
});
