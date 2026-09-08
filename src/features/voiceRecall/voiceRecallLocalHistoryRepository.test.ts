import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import { StudyJournalDatabase } from "../../db/database";
import { buildVoiceRecallSession } from "./voiceRecallSessionBuilder";
import {
  clearAllVoiceRecallHistory,
  deleteVoiceRecallHistory,
  listVoiceRecallHistory,
  saveVoiceRecallHistory,
} from "./voiceRecallLocalHistoryRepository";
import type { VoiceCallConfig } from "./domain";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const names = new Set<string>();
const openDb = (name: string) => {
  names.add(name);
  const db = new StudyJournalDatabase(name);
  return db.open().then(() => db);
};

afterEach(async () => {
  await Promise.all([...names].map((name) => Dexie.delete(name)));
  names.clear();
});

const CONFIG: VoiceCallConfig = {
  asrProviderId: "doubao-asr-cn",
  llmProviderId: "deepseek-llm-cn",
  ttsProviderId: "fish-audio-tts-cn",
  inputMode: "auto-half-duplex",
  maxSessionMinutes: 10,
  defaultKnowledgePolicy: "notes-only",
};

describe("voiceRecallSessionBuilder (§5/§6)", () => {
  it("builds an active session checkpoint with idle state and source-appropriate knowledge policy", () => {
    const freeTopic = buildVoiceRecallSession({
      sessionId: "s1",
      sourceKind: "free-topic",
      config: CONFIG,
      startedAt: "2026-09-08T10:00:00.000Z",
    });
    expect(freeTopic.status).toBe("active");
    expect(freeTopic.checkpoint?.callState).toBe("idle");
    expect(freeTopic.config?.defaultKnowledgePolicy).toBe("expand"); // free-topic 默认 expand

    const scopePractice = buildVoiceRecallSession({
      sessionId: "s2",
      sourceKind: "scope-practice",
      config: CONFIG,
      startedAt: "2026-09-08T10:00:00.000Z",
    });
    expect(scopePractice.config?.defaultKnowledgePolicy).toBe("notes-only"); // 范围会话优先日志原文
  });

  it("honors an explicit knowledge policy override", () => {
    const session = buildVoiceRecallSession({
      sessionId: "s3",
      sourceKind: "free-topic",
      config: CONFIG,
      knowledgePolicy: "notes-only",
      startedAt: "2026-09-08T10:00:00.000Z",
    });
    expect(session.config?.defaultKnowledgePolicy).toBe("notes-only");
  });
});

describe("voiceRecallLocalHistoryRepository (§15.1 local-only)", () => {
  it("saves and lists history by savedAt descending", async () => {
    const db = await openDb(`voice-history-${crypto.randomUUID()}`);
    await saveVoiceRecallHistory(db, {
      sourceKind: "free-topic",
      title: "比例原则复述",
      summary: "三要素与最小侵害",
      sourceRefs: [{ kind: "free-topic", label: "自由主题" }],
    }, "2026-09-08T10:00:00.000Z");
    await saveVoiceRecallHistory(db, {
      sourceKind: "scope-practice",
      title: "必要性子原则",
      summary: "最小侵害的含义",
      sourceRefs: [{ kind: "record", id: "rec-1", label: "9月8日日志" }],
    }, "2026-09-08T11:00:00.000Z");

    const list = await listVoiceRecallHistory(db);
    expect(list.map((row) => row.title)).toEqual(["必要性子原则", "比例原则复述"]);
  });

  it("deletes a single history entry without affecting others", async () => {
    const db = await openDb(`voice-history-${crypto.randomUUID()}`);
    const id1 = await saveVoiceRecallHistory(db, {
      sourceKind: "free-topic", title: "A", summary: "a", sourceRefs: [],
    }, "2026-09-08T10:00:00.000Z");
    const id2 = await saveVoiceRecallHistory(db, {
      sourceKind: "free-topic", title: "B", summary: "b", sourceRefs: [],
    }, "2026-09-08T11:00:00.000Z");
    await deleteVoiceRecallHistory(db, id1);
    const remaining = await listVoiceRecallHistory(db);
    expect(remaining.map((row) => row.id)).toEqual([id2]);
  });

  it("clearAll empties history without touching formal data or marking cloud mutation", async () => {
    const db = await openDb(`voice-history-${crypto.randomUUID()}`);
    await saveVoiceRecallHistory(db, {
      sourceKind: "free-topic", title: "A", summary: "a", sourceRefs: [],
    }, "2026-09-08T10:00:00.000Z");
    await clearAllVoiceRecallHistory(db);
    expect(await listVoiceRecallHistory(db)).toEqual([]);
    // local-only：不产生 cloudSyncMutation 记录。
    expect(await db.cloudSyncMutation.count()).toBe(0);
  });

  it("never creates a cloud mutation on save (local-only invariant)", async () => {
    const db = await openDb(`voice-history-${crypto.randomUUID()}`);
    await saveVoiceRecallHistory(db, {
      sourceKind: "scope-practice", title: "A", summary: "a", sourceRefs: [],
    }, "2026-09-08T10:00:00.000Z");
    expect(await db.cloudSyncMutation.count()).toBe(0);
  });
});
