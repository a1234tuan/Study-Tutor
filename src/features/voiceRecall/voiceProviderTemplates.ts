/**
 * 版本化内置 Provider 模板与档案（§12.1、§12.2）。
 *
 * voice-default-cn@1：中文默认模板，status:"candidate"——凭据不验证前不标 verified，
 * 不写入正式发布通道。ASR/TTS 真接入待用户提供凭据后补做（Gate 1 之后）。
 *
 * 安全约束：模板与档案只存型号/端点/能力声明，绝不存 Token/AppID/Secret/签名材料；
 * 密钥由本机密钥引用在会话期注入 adapter 实例，会话结束丢弃（见 deepSeekLlmStreamAdapter）。
 */

import type { AsrProviderProfile, TtsProviderProfile, VoiceProviderTemplate } from "./domain";

export const VOICE_DEFAULT_CN_TEMPLATE: VoiceProviderTemplate = {
  templateId: "voice-default-cn",
  version: 1,
  status: "candidate",
  minimumAppVersion: "1.0.0",
  asrProfileId: "doubao-asr-cn",
  llmProfileId: "deepseek-llm-cn",
  ttsProfileId: "fish-audio-tts-cn",
};

/** 内置 ASR 档案。豆包（websocket，16kHz PCM）；阿里云（websocket）。真接入待凭据。 */
export const BUILTIN_ASR_PROFILES: AsrProviderProfile[] = [
  {
    id: "doubao-asr-cn",
    providerId: "doubao",
    providerName: "豆包实时语音识别",
    endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
    transport: "websocket",
    resourceId: "volc.bigasr.sauc.duration",
    language: "zh-CN",
    acceptedSampleRates: [16000],
    acceptedFormats: ["pcm-s16le"],
    punctuation: true,
    inverseTextNormalization: true,
  },
  {
    id: "aliyun-asr-cn",
    providerId: "aliyun-bailian",
    providerName: "阿里云百炼实时语音识别",
    endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    transport: "websocket",
    model: "paraformer-realtime-v2",
    language: "zh-CN",
    acceptedSampleRates: [16000],
    acceptedFormats: ["pcm-s16le"],
    punctuation: true,
    inverseTextNormalization: true,
  },
];

/** 内置 TTS 档案。Fish Audio（http-stream）；豆包/系统 TTS 备选。真接入待凭据。 */
export const BUILTIN_TTS_PROFILES: TtsProviderProfile[] = [
  {
    id: "fish-audio-tts-cn",
    providerId: "fish-audio",
    providerName: "Fish Audio 流式语音合成",
    endpoint: "https://api.fish.audio/v1/tts",
    transport: "http-stream",
    model: "fish-speech-1.5",
    voiceId: "default-cn-female",
    acceptedSampleRates: [24000, 16000],
    acceptedFormats: ["pcm-s16le", "opus"],
    speedRange: { min: 0.8, max: 1.2 },
  },
  {
    id: "system-tts-cn",
    providerId: "system",
    providerName: "系统 TTS（离线兜底）",
    endpoint: "local://system-tts",
    transport: "native-sdk",
    acceptedSampleRates: [24000],
    acceptedFormats: ["pcm-s16le"],
    speedRange: { min: 0.75, max: 1.5 },
  },
];

export interface VoiceProviderRegistry {
  template: VoiceProviderTemplate;
  asrProfiles: ReadonlyMap<string, AsrProviderProfile>;
  ttsProfiles: ReadonlyMap<string, TtsProviderProfile>;
  /** LLM profileId → AiProviderProfile 由现有 aiProviders.ts 提供，此处只登记 id。 */
  llmProfileIds: readonly string[];
}

const indexAsr = new Map(BUILTIN_ASR_PROFILES.map((profile) => [profile.id, profile]));
const indexTts = new Map(BUILTIN_TTS_PROFILES.map((profile) => [profile.id, profile]));

export const VOICE_DEFAULT_REGISTRY: VoiceProviderRegistry = {
  template: VOICE_DEFAULT_CN_TEMPLATE,
  asrProfiles: indexAsr,
  ttsProfiles: indexTts,
  llmProfileIds: ["deepseek-llm-cn"],
};

export const resolveAsrProfile = (id: string): AsrProviderProfile | undefined =>
  indexAsr.get(id);

export const resolveTtsProfile = (id: string): TtsProviderProfile | undefined =>
  indexTts.get(id);
