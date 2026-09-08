/**
 * SSE 行解析器（协议无关）。
 *
 * fetch ReadableStream 的 chunk 可能跨 `data:` 行边界切分；本解析器按行累积，
 * 产出每个 `data:` 负载（JSON 文本或 `[DONE]`）。其它 SSE 字段（event/id/retry/注释）忽略。
 *
 * 不感知 DeepSeek/豆包/Fish 的 JSON 结构——只负责把字节流切成 data 负载，
 * 具体语义由调用方（DeepSeekLlmStreamAdapter 等）解释。这样可单测且协议无关。
 */

export class SseLineParser {
  private buffer = "";

  /** 喂入原始文本 chunk，返回本次产出的完整 data 负载（去前缀、去首空白）。 */
  feed(chunk: string): string[] {
    this.buffer += chunk;
    const payloads: string[] = [];
    let newlineIdx = this.buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trimStart();
        payloads.push(payload);
      }
      newlineIdx = this.buffer.indexOf("\n");
    }
    return payloads;
  }

  /** 流结束：若缓冲区仍含未换行的 data 行，作为最后负载返回。 */
  flush(): string[] {
    if (this.buffer.startsWith("data:")) {
      const payload = this.buffer.slice(5).trimStart();
      this.buffer = "";
      return payload ? [payload] : [];
    }
    this.buffer = "";
    return [];
  }

  get pending(): string {
    return this.buffer;
  }
}
