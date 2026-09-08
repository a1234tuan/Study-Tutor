/**
 * 语音复述会话构造器（§5、§6 起始页落地用）。
 *
 * 从开始请求构造 VoiceRecallSessionLocal 检查点：写入 schema 21 local-only 表。
 * 边界：自由主题与资料范围会话默认 local-only；只有 Coach 任务绑定会话复用正式事实
 * （Phase 5）。本构造器只产出会话行与初始 checkpoint，不触碰正式事实。
 */

import type { VoiceCallConfig, VoiceRecallNavSource, VoiceRecallSessionLocal, VoiceRecallSourceKind } from "./domain";

export interface VoiceRecallSessionStartRequest {
  sessionId: string;
  sourceKind: VoiceRecallSourceKind;
  navSource?: VoiceRecallNavSource;
  config: VoiceCallConfig;
  /** 教材补充策略（§3.1）。自由主题默认 expand；范围会话默认 notes-only。 */
  knowledgePolicy?: VoiceCallConfig["defaultKnowledgePolicy"];
  startedAt: string;
}

export const buildVoiceRecallSession = (request: VoiceRecallSessionStartRequest): VoiceRecallSessionLocal => {
  const knowledgePolicy = request.knowledgePolicy ?? defaultKnowledgePolicyFor(request.sourceKind);
  return {
    id: request.sessionId,
    status: "active",
    updatedAt: request.startedAt,
    sourceKind: request.sourceKind,
    navSource: request.navSource,
    config: { ...request.config, defaultKnowledgePolicy: knowledgePolicy },
    checkpoint: {
      callState: "idle",
      userMuted: false,
      systemCaptureGate: false,
      inputMode: request.config.inputMode,
    },
    startedAt: request.startedAt,
  };
};

/** 自由主题默认 expand（允许教材补充，但须标注）；范围会话默认 notes-only（优先日志原文）。 */
const defaultKnowledgePolicyFor = (sourceKind: VoiceRecallSourceKind): VoiceCallConfig["defaultKnowledgePolicy"] =>
  sourceKind === "free-topic" ? "expand" : "notes-only";
