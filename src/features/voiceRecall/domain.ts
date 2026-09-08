/**
 * 语音复述领域类型与边界冻结（v1.0 设计方案 §5–§15）。
 *
 * 本文件只定义类型与常量，不持有可变运行态。运行态由 Phase 1 的
 * VoiceRecallRuntimeController 持有；可恢复检查点写入 schema 21 local-only 表。
 *
 * 边界约束（来自 docs/realtime-voice-recall-design.md）：
 * - 原始音频、ASR partial、TTS 音频分片、Provider 原始响应与密钥永不参与云同步。
 * - 自由主题与资料范围会话默认 local-only；只有 Coach 任务复用现有正式事实。
 * - Coach 第一版严格一题一正式回答；提交后追问创建 sequence 递增的新 AdaptiveQuizTurn。
 */

import type { EntityId, ISODate } from "../../types";

/** 通话主状态（§14）。旁路状态见 {@link VoiceCallBypassState}。 */
export type VoiceCallMainState =
  | "idle"
  | "preflight"
  | "connecting"
  | "listening"
  | "finalizing-asr"
  | "thinking"
  | "speaking";

/** 旁路状态（§14）。静音不作为混合旁路状态，而是正交的 userMuted / systemCaptureGate。 */
export type VoiceCallBypassState = "paused" | "reconnecting" | "ending" | "failed";

export type VoiceCallState = VoiceCallMainState | VoiceCallBypassState;

/** 三种互斥输入模式（§8.1）。通话中只允许在暂停状态切换。 */
export type InputMode = "auto-half-duplex" | "push-to-talk" | "tap-to-record";

/** 三类会话来源（§5）。task-bound 复用 Coach 正式事实；其余两类默认 local-only。 */
export type VoiceRecallSourceKind = "task-bound" | "scope-practice" | "free-topic";

/** 知识边界策略（§3.1）。补充内容不能伪装成日志原文。 */
export type KnowledgePolicy = "notes-plus" | "notes-only" | "expand";

/** 本机通话历史不进入云同步、备份或正式学习事实。 */
export type VoiceRecallSessionStatus =
  | "active"
  | "paused"
  | "interrupted"
  | "ended"
  | "expired";

export type VoiceRecallTurnStatus =
  | "displayed"
  | "listening"
  | "finalizing"
  | "answered"
  | "abandoned";

/** 转写整理 LLM 预处理结构化结果（§10）。 */
export interface TranscriptCleanupResult {
  cleanText: string;
  uncertainSpans: string[];
  meaningRisk: "low" | "medium" | "high";
}

/** Provider 适配层传输能力声明（§12.2）。协议无关：SSE/WebSocket/HTTP chunked/native SDK 由适配层选择。 */
export type VoiceTransport = "websocket" | "sse" | "http-stream" | "native-sdk";

export type VoiceAsrProviderId = "doubao" | "aliyun-bailian" | "openai-compatible" | "custom";
export type VoiceTtsProviderId = "fish-audio" | "doubao" | "aliyun-bailian" | "openai-compatible" | "system" | "custom";

export type VoiceAudioFormat = "pcm-s16le" | "opus" | "aac" | "provider-native";

/** 版本化内置模板（§12.1）。凭据不入模板；型号/音色/额度在 Phase 2 验证后才标 verified。 */
export interface VoiceProviderTemplate {
  templateId: string;
  version: number;
  status: "candidate" | "verified" | "deprecated";
  verifiedAt?: string;
  minimumAppVersion: string;
  asrProfileId: string;
  llmProfileId: string;
  ttsProfileId: string;
}

/** ASR Provider 配置档案（§12.2）。LLM 复用现有 AiProviderProfile，不复制 DeepSeek Key。 */
export interface AsrProviderProfile {
  id: string;
  providerId: VoiceAsrProviderId;
  providerName: string;
  endpoint: string;
  transport: VoiceTransport;
  model?: string;
  resourceId?: string;
  language: string;
  acceptedSampleRates: number[];
  acceptedFormats: VoiceAudioFormat[];
  punctuation: boolean;
  inverseTextNormalization: boolean;
}

/** TTS Provider 配置档案（§12.2）。凭据不入档案；型号/音色在 Phase 2 验证后才标 verified。 */
export interface TtsProviderProfile {
  id: string;
  providerId: VoiceTtsProviderId;
  providerName: string;
  endpoint: string;
  transport: VoiceTransport;
  model?: string;
  voiceId?: string;
  acceptedSampleRates: number[];
  acceptedFormats: VoiceAudioFormat[];
  speedRange: { min: number; max: number };
}

/** 通话级配置（§12.2）。密钥、Token、自定义 endpoint 保持 device-local，不进此结构。 */
export interface VoiceCallConfig {
  templateRef?: { templateId: string; version: number };
  asrProviderId: string;
  llmProviderId: string;
  ttsProviderId: string;
  inputMode: InputMode;
  maxSessionMinutes: number;
  defaultKnowledgePolicy: KnowledgePolicy;
}

/** 轻量导航来源身份（§4.3）。只存来源页/筛选/当前卡片 ID，不存会话正文。 */
export interface VoiceRecallNavSource {
  origin: "review-home" | "record-detail" | "review-card" | "coach-task" | "today";
  recordId?: string;
  reviewCardId?: string;
  coachTaskId?: string;
  filterSnapshot?: unknown;
}

/** 结构化会话记忆（§11.2）。摘要更新必须可校验，不能覆盖正式作答事实。 */
export interface VoiceRecallSessionMemory {
  learningGoal: string;
  sourceRangeLabel: string;
  answeredKeyPoints: string[];
  confirmedConclusions: string[];
  pendingMisconceptions: string[];
  hintsUsed: string[];
  uncoveredBlueprintCriteria: string[];
  revisitTopics: string[];
  nextQuestionIntent: string;
}

/** schema 21 local-only 会话检查点（§15.1）。不加入 CloudSyncEntityType。 */
export interface VoiceRecallSessionLocal {
  id: string;
  status: VoiceRecallSessionStatus;
  updatedAt: string;
  sourceKind: VoiceRecallSourceKind;
  navSource?: VoiceRecallNavSource;
  config?: VoiceCallConfig;
  templateSnapshot?: { templateId: string; version: number; status: string };
  memory?: VoiceRecallSessionMemory;
  checkpoint?: {
    callState: VoiceCallState;
    userMuted: boolean;
    systemCaptureGate: boolean;
    inputMode: InputMode;
    activeTurnId?: string;
  };
  sourceUnavailable?: boolean;
  startedAt: string;
  endedAt?: string;
}

/** schema 21 local-only 轮次数据（§15.1）。ASR Provider/模型/置信度/原始转写只存此处。 */
export interface VoiceRecallTurnLocal {
  id: string;
  sessionId: string;
  sequence: number;
  status: VoiceRecallTurnStatus;
  updatedAt: string;
  questionText?: string;
  transcriptFinal?: string;
  cleanText?: string;
  cleanup?: TranscriptCleanupResult;
  transcriptEdited?: boolean;
  playbackCompletedRange?: { startTurn: number; endTurn: number };
  errorState?: { code: string; diagnosticId: string };
}

/** schema 21 local-only 主动保留历史（§15.1）。不保存原始音频/完整逐字稿/Provider 原始响应。 */
export interface VoiceRecallLocalHistory {
  id: string;
  savedAt: string;
  sourceKind: VoiceRecallSourceKind;
  title: string;
  summary: string;
  sourceRefs: Array<{ kind: "record" | "coach-task" | "free-topic"; id?: string; label: string }>;
  estimatedUsage?: {
    captureSeconds: number;
    asrSeconds: number;
    llmTokens: number;
    ttsCharacters: number;
    costTier: "low" | "medium" | "high";
  };
}

/** Phase 5 才真接入 Coach 正式字段（§5.1）。此处先冻结类型，不修改 AdaptiveQuizTurn。 */
export type AnswerInputMode = "voice" | "text";

export interface VoiceAnswerFormalFields {
  answerInputMode?: AnswerInputMode;
  transcriptEdited?: boolean;
}

/** 分层取消（§13.2）：会话/活动轮次/单请求。 */
export type AbortScope = "session" | "turn" | "request";

/** 幂等键（§14）：sessionId + turnId + operationId。 */
export interface VoiceIdempotencyKey {
  sessionId: string;
  turnId: string;
  operationId: string;
}

export const VOICE_RECALL_SCHEMA_VERSION = 21;

export const VOICE_RECALL_LOCAL_STORE_NAMES = [
  "voiceRecallSessions",
  "voiceRecallTurns",
  "voiceRecallLocalHistory",
] as const;

/** 这些 store 不加入 CloudSyncEntityType，不进入 Firebase/ZIP/流式/native backup/导出/记录转移。 */
export const VOICE_RECALL_LOCAL_ONLY_NOTE =
  "voiceRecallSessions/voiceRecallTurns/voiceRecallLocalHistory are local-only; never added to CloudSyncEntityType, backup, export, or record transfer. Writes must not mark cloud mutation.";

export type { EntityId, ISODate };
