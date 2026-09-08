/**
 * 转写整理（§10）。
 *
 * ASR final 转写经整理后再进入 LLM/记忆：去除口语填充词、规整标点、标注不确定跨度、
 * 评估语义风险。结构化结果 cleanText 用于后续，uncertainSpans 与 meaningRisk 供 UI 与
 * 提交前确认。原始转写只存 schema 21 local-only 轮次数据，不进正式事实。
 *
 * Phase 3 提供确定性规则版（测试与预览用）；真实 LLM 整理在后续包一层调用 DeepSeek 流式 adapter，
 * 但仍须返回同一 TranscriptCleanupResult 形状，不绕过本结构。
 */

import type { TranscriptCleanupResult } from "./domain";

/** 口语填充词（独立出现时移除；不破坏词内匹配）。 */
const FILLER_TOKENS = ["嗯", "啊", "呃", "额", "那个", "这个", "就是", "然后", "对吧"];
/** 不确定语义触发词；命中即记一个不确定跨度。 */
const UNCERTAIN_MARKERS = ["不确定", "不太确定", "大概", "可能", "好像", "似乎", "应该", "忘了", "记不清"];

// 填充词均为纯 CJK 文本，无正则元字符，可直接交替；构造一次复用。
const FILLER_ALTERNATION = FILLER_TOKENS.join("|");
const FILLER_WITH_DELIMS = new RegExp(`[，,\\s]*(${FILLER_ALTERNATION})[，,\\s]*`, "g");

const normalizeWhitespace = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

const collapsePunctuation = (text: string): string =>
  text.replace(/([，。！？；、,.!?;])\1+/g, "$1");

/** 移除独立填充词：保留其前后标点与语意。 */
const stripFillers = (text: string): string =>
  text.replace(FILLER_WITH_DELIMS, " ");

/** 提取不确定跨度（命中词所在的短句片段）。 */
const findUncertainSpans = (text: string): string[] => {
  const spans: string[] = [];
  for (const marker of UNCERTAIN_MARKERS) {
    let idx = text.indexOf(marker);
    while (idx !== -1) {
      // 取 marker 所在句段（向前到句号/逗号，向后到句号）。
      const start = Math.max(
        0,
        text.lastIndexOf("。", idx) + 1,
        text.lastIndexOf("，", idx) + 1,
      );
      let end = text.length;
      const nextComma = text.indexOf("，", idx);
      const nextPeriod = text.indexOf("。", idx);
      if (nextComma !== -1) end = Math.min(end, nextComma);
      if (nextPeriod !== -1) end = Math.min(end, nextPeriod);
      spans.push(text.slice(start, end).trim());
      idx = text.indexOf(marker, idx + marker.length);
    }
  }
  // 去重保序。
  return Array.from(new Set(spans));
};

const assessRisk = (uncertainSpans: string[], cleanText: string): "low" | "medium" | "high" => {
  if (uncertainSpans.length === 0) return "low";
  // 含强不确定词（"不确定"/"记不清"/"忘了"）或不确定跨度 ≥3 记 high。
  const strong = uncertainSpans.some(
    (span) => span.includes("不确定") || span.includes("记不清") || span.includes("忘了"),
  );
  if (strong || uncertainSpans.length >= 3) return "high";
  return "medium";
};

/**
 * 确定性转写整理。保留原意，不增/不减事实：只去填充、规整标点、标注不确定。
 * 不改写术语、数字、公式——这些由句界缓冲器与小数保护在下游处理。
 */
export const cleanTranscript = (rawTranscript: string): TranscriptCleanupResult => {
  const whitespace = normalizeWhitespace(rawTranscript);
  const withoutFillers = stripFillers(whitespace);
  // 移除填充词后可能产生多余空格，重新规整。
  const reflowed = normalizeWhitespace(withoutFillers);
  const cleanText = collapsePunctuation(reflowed).trim();
  const uncertainSpans = findUncertainSpans(cleanText);
  const meaningRisk = assessRisk(uncertainSpans, cleanText);
  return { cleanText, uncertainSpans, meaningRisk };
};
