import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import {
  openLearningCoachMigrationFixture,
  schema11MigrationFixture,
  schema16MigrationFixture,
  type LearningCoachMigrationFixture,
} from "../test/fixtures/learningCoachMigrationFixtures";
import { StudyJournalDatabase } from "./database";
import {
  REVIEW_COACH_SCHEMA_17_STORES,
  REVIEW_COACH_SCHEMA_18_STORES,
  REVIEW_COACH_SCHEMA_19_STORES,
  buildSchema17MigrationBackup,
  finalizeReviewCoachMigration,
  migrateToReviewCoachSchema17,
} from "./reviewCoachSchema";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const names = new Set<string>();

const createFixtureDatabase = async (fixtureSource: LearningCoachMigrationFixture) => {
  const fixture = openLearningCoachMigrationFixture(fixtureSource);
  const name = `review-coach-migration-${fixture.schemaVersion}-${crypto.randomUUID()}`;
  names.add(name);
  const legacy = new Dexie(name);
  legacy.version(fixture.schemaVersion).stores(fixture.stores);
  await legacy.open();
  await legacy.transaction("rw", legacy.tables, async () => {
    for (const [table, rows] of Object.entries(fixture.tables)) {
      await legacy.table(table).bulkPut(rows);
    }
  });
  legacy.close();
  return name;
};

afterEach(async () => {
  await Promise.all([...names].map((name) => Dexie.delete(name)));
  names.clear();
});

describe("StudyJournalDatabase review-coach migrations", () => {
  it("upgrades schema 11 without inventing block-level facts", async () => {
    const name = await createFixtureDatabase(schema11MigrationFixture);
    const database = new StudyJournalDatabase(name);

    await database.open();

    expect(database.verno).toBe(21);
    expect(database.tables.some((table) => table.name === "reviewAnnotationDrafts")).toBe(true);
    expect(await database.blocks.count()).toBe(1);
    expect(await database.recordReviewLogs.count()).toBe(1);
    expect(await database.decisionBlocks.count()).toBe(0);
    expect(await database.decisionBlockFeedback.count()).toBe(0);
    expect(await database.taskOutcomeEvents.count()).toBe(0);
    expect(database.tables.map((table) => table.name)).not.toContain("learningCoachSnapshots");
    expect(await database.coachMigrationBackups.get("schema-17")).toMatchObject({
      sourceVersion: 11,
      coreCounts: { blocks: 1, recordReviews: 1, recordReviewLogs: 1, studySessions: 1 },
    });
    database.close();
  });

  it("upgrades schema 16 while preserving only confirmed legacy facts in its checkpoint", async () => {
    const name = await createFixtureDatabase(schema16MigrationFixture);
    const database = new StudyJournalDatabase(name);

    await database.open();

    expect(database.verno).toBe(21);
    expect(await database.learningEvidence.count()).toBe(1);
    expect(await database.knowledgePoints.count()).toBe(2);
    expect(await database.recordKnowledgePointLinks.count()).toBe(1);
    expect(await database.knowledgeRelations.count()).toBe(1);
    expect(await database.decisionBlockStates.count()).toBe(0);
    expect(database.tables.map((table) => table.name)).not.toEqual(expect.arrayContaining([
      "learningCoachSettings",
      "learningCoachSnapshots",
      "learningCoachTasks",
      "learningCoachAiRuns",
      "knowledgePointExtractionRuns",
      "knowledgePointCoachSnapshots",
    ]));
    const checkpoint = await database.coachMigrationBackups.get("schema-17");
    expect(checkpoint).toMatchObject({
      sourceVersion: 16,
      legacyLearningEvidence: [{ id: "learning-evidence-confirmed-1" }],
      legacyKnowledgePoints: [{ id: "knowledge-point-bfs" }, { id: "knowledge-point-queue" }],
      legacyRecordKnowledgePointLinks: [{ id: "record-kp-link-confirmed-1" }],
      legacyKnowledgeRelations: [{ id: "knowledge-relation-confirmed-1" }],
      status: "completed",
      formalCounts: {
        legacyLearningEvidence: 1,
        legacyKnowledgePoints: 2,
        legacyRecordKnowledgePointLinks: 1,
        legacyKnowledgeRelations: 1,
      },
    });
    database.close();
  });

  it("rolls back the schema and data when the upgrade transaction fails", async () => {
    const name = await createFixtureDatabase(schema16MigrationFixture);
    const failing = new Dexie(name);
    failing.version(16).stores(schema16MigrationFixture.stores);
    failing.version(17).stores(REVIEW_COACH_SCHEMA_17_STORES).upgrade(async (transaction) => {
      await buildSchema17MigrationBackup(transaction);
      throw new Error("injected migration failure");
    });

    await expect(failing.open()).rejects.toThrow("injected migration failure");
    failing.close();

    const legacy = new Dexie(name);
    legacy.version(16).stores(schema16MigrationFixture.stores);
    await legacy.open();
    expect(legacy.verno).toBe(16);
    expect(await legacy.table("blocks").count()).toBe(1);
    expect(await legacy.table("knowledgeRelations").count()).toBe(1);
    expect(legacy.tables.map((table) => table.name)).not.toContain("decisionBlocks");
    legacy.close();
  });

  it("upgrades schema 17 so intervention and verification tasks can reuse one blueprint", async () => {
    const name = `review-coach-migration-17-${crypto.randomUUID()}`;
    names.add(name);
    const legacy = new Dexie(name);
    legacy.version(17).stores(REVIEW_COACH_SCHEMA_17_STORES);
    await legacy.open();
    await legacy.table("adaptiveReviewTasks").put({
      id: "intervention-task", blueprintId: "blueprint-1", decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1,
      status: "completed", priorityTier: "first-difficulty", queuedAt: "2026-09-01T08:00:00.000Z", endedAt: "2026-09-01T09:00:00.000Z",
      idempotencyKey: "intervention-task", createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-09-01T09:00:00.000Z",
    });
    legacy.close();

    const database = new StudyJournalDatabase(name);
    await database.open();
    await database.adaptiveReviewTasks.put({
      id: "verification-task", blueprintId: "blueprint-1", decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1,
      status: "waiting", priorityTier: "due-verification", queuedAt: "2026-09-07T08:00:00.000Z", openTargetKey: "block-1:1",
      idempotencyKey: "verification-task", createdAt: "2026-09-07T08:00:00.000Z", updatedAt: "2026-09-07T08:00:00.000Z",
    });

    expect(database.verno).toBe(21);
    expect(await database.adaptiveReviewTasks.where("blueprintId").equals("blueprint-1").count()).toBe(2);
    database.close();
  });

  it("rolls back final cleanup and retries it without losing confirmed facts", async () => {
    const name = await createFixtureDatabase(schema16MigrationFixture);
    const failing = new Dexie(name);
    failing.version(16).stores(schema16MigrationFixture.stores);
    failing.version(17).stores(REVIEW_COACH_SCHEMA_17_STORES).upgrade(migrateToReviewCoachSchema17);
    failing.version(18).stores(REVIEW_COACH_SCHEMA_18_STORES);
    failing.version(19).stores(REVIEW_COACH_SCHEMA_19_STORES).upgrade(async (transaction) => {
      await finalizeReviewCoachMigration(transaction);
      throw new Error("injected finalization failure");
    });

    await expect(failing.open()).rejects.toThrow("injected finalization failure");
    failing.close();

    const schema18 = new Dexie(name);
    schema18.version(16).stores(schema16MigrationFixture.stores);
    schema18.version(17).stores(REVIEW_COACH_SCHEMA_17_STORES).upgrade(migrateToReviewCoachSchema17);
    schema18.version(18).stores(REVIEW_COACH_SCHEMA_18_STORES);
    await schema18.open();
    expect(schema18.verno).toBe(18);
    expect(await schema18.table("learningCoachTasks").count()).toBe(1);
    expect(await schema18.table("coachMigrationBackups").get("schema-17")).toMatchObject({ status: "checkpointed" });
    schema18.close();

    const retried = new StudyJournalDatabase(name);
    await retried.open();
    expect(retried.verno).toBe(21);
    expect(await retried.learningEvidence.count()).toBe(1);
    expect(await retried.coachMigrationBackups.get("schema-17")).toMatchObject({ status: "completed" });
    retried.close();
  });

  it("upgrades to schema 21 and creates empty voice-recall local-only stores without touching formal data", async () => {
    const name = await createFixtureDatabase(schema16MigrationFixture);
    const database = new StudyJournalDatabase(name);
    await database.open();

    expect(database.verno).toBe(21);
    // 三张 local-only store 存在且迁移后为空（不自动从正式数据派生）。
    expect(database.tables.some((table) => table.name === "voiceRecallSessions")).toBe(true);
    expect(database.tables.some((table) => table.name === "voiceRecallTurns")).toBe(true);
    expect(database.tables.some((table) => table.name === "voiceRecallLocalHistory")).toBe(true);
    expect(await database.voiceRecallSessions.count()).toBe(0);
    expect(await database.voiceRecallTurns.count()).toBe(0);
    expect(await database.voiceRecallLocalHistory.count()).toBe(0);
    // 既有正式事实在 schema 21 迁移后保留（schema 21 只新增 store，不改既有数据）。
    expect(await database.learningEvidence.count()).toBe(1);
    expect(await database.knowledgePoints.count()).toBe(2);
    // schema 21 store 不得出现在云实体白名单（VOICE_RECALL_LOCAL_STORE_NAMES 仅 local-only）。
    const cloudEntityStores = ["aiSessions", "aiMessages", "entries", "blocks", "recordReviews", "recordReviewLogs",
      "decisionBlocks", "decisionBlockFeedback", "adaptiveReviewTasks", "adaptiveQuizTurns", "taskOutcomeEvents", "delayedVerifications"];
    expect(cloudEntityStores).not.toContain("voiceRecallSessions");
    expect(cloudEntityStores).not.toContain("voiceRecallTurns");
    expect(cloudEntityStores).not.toContain("voiceRecallLocalHistory");
    database.close();
  });

  it("writes a voice-recall session checkpoint without marking cloud mutation (local-only, §15.1)", async () => {
    const name = `voice-recall-local-${crypto.randomUUID()}`;
    names.add(name);
    const database = new StudyJournalDatabase(name);
    await database.open();
    await database.voiceRecallSessions.put({
      id: "voice-session-1", status: "active", updatedAt: "2026-09-08T10:00:00.000Z",
      sourceKind: "free-topic", startedAt: "2026-09-08T10:00:00.000Z",
    });
    await database.voiceRecallTurns.put({
      id: "voice-turn-1", sessionId: "voice-session-1", sequence: 1, status: "displayed",
      updatedAt: "2026-09-08T10:00:05.000Z",
    });
    await database.voiceRecallLocalHistory.put({
      id: "voice-history-1", savedAt: "2026-09-08T10:10:00.000Z", sourceKind: "free-topic",
      title: "比例原则复述", summary: "包含三个子原则", sourceRefs: [],
    });
    expect(await database.voiceRecallSessions.count()).toBe(1);
    expect(await database.voiceRecallTurns.count()).toBe(1);
    expect(await database.voiceRecallLocalHistory.count()).toBe(1);
    // local-only：迁移与写入不产生 cloudSyncMutation 记录。
    expect(await database.cloudSyncMutation.count()).toBe(0);
    database.close();
  });
});
