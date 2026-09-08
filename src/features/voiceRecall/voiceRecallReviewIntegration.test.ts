import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import { StudyJournalDatabase } from "../../db/database";
import { buildVoiceRecallSession } from "./voiceRecallSessionBuilder";
import { createInitialMemory } from "./sessionMemory";
import {
  buildRecordDetailNavSource,
  buildReviewCardNavSource,
  formatPointsForReviewCapture,
  resumeReviewState,
} from "./voiceRecallReviewIntegration";
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

describe("voiceRecallReviewIntegration (Phase 4)", () => {
  it("builds light nav sources for review-card and record-detail entry", () => {
    const fromCard = buildReviewCardNavSource("card-1", { tag: "法律" });
    expect(fromCard.origin).toBe("review-card");
    expect(fromCard.reviewCardId).toBe("card-1");
    expect(fromCard.filterSnapshot).toEqual({ tag: "法律" });

    const fromRecord = buildRecordDetailNavSource("rec-1");
    expect(fromRecord.origin).toBe("record-detail");
    expect(fromRecord.recordId).toBe("rec-1");
  });

  it("resumes only light review state; does not derive session content", () => {
    const saved = { reviewCardId: "card-1", unscoredRating: 3, scrollAnchor: "block-2" };
    const resumed = resumeReviewState(saved);
    expect(resumed).toEqual(saved);
    expect(resumeReviewState(undefined)).toBeUndefined();
  });

  it("formats confirmed points for the review capture input (user-initiated, not auto-write)", () => {
    const memory = createInitialMemory("掌握比例原则", "今日日志");
    memory.answeredKeyPoints = ["目的性", "必要性"];
    memory.confirmedConclusions = ["三要素缺一不可"];
    memory.pendingMisconceptions = ["把均衡性当成必要性"];
    const text = formatPointsForReviewCapture(memory);
    expect(text).toContain("## 已确认结论");
    expect(text).toContain("1. 三要素缺一不可");
    expect(text).toContain("## 已答要点");
    expect(text).toContain("- 把均衡性当成必要性");
  });

  it("returns empty capture text when no confirmed points exist", () => {
    const memory = createInitialMemory("g", "r");
    expect(formatPointsForReviewCapture(memory)).toBe("");
  });

  it("does not touch FSRS tables when writing a voice-recall session (no auto-rating)", async () => {
    const db = await openDb(`voice-fsrs-${crypto.randomUUID()}`);
    // 预置一条既有复习状态与复习计划，确认语音会话写入不增不改。
    await db.recordReviews.put({
      id: "rr-1", recordId: "rec-1", status: "due",
      easeFactor: 2.5, repetition: 0, intervalDays: 1,
      consecutiveRemembered: 0, totalReviews: 0,
      createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z",
    } as never);
    await db.reviews.put({
      id: "rev-1", mistakeId: "m-1", stage: 1, dueAt: "2026-09-09",
      createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z",
    } as never);

    const beforeReviews = await db.recordReviews.count();
    const beforeSchedules = await db.reviews.count();

    const session = buildVoiceRecallSession({
      sessionId: "voice-session-fsrs",
      sourceKind: "scope-practice",
      config: CONFIG,
      startedAt: "2026-09-08T10:00:00.000Z",
      navSource: buildRecordDetailNavSource("rec-1"),
    });
    session.memory = createInitialMemory("复述比例原则", "日志 rec-1");
    await db.voiceRecallSessions.put(session);
    await db.voiceRecallTurns.put({
      id: "voice-turn-fsrs", sessionId: session.id, sequence: 1,
      status: "displayed", updatedAt: "2026-09-08T10:01:00.000Z",
      transcriptFinal: "比例原则要求三要素",
    });

    // FSRS 表行数不变；语音会话不自动评分。
    expect(await db.recordReviews.count()).toBe(beforeReviews);
    expect(await db.reviews.count()).toBe(beforeSchedules);
    // 既有 FSRS 行内容未被改写。
    const rr = await db.recordReviews.get("rr-1");
    expect(rr?.easeFactor).toBe(2.5);
    expect(rr?.repetition).toBe(0);
    // local-only：不标 cloud mutation。
    expect(await db.cloudSyncMutation.count()).toBe(0);
  });
});
