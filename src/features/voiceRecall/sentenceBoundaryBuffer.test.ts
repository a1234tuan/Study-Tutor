import { describe, expect, it } from "vitest";
import { SentenceBoundaryBuffer } from "./sentenceBoundaryBuffer";

describe("SentenceBoundaryBuffer (§13.1)", () => {
  it("splits on Chinese sentence terminals and keeps the partial tail until flushed", () => {
    const buf = new SentenceBoundaryBuffer();
    expect(buf.feed("比例原则要求")).toEqual([]);
    expect(buf.feed("行政行为符合")).toEqual([]);
    expect(buf.feed("目的性。")).toEqual(["比例原则要求行政行为符合目的性。"]);
    expect(buf.feed("必要性")).toEqual([]);
    expect(buf.flush()).toEqual(["必要性"]);
  });

  it("protects decimal numbers from mid-split (3. does not become a boundary)", () => {
    const buf = new SentenceBoundaryBuffer();
    // "3." 处于 pending 末尾，暂不切分；补成 "3.14" 后小数保护。
    expect(buf.feed("圆周率约 3.")).toEqual([]);
    expect(buf.feed("14 等于 Pi。")).toEqual(["圆周率约 3.14 等于 Pi。"]);
  });

  it("protects common abbreviations (e.g. does not split before the space)", () => {
    const buf = new SentenceBoundaryBuffer();
    // "e.g." 后接空格，缩写保护使此处不切分。
    expect(buf.feed("例如向量 e.g. ")).toEqual([]);
    expect(buf.feed("张量。")).toEqual(["例如向量 e.g. 张量。"]);
  });

  it("protects English terms without internal terminals and splits on '. ' followed by separator", () => {
    const buf = new SentenceBoundaryBuffer();
    // "GPT-4" 无终端，整体保留；". " 后接空格才切。
    expect(buf.feed("使用 GPT-4")).toEqual([]);
    expect(buf.feed(" 生成文本. ")).toEqual(["使用 GPT-4 生成文本."]);
    expect(buf.flush()).toEqual([]);
  });

  it("does not split a trailing terminal until a separator arrives (stream-safe)", () => {
    const buf = new SentenceBoundaryBuffer();
    expect(buf.feed("第一句。")).toEqual(["第一句。"]);
    // "第二句." 末尾的 "." 暂不切（后续 delta 可能使它成为小数或缩写的一部分）。
    expect(buf.feed("第二句.")).toEqual([]);
    // 补空格后确认切分："第二句." 作为完整句产出。
    expect(buf.feed(" 后续。")).toEqual(["第二句.", "后续。"]);
  });

  it("feeds multiple deltas and produces sentences incrementally for TTS parallel queueing", () => {
    const buf = new SentenceBoundaryBuffer();
    const tokens = ["比例", "原则", "包含", "目的性", "、", "必要性", "与", "均衡性", "。", "其中", "必要性", "要求", "最小侵害", "。"];
    const produced: string[] = [];
    for (const token of tokens) {
      produced.push(...buf.feed(token));
    }
    produced.push(...buf.flush());
    expect(produced).toEqual([
      "比例原则包含目的性、必要性与均衡性。",
      "其中必要性要求最小侵害。",
    ]);
  });

  it("emits the first speakable sentence as soon as it is complete (§13.1 first-sentence TTS gate)", () => {
    const buf = new SentenceBoundaryBuffer();
    // 首个可朗读短句完成后立即产出，触发 TTS 请求。
    const first = buf.feed("今天讲比例原则。");
    expect(first).toEqual(["今天讲比例原则。"]);
    expect(buf.flush()).toEqual([]);
  });
});
