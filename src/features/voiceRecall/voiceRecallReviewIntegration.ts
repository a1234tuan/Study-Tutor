/**
 * 记录级复习接入（Phase 4、§4.3）。
 *
 * 从当前日志/复习卡直接开始复述；返回后恢复原卡/进度/未提交评分。导航栈只存轻量来源身份
 * （VoiceRecallNavSource），不把会话正文塞 tabMemory/history.state。
 *
 * 不变式：语音练习不自动评分 FSRS——voice recall 会话/轮次写入不产生 recordReviews/reviews 行，
 * 不改 easeFactor/repetition/intervalDays。用户可把确认后的卡点带回复习"记录卡点"输入框
 * 或引导到日志编辑器标记决策块，但这是用户主动操作，不是自动事实写入。
 */

import type { VoiceRecallNavSource, VoiceRecallSessionMemory } from "./domain";

/** 从复习卡入口构造来源身份（§4.3 轻量来源）。 */
export const buildReviewCardNavSource = (
  reviewCardId: string,
  filterSnapshot?: unknown,
): VoiceRecallNavSource => ({
  origin: "review-card",
  reviewCardId,
  filterSnapshot,
});

/** 从日志详情入口构造来源身份。 */
export const buildRecordDetailNavSource = (recordId: string): VoiceRecallNavSource => ({
  origin: "record-detail",
  recordId,
});

/**
 * 返回语音复述后要恢复的复习视图状态。§4.3：导航栈只存来源身份；恢复的是原卡、进度与未提交评分，
 * 不恢复未确认的原始音频或会话正文。本函数纯函数化：输入保存的快照，原样返回——语义是"不丢失"，
 * 不是"从语音会话派生新状态"。
 */
export interface SavedReviewResumeState {
  reviewCardId?: string;
  recordId?: string;
  unscoredRating?: number;
  scrollAnchor?: string;
}

export const resumeReviewState = (
  saved: SavedReviewResumeState | undefined,
): SavedReviewResumeState | undefined => {
  if (!saved) return undefined;
  // 只恢复可幂等恢复的轻量字段；不恢复音频/转写正文。
  return {
    reviewCardId: saved.reviewCardId,
    recordId: saved.recordId,
    unscoredRating: saved.unscoredRating,
    scrollAnchor: saved.scrollAnchor,
  };
};

/**
 * 把会话记忆中确认的要点格式化为"记录卡点"输入文本（供复习记录卡点输入框或日志决策块标记）。
 * 这是用户主动录入的辅助文本，不是自动事实写入；调用方须在用户确认后才提交。
 */
export const formatPointsForReviewCapture = (memory: VoiceRecallSessionMemory): string => {
  const lines: string[] = [];
  if (memory.confirmedConclusions.length > 0) {
    lines.push("## 已确认结论");
    lines.push(...memory.confirmedConclusions.map((item, idx) => `${idx + 1}. ${item}`));
  }
  if (memory.answeredKeyPoints.length > 0) {
    lines.push("", "## 已答要点");
    lines.push(...memory.answeredKeyPoints.map((item, idx) => `${idx + 1}. ${item}`));
  }
  if (memory.pendingMisconceptions.length > 0) {
    lines.push("", "## 待澄清");
    lines.push(...memory.pendingMisconceptions.map((item) => `- ${item}`));
  }
  return lines.length > 0 ? lines.join("\n") : "";
};

/**
 * FSRS 不可触碰的断言（§Phase 4 不变式）。供仓库测试与运行态自检引用：
 * 语音复述写入不得创建 recordReviews/reviews 行。具体校验由测试在写入 voiceRecallSessions 后
 * count recordReviews/reviews 是否仍为 0 完成。
 */
export const VOICE_RECALL_FSRS_GUARD =
  "voice recall sessions/turns/history must not create recordReviews or reviews rows; easeFactor/repetition/intervalDays are never modified by voice recall.";
