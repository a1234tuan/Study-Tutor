/**
 * 本机通话历史仓库（§15.1 local-only）。
 *
 * VoiceRecallLocalHistory 是用户主动保留的会话摘要（不保存原始音频/完整逐字稿/Provider 原始响应），
 * 默认随完整备份恢复保留，但永不进入云同步、导出或记录转移。
 *
 * 仓库只读写 schema 21 的 voiceRecallLocalHistory 表；绝不调用 cloudSyncMutation.put，
 * 绝不写入 CloudSyncEntityType。卸载/清数据/换机不承诺保留。
 */

import type { StudyJournalDatabase } from "../../db/database";
import type { VoiceRecallLocalHistory } from "./domain";

export interface SaveHistoryEntry {
  sourceKind: VoiceRecallLocalHistory["sourceKind"];
  title: string;
  summary: string;
  sourceRefs: VoiceRecallLocalHistory["sourceRefs"];
  estimatedUsage?: VoiceRecallLocalHistory["estimatedUsage"];
}

export const saveVoiceRecallHistory = async (
  database: StudyJournalDatabase,
  entry: SaveHistoryEntry,
  savedAt: string,
): Promise<string> => {
  const id = `voice-history-${savedAt}`;
  const record: VoiceRecallLocalHistory = {
    id,
    savedAt,
    sourceKind: entry.sourceKind,
    title: entry.title,
    summary: entry.summary,
    sourceRefs: entry.sourceRefs,
    estimatedUsage: entry.estimatedUsage,
  };
  await database.voiceRecallLocalHistory.put(record);
  return id;
};

/** 按保存时间倒序列出本机历史（最新在前）。 */
export const listVoiceRecallHistory = async (
  database: StudyJournalDatabase,
  limit = 50,
): Promise<VoiceRecallLocalHistory[]> => {
  const rows = await database.voiceRecallLocalHistory
    .orderBy("savedAt")
    .reverse()
    .limit(limit)
    .toArray();
  return rows;
};

export const deleteVoiceRecallHistory = async (
  database: StudyJournalDatabase,
  id: string,
): Promise<void> => {
  await database.voiceRecallLocalHistory.delete(id);
};

/** 清空全部本机通话历史（用户主动操作；不影响正式事实或云数据）。 */
export const clearAllVoiceRecallHistory = async (
  database: StudyJournalDatabase,
): Promise<void> => {
  await database.voiceRecallLocalHistory.clear();
};
