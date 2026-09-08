import { describe, expect, it, vi } from "vitest";

import type { AdaptiveQuizTurn, AdaptiveReviewTask, ReviewCoachFormalSnapshot, SessionBlueprint } from "./domain";
import { ReviewCoachOrchestrator } from "./orchestrator";
import type { ReviewCoachRepository } from "./repository";

const stamp = "2026-09-08T08:00:00.000Z";
const blueprint: SessionBlueprint = {
  id: "blueprint-1", batchId: "batch-1", decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1, status: "accepted", supportingDecisionBlockIds: [], feedbackIds: ["feedback-1"], interpretationIds: [], problemHypothesis: "boundary", hypothesisConfidence: 0.8, objective: "Use the correct boundary", completionCriteria: ["states invariant"], initialPracticeType: "variation", initialDifficulty: 2, expectedKeyPoints: ["invariant"], branches: [{ when: "correct", nextStrategy: "finish" }, { when: "partial", nextStrategy: "hint" }, { when: "incorrect", nextStrategy: "explain" }, { when: "skipped", nextStrategy: "prerequisite-check" }], allowedStrategies: ["finish", "hint", "explain", "prerequisite-check"], forbiddenScope: ["other"], evidence: [{ decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1, excerptHash: "hash-1", purpose: "source" }], maxTurns: 2, maxRetriesPerTurn: 1, maxEstimatedTokens: 2000, provider: "test", model: "mock", promptVersion: "p", policyVersion: "policy", schemaVersion: 1, idempotencyKey: "blueprint-key", createdAt: stamp, updatedAt: stamp,
};
const task: AdaptiveReviewTask = { id: "task-1", blueprintId: blueprint.id, decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1, status: "current", priorityTier: "first-difficulty", queuedAt: stamp, idempotencyKey: "task-key", createdAt: stamp, updatedAt: stamp };

const snapshot = (turns: AdaptiveQuizTurn[], currentTask: AdaptiveReviewTask = task): ReviewCoachFormalSnapshot => ({
  decisionBlocks: [{ id: "block-1", recordId: "record-1", contentVersion: 1, position: 0, createdAt: stamp, updatedAt: stamp, contentUpdatedAt: stamp }],
  decisionBlockArchives: [], decisionBlockFeedback: [{ id: "feedback-1", decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1, comment: "boundary", includeInAnalysis: true, source: "manual", occurredAt: stamp, idempotencyKey: "feedback-key", createdAt: stamp, updatedAt: stamp }], feedbackInterpretations: [], analysisQueueItems: [],
  analysisBatches: [{ id: "batch-1", status: "succeeded", inputRefs: [{ queueItemId: "queue-1", feedbackId: "feedback-1", decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1 }], subBatches: [{ id: "sub-1", inputRefs: [{ queueItemId: "queue-1", feedbackId: "feedback-1", decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1 }], status: "succeeded" }], model: "mock", provider: "test", promptVersion: "p", policyVersion: "policy", schemaVersion: 1, inputFingerprint: "fp", idempotencyKey: "batch-key", createdAt: stamp, updatedAt: stamp }],
  sessionBlueprints: [blueprint], adaptiveReviewTasks: [currentTask], adaptiveQuizTurns: turns, taskOutcomeEvents: [], delayedVerifications: [], aiRoleConfigs: [], legacyLearningEvidence: [], legacyKnowledgePoints: [], legacyRecordKnowledgePointLinks: [], legacyKnowledgeRelations: [],
});

const displayedTurn = (): AdaptiveQuizTurn => ({
  id: "turn-1", taskId: task.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: 1, sequence: 1, status: "displayed", practiceType: "variation", answerMode: "open", question: "Explain the boundary", displayedAt: stamp, sourceEvidence: blueprint.evidence, answerCriteria: ["states invariant"], hintsUsed: [], availableHints: [], qualityChecked: false, generationModel: "mock", promptVersion: "p", policyVersion: "policy", idempotencyKey: "turn-key", createdAt: stamp, updatedAt: stamp,
});

const makeOrchestrator = (turns: AdaptiveQuizTurn[], evaluation: { status: string; assessment?: string; matchedCriteria?: string[]; missingCriteria?: string[]; rationale?: string; missingInformation?: string[] }) => {
  let current = turns;
  const currentTask: AdaptiveReviewTask = { ...task, status: "in-progress" };
  const repository = {
    getFormalSnapshot: vi.fn(async () => snapshot(current, currentTask)),
    commitQuizAnswer: vi.fn(async (next: AdaptiveQuizTurn) => {
      current = [next];
      return next;
    }),
  } as unknown as ReviewCoachRepository;
  const orchestrator = new ReviewCoachOrchestrator({
    repository,
    ids: { next: () => "id-1" },
    clock: { now: () => stamp },
    aiGateway: { interpretFeedback: vi.fn(), planSession: vi.fn(), generateTurn: vi.fn(), reviewQuestion: vi.fn(), evaluateAnswer: vi.fn().mockResolvedValue(evaluation) },
  });
  return { orchestrator, repository, getTurns: () => current };
};

describe("Phase 5 voice answer formal fields (§5.1)", () => {
  it("propagates answerInputMode=voice and transcriptEdited onto the committed AdaptiveQuizTurn", async () => {
    const { orchestrator, repository } = makeOrchestrator([displayedTurn()], {
      status: "ok", assessment: "correct", matchedCriteria: ["states invariant"], missingCriteria: [], rationale: "states the invariant",
    });
    const result = await orchestrator.submitQuizAnswer({
      turnId: "turn-1", answerText: "right inclusive", provider: "test", model: "mock", promptVersion: "answer-v1", policyVersion: "policy", operationId: "op-1",
      answerInputMode: "voice", transcriptEdited: true,
    });
    expect(result.answerInputMode).toBe("voice");
    expect(result.transcriptEdited).toBe(true);
    expect(repository.commitQuizAnswer).toHaveBeenCalledWith(expect.objectContaining({ answerInputMode: "voice", transcriptEdited: true }), expect.anything());
  });

  it("text answers carry answerInputMode=text and omit transcriptEdited", async () => {
    const { orchestrator } = makeOrchestrator([displayedTurn()], {
      status: "ok", assessment: "correct", matchedCriteria: ["states invariant"], missingCriteria: [], rationale: "ok",
    });
    const result = await orchestrator.submitQuizAnswer({
      turnId: "turn-1", answerText: "right inclusive", provider: "test", model: "mock", promptVersion: "p", policyVersion: "policy", operationId: "op-2",
      answerInputMode: "text",
    });
    expect(result.answerInputMode).toBe("text");
    expect(result.transcriptEdited).toBeUndefined();
  });

  it("does not overwrite an already-answered turn (one formal answer per turn)", async () => {
    const answered = { ...displayedTurn(), status: "answered" as const, answerText: "first", answeredAt: stamp, assessment: "correct" as const, assessmentRationale: "ok", answerInputMode: "voice" as const };
    const { orchestrator } = makeOrchestrator([answered], { status: "ok", assessment: "correct", matchedCriteria: ["states invariant"], missingCriteria: [], rationale: "ok" });
    // 复提交：turn 已非 displayed → 抛错，原 voice 作答不被文字覆盖。
    await expect(orchestrator.submitQuizAnswer({
      turnId: "turn-1", answerText: "second via text", provider: "test", model: "mock", promptVersion: "p", policyVersion: "policy", operationId: "op-3",
      answerInputMode: "text",
    })).rejects.toThrow("已经失效");
  });

  it("leaves the turn displayed on insufficient-context; a later submit succeeds (idempotent re-submit)", async () => {
    // 第一次评估 insufficient-context：抛错，turn 不提交、仍 displayed。
    const insufficient = makeOrchestrator([displayedTurn()], { status: "insufficient-context", missingInformation: ["需要说明不变量"] });
    await expect(insufficient.orchestrator.submitQuizAnswer({
      turnId: "turn-1", answerText: "um", provider: "test", model: "mock", promptVersion: "p", policyVersion: "policy", operationId: "op-4",
      answerInputMode: "voice",
    })).rejects.toThrow("无法可靠判断");
    expect(insufficient.repository.commitQuizAnswer).not.toHaveBeenCalled();

    // 同一 displayed turn 可再次提交（幂等重提，§5.1）。
    const retry = makeOrchestrator([displayedTurn()], { status: "ok", assessment: "partial", matchedCriteria: ["states invariant"], missingCriteria: [], rationale: "partial" });
    const result = await retry.orchestrator.submitQuizAnswer({
      turnId: "turn-1", answerText: "right inclusive with invariant", provider: "test", model: "mock", promptVersion: "p", policyVersion: "policy", operationId: "op-5",
      answerInputMode: "voice", transcriptEdited: true,
    });
    expect(result.status).toBe("answered");
    expect(result.answerInputMode).toBe("voice");
  });

  it("omits answerInputMode when the caller does not supply it (backward compatible)", async () => {
    const { orchestrator } = makeOrchestrator([displayedTurn()], { status: "ok", assessment: "correct", matchedCriteria: ["states invariant"], missingCriteria: [], rationale: "ok" });
    const result = await orchestrator.submitQuizAnswer({
      turnId: "turn-1", answerText: "right inclusive", provider: "test", model: "mock", promptVersion: "p", policyVersion: "policy", operationId: "op-6",
    });
    expect(result.answerInputMode).toBeUndefined();
    expect(result.transcriptEdited).toBeUndefined();
  });
});
