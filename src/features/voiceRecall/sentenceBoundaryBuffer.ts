/**
 * 句界缓冲器（§13.1）。
 *
 * LLM token 流进入缓冲；得到完整可朗读短句后请求 TTS，后续句子并行排队。
 * 切分保护数字（3.14）、缩写（e.g. / i.e. / etc.）、公式与英文术语，不在词内断句。
 *
 * 流式安全：边界只在"确认后继分隔符"时才切分；处于 pending 末尾的终端字符暂不切分，
 * 因为后续 delta 可能把 "3." 补成 "3.14"。stream 结束时调用 flush() 取回剩余文本。
 */

const CJK_BOUNDARY = new Set(["。", "！", "？", "；", "…"]);
const ASCII_BOUNDARY = new Set([".", "!", "?"]);

/** 常见缩写，结尾的 ". " 不得作为句界（§13.1 保护缩写）。 */
const ABBREVIATIONS = [
  "e.g.", "i.e.", "etc.", "vs.", "vs", "mr.", "mrs.", "dr.", "prof.",
  "inc.", "ltd.", "co.", "no.", "cf.", "pp.", "approx.", "fig.", "eq.",
  "st.", "nd.", "rd.", "th.", "min.", "max.", "avg.",
];

const isWhitespace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);
const isCjk = (ch: string | undefined): boolean =>
  ch !== undefined && /[一-鿿㐀-䶿]/.test(ch);
const isDigit = (ch: string | undefined): boolean => ch !== undefined && /[0-9]/.test(ch);

export class SentenceBoundaryBuffer {
  private pending = "";

  /** 喂入 token delta，返回本次产出的完整短句（已 trim，空串被过滤）。 */
  feed(delta: string): string[] {
    this.pending += delta;
    return this.extract();
  }

  /** 流结束：取回缓冲区剩余文本作为最后一句。 */
  flush(): string[] {
    const remaining = this.pending.trim();
    this.pending = "";
    return remaining ? [remaining] : [];
  }

  get pendingText(): string {
    return this.pending;
  }

  private extract(): string[] {
    const sentences: string[] = [];
    let start = 0;
    let i = 0;
    while (i < this.pending.length) {
      const ch = this.pending[i];

      // 中文终端：直接切分（中文句号无歧义）。
      if (CJK_BOUNDARY.has(ch)) {
        i += 1;
        const sentence = this.pending.slice(start, i).trim();
        if (sentence) sentences.push(sentence);
        start = i;
        continue;
      }

      // ASCII 终端：仅在确认后继分隔符且非数字/缩写时切分。
      if (ASCII_BOUNDARY.has(ch)) {
        const next = this.pending[i + 1];
        // 处于 pending 末尾时暂不切分：后续 delta 可能补成小数/缩写。
        if (next === undefined) {
          i += 1;
          continue;
        }
        const afterIsSeparator = isWhitespace(next) || isCjk(next);
        if (!afterIsSeparator) {
          i += 1;
          continue;
        }
        // 小数保护：3.14 的 "." 不切。
        if (ch === "." && isDigit(this.pending[i - 1]) && isDigit(next)) {
          i += 1;
          continue;
        }
        // 缩写保护：以已知缩写结尾的 ". " 不切。
        if (ch === "." && this.endsInAbbreviation(start, i + 1)) {
          i += 1;
          continue;
        }
        // 确认边界。
        i += 1;
        const sentence = this.pending.slice(start, i).trim();
        if (sentence) sentences.push(sentence);
        start = i;
        continue;
      }

      i += 1;
    }

    this.pending = this.pending.slice(start);
    return sentences;
  }

  private endsInAbbreviation(start: number, end: number): boolean {
    const lower = this.pending.slice(start, end).toLowerCase();
    return ABBREVIATIONS.some((ab) => lower.endsWith(ab));
  }
}
