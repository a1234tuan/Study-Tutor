import { describe, expect, it } from "vitest";
import { createInitialMemory, freezeMemory, updateSessionMemory } from "./sessionMemory";

describe("sessionMemory (§11.2)", () => {
  it("creates an empty memory seeded with goal and source range", () => {
    const memory = createInitialMemory("掌握比例原则", "今日日志 / 法律");
    expect(memory.learningGoal).toBe("掌握比例原则");
    expect(memory.sourceRangeLabel).toBe("今日日志 / 法律");
    expect(memory.answeredKeyPoints).toEqual([]);
  });

  it("appends key points and conclusions without duplicating (append-only)", () => {
    const initial = createInitialMemory("g", "r");
    const afterFirst = updateSessionMemory(initial, {
      answeredKeyPoint: "目的性",
      confirmedConclusion: "比例原则三要素",
    });
    const afterSecond = updateSessionMemory(afterFirst, {
      answeredKeyPoint: "目的性", // 重复：去重，不覆盖
      confirmedConclusion: "必要性",
    });
    expect(afterSecond.answeredKeyPoints).toEqual(["目的性"]);
    expect(afterSecond.confirmedConclusions).toEqual(["比例原则三要素", "必要性"]);
  });

  it("resolves a pending misconception only when explicitly resolved, never silently dropped", () => {
    let memory = createInitialMemory("g", "r");
    memory = updateSessionMemory(memory, { pendingMisconception: "误以为比例原则=合法性审查" });
    expect(memory.pendingMisconceptions).toEqual(["误以为比例原则=合法性审查"]);

    // 再追加一个不同的误解。
    memory = updateSessionMemory(memory, { pendingMisconception: "把均衡性当成必要性" });
    expect(memory.pendingMisconceptions.length).toBe(2);

    // 澄清其一：移除。
    memory = updateSessionMemory(memory, { resolvedMisconception: "误以为比例原则=合法性审查" });
    expect(memory.pendingMisconceptions).toEqual(["把均衡性当成必要性"]);
  });

  it("overwrites only nextQuestionIntent (the single mutable value field)", () => {
    let memory = createInitialMemory("g", "r");
    memory = updateSessionMemory(memory, { nextQuestionIntent: "追问最小侵害" });
    expect(memory.nextQuestionIntent).toBe("追问最小侵害");
    memory = updateSessionMemory(memory, { nextQuestionIntent: "追问均衡性" });
    expect(memory.nextQuestionIntent).toBe("追问均衡性");
  });

  it("freezes memory so downstream cannot mutate the snapshot", () => {
    const memory = createInitialMemory("g", "r");
    const frozen = freezeMemory(
      updateSessionMemory(memory, { answeredKeyPoint: "目的性" }),
    );
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(() => {
      (frozen as { answeredKeyPoints: string[] }).answeredKeyPoints.push("hack");
    }).toThrow();
  });
});
