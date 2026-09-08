import { describe, expect, it } from "vitest";
import { SseLineParser } from "./sseLineParser";

describe("SseLineParser", () => {
  it("extracts data payloads from complete lines and ignores non-data fields", () => {
    const parser = new SseLineParser();
    const out = parser.feed("event: chunk\ndata: hello\nid: 1\n\n");
    expect(out).toEqual(["hello"]);
  });

  it("accumulates across chunk boundaries that split a data line", () => {
    const parser = new SseLineParser();
    expect(parser.feed("data: 比例")).toEqual([]);
    expect(parser.feed("原则\n")).toEqual(["比例原则"]);
  });

  it("yields [DONE] as a literal payload for the adapter to detect end", () => {
    const parser = new SseLineParser();
    expect(parser.feed("data: [DONE]\n\n")).toEqual(["[DONE]"]);
  });

  it("handles multiple data events in one chunk", () => {
    const parser = new SseLineParser();
    const out = parser.feed("data: a\n\ndata: b\n\ndata: c\n\n");
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("ignores comment lines (starting with colon)", () => {
    const parser = new SseLineParser();
    expect(parser.feed(": keepalive\ndata: ping\n\n")).toEqual(["ping"]);
  });

  it("flush returns a trailing data line without a newline", () => {
    const parser = new SseLineParser();
    parser.feed("data: tail");
    expect(parser.flush()).toEqual(["tail"]);
    expect(parser.flush()).toEqual([]);
  });

  it("strips a single leading space after data: per SSE spec", () => {
    const parser = new SseLineParser();
    expect(parser.feed("data: {\"a\":1}\n")).toEqual(['{"a":1}']);
  });
});
