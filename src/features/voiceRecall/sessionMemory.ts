/**
 * 结构化会话记忆（§11.2）。
 *
 * 记忆是会话级本地摘要，写入 schema 21 的 VoiceRecallSessionLocal.memory 检查点；
 * 不覆盖正式作答事实（Phase 3 不写 Coach 正式事实；Phase 5 才在提交后创建新 AdaptiveQuizTurn）。
 *
 * 不变式：
 * - answeredKeyPoints / confirmedConclusions / hintsUsed / uncoveredBlueprintCriteria 为追加只读集，
 *   只增不改不删（同一文本去重），防止回退式覆盖已确认要点。
 * - pendingMisconceptions 可在后续轮次澄清时移除（resolved），但不得静默丢弃。
 * - nextQuestionIntent 是唯一每次覆盖的单值字段。
 */

import type { VoiceRecallSessionMemory } from "./domain";

export interface SessionMemoryUpdate {
  answeredKeyPoint?: string;
  confirmedConclusion?: string;
  pendingMisconception?: string;
  /** 本轮澄清了此前的不确定，从 pending 移除。 */
  resolvedMisconception?: string;
  hintUsed?: string;
  uncoveredCriterion?: string;
  revisitTopic?: string;
  nextQuestionIntent?: string;
}

const appendUnique = (list: string[], item: string | undefined): string[] => {
  if (!item || !item.trim()) return list;
  const trimmed = item.trim();
  return list.includes(trimmed) ? list : [...list, trimmed];
};

const removeItem = (list: string[], item: string | undefined): string[] => {
  if (!item || !item.trim()) return list;
  const trimmed = item.trim();
  return list.filter((entry) => entry !== trimmed);
};

export const createInitialMemory = (
  learningGoal: string,
  sourceRangeLabel: string,
): VoiceRecallSessionMemory => ({
  learningGoal,
  sourceRangeLabel,
  answeredKeyPoints: [],
  confirmedConclusions: [],
  pendingMisconceptions: [],
  hintsUsed: [],
  uncoveredBlueprintCriteria: [],
  revisitTopics: [],
  nextQuestionIntent: "",
});

/** 应用一轮记忆更新，执行追加只读 / 解析移除 / 意图覆盖的不变式。 */
export const updateSessionMemory = (
  current: VoiceRecallSessionMemory,
  update: SessionMemoryUpdate,
): VoiceRecallSessionMemory => ({
  learningGoal: current.learningGoal,
  sourceRangeLabel: current.sourceRangeLabel,
  answeredKeyPoints: appendUnique(current.answeredKeyPoints, update.answeredKeyPoint),
  confirmedConclusions: appendUnique(current.confirmedConclusions, update.confirmedConclusion),
  pendingMisconceptions: appendUnique(
    removeItem(current.pendingMisconceptions, update.resolvedMisconception),
    update.pendingMisconception,
  ),
  hintsUsed: appendUnique(current.hintsUsed, update.hintUsed),
  uncoveredBlueprintCriteria: appendUnique(current.uncoveredBlueprintCriteria, update.uncoveredCriterion),
  revisitTopics: appendUnique(current.revisitTopics, update.revisitTopic),
  // 唯一可整体覆盖的单值字段。
  nextQuestionIntent: update.nextQuestionIntent ?? current.nextQuestionIntent,
});

/** 摘要更新必须可校验：导出只读快照，调用方不得直接 mutate。 */
export const freezeMemory = (memory: VoiceRecallSessionMemory): Readonly<VoiceRecallSessionMemory> => {
  const arrays = {
    answeredKeyPoints: [...memory.answeredKeyPoints],
    confirmedConclusions: [...memory.confirmedConclusions],
    pendingMisconceptions: [...memory.pendingMisconceptions],
    hintsUsed: [...memory.hintsUsed],
    uncoveredBlueprintCriteria: [...memory.uncoveredBlueprintCriteria],
    revisitTopics: [...memory.revisitTopics],
  };
  for (const arr of Object.values(arrays)) {
    Object.freeze(arr);
  }
  return Object.freeze({ ...memory, ...arrays });
};
