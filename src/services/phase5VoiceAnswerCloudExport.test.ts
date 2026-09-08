import { describe, expect, it } from "vitest";

import type { RecordBlock, StorageSnapshot } from "../types";
import { completeCoachTestSnapshot } from "../features/reviewCoach/reviewCoachTestFixtures";
import { exportCloudSync, materializeCloudSyncSnapshot } from "./cloudSyncModel";

const stamp = "2026-09-08T00:00:00.000Z";

const record: RecordBlock = {
  id: "record-1", createdAt: stamp, updatedAt: stamp, type: "record", date: "2026-09-08", order: 0, subject: "OS",
  title: "进程", contentHtml: "<p>上下文切换</p>", assets: [], formulas: [], mistakeRefs: [], tags: [],
};

const baseSnapshot: StorageSnapshot = {
  payload: {
    manifest: { format: "study-journal", version: 5, exportedAt: stamp, appVersion: "0.1.0", counts: { entries: 0, blocks: 1, mistakes: 0, assets: 0, tags: 0, reviews: 0, studySessions: 0 } },
    entries: [], blocks: [record], templates: [], recordDrafts: [], mistakes: [], tags: [], reviews: [], recordReviews: [], recordReviewLogs: [], recordReviewDayStats: [], studySessions: [],
    settings: { id: "settings", examDate: "2026-12-27", theme: "system", accentColor: "#2f6f5e", backupReminderDays: 7, fontScale: 1, lineHeight: 1.7, subjects: [], schemaVersion: 4 },
  },
  assets: [],
};

const withCoach = (mutate: (turn: import("../features/reviewCoach/domain").AdaptiveQuizTurn) => void): StorageSnapshot => {
  const coach = completeCoachTestSnapshot();
  const [turn] = coach.adaptiveQuizTurns;
  if (!turn) throw new Error("fixture missing adaptiveQuizTurns");
  mutate(turn);
  return { ...baseSnapshot, payload: { ...baseSnapshot.payload, reviewCoach: coach } };
};

describe("Phase 5 voice answer fields — cloud export & privacy (§5.1)", () => {
  it("exports answerInputMode and transcriptEdited on the adaptive-quiz-turn entity", async () => {
    const exported = await exportCloudSync(withCoach((turn) => {
      turn.answerInputMode = "voice";
      turn.transcriptEdited = true;
    }));
    const quizTurnEntity = exported.entities.find((entity) => entity.entityType === "adaptive-quiz-turn");
    expect(quizTurnEntity).toBeDefined();
    expect(quizTurnEntity!.payload).toMatchObject({ answerInputMode: "voice", transcriptEdited: true });
    // 语音作答元数据通过 stripPrivateExportFields：不含原始转写正文/置信度/Provider（§5.1 边界）。
    // transcriptEdited 是元数据布尔位，允许；asrConfidence/rawTranscript/asrProvider 才是被排除的原始转写。
    expect(quizTurnEntity!.payload).not.toHaveProperty("asrConfidence");
    expect(quizTurnEntity!.payload).not.toHaveProperty("rawTranscript");
    expect(quizTurnEntity!.payload).not.toHaveProperty("asrProvider");
    expect(quizTurnEntity!.payload).not.toHaveProperty("provider");
  });

  it("produces a different contentHash when answerInputMode changes (whole-object hashing)", async () => {
    const voice = await exportCloudSync(withCoach((turn) => { turn.answerInputMode = "voice"; }));
    const text = await exportCloudSync(withCoach((turn) => { turn.answerInputMode = "text"; }));
    const voiceHash = voice.entities.find((entity) => entity.entityType === "adaptive-quiz-turn")!.contentHash;
    const textHash = text.entities.find((entity) => entity.entityType === "adaptive-quiz-turn")!.contentHash;
    expect(voiceHash).not.toBe(textHash);
  });

  it("never emits voice-recall local-only entity types in a cloud export (privacy boundary)", async () => {
    const exported = await exportCloudSync(withCoach((turn) => {
      turn.answerInputMode = "voice";
      turn.transcriptEdited = true;
    }));
    const types = exported.entities.map((entity) => String(entity.entityType));
    expect(types).not.toContain("voice-recall-session");
    expect(types).not.toContain("voice-recall-turn");
    expect(types).not.toContain("voice-recall-local-history");
    expect(JSON.stringify(exported.entities)).not.toContain("voiceRecall");
  });

  it("round-trips answerInputMode through materialize without dropping it", async () => {
    const exported = await exportCloudSync(withCoach((turn) => {
      turn.answerInputMode = "voice";
      turn.transcriptEdited = true;
    }));
    const restored = materializeCloudSyncSnapshot(exported.entities, exported.reviewEvents, exported.assetBlobs);
    const [restoredTurn] = restored.payload.reviewCoach!.adaptiveQuizTurns;
    expect(restoredTurn.answerInputMode).toBe("voice");
    expect(restoredTurn.transcriptEdited).toBe(true);
  });
});
