/**
 * 语音复述 Provider 选择与凭据状态（§12.2 配置抽象落地）。
 *
 * 设计方案 §12.2 冻结的配置同步边界：
 * - 内置模板是公开产品资源，以 templateId + version 标识，不依赖云同步。
 * - 用户选择的 ASR/LLM/TTS 档案、音色覆盖、自定义 endpoint 属于**非敏感**设备本地配置，
 *   这里用 localStorage 保存，不进入 Firebase / 备份 / 正式学习事实。
 * - 密钥、Token、App ID、签名材料由 storageAdapter 的 aiSecrets 表（device-local）保存，
 *   不进入此结构、不进入 ZIP / 流式备份 / 导出。
 *
 * 预览态（?preview=voice-stage3）与正式态共用同一份选择逻辑；预览里 storage 不可用时
 * 凭据读写降级为内存态，不阻断 UI 演示。
 */

import { VOICE_DEFAULT_REGISTRY, resolveAsrProfile, resolveTtsProfile } from "./voiceProviderTemplates";
import type { AsrProviderProfile, TtsProviderProfile } from "./domain";

const STORAGE_KEY = "voice-recall-provider-selection-v1";

export interface VoiceProviderSelection {
  /** 选中的 ASR 档案 id；默认取内置模板的 asrProfileId。 */
  asrProfileId: string;
  /** 选中的 LLM 档案 id；复用现有 AiProviderProfile，这里只登记 id。默认取模板值。 */
  llmProfileId: string;
  /** 选中的 TTS 档案 id；默认取内置模板的 ttsProfileId。 */
  ttsProfileId: string;
  /** 用户对 TTS 音色的覆盖；为空时用档案默认 voiceId。 */
  ttsVoiceIdOverride?: string;
}

const defaultSelection = (): VoiceProviderSelection => {
  const template = VOICE_DEFAULT_REGISTRY.template;
  return {
    asrProfileId: template.asrProfileId,
    llmProfileId: template.llmProfileId,
    ttsProfileId: template.ttsProfileId,
  };
};

const isBrowser = typeof window !== "undefined" && typeof window.localStorage !== "undefined";

/** 读取设备本机 Provider 选择；缺失或损坏时回退到内置模板默认。 */
export const getVoiceProviderSelection = (): VoiceProviderSelection => {
  if (!isBrowser) return defaultSelection();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSelection();
    const parsed = JSON.parse(raw) as Partial<VoiceProviderSelection>;
    const fallback = defaultSelection();
    return {
      asrProfileId: parsed.asrProfileId || fallback.asrProfileId,
      llmProfileId: parsed.llmProfileId || fallback.llmProfileId,
      ttsProfileId: parsed.ttsProfileId || fallback.ttsProfileId,
      ttsVoiceIdOverride: parsed.ttsVoiceIdOverride,
    };
  } catch {
    return defaultSelection();
  }
};

/** 保存设备本机 Provider 选择；只存非敏感的档案 id 与音色覆盖。 */
export const saveVoiceProviderSelection = (selection: VoiceProviderSelection): void => {
  if (!isBrowser) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // localStorage 不可用（隐私模式等）时静默降级，不影响通话本身。
  }
};

export interface VoiceProviderCredentialStatus {
  /** 是否存在可用凭据（本机密钥已配置）。 */
  configured: boolean;
  /** 归一化说明，不含密钥本体。 */
  hint: string;
}

/**
 * 读取某 Provider 的本机凭据状态（§6.2 通话前检查第 3 步）。
 * 只返回是否已配置与提示，绝不返回密钥本体。storage 不可用时降级为未配置。
 */
export const readCredentialStatus = async (
  profileId: string,
  profile: { providerName: string; requiresSecondary?: boolean },
): Promise<VoiceProviderCredentialStatus> => {
  try {
    const { storage } = await import("../../services/storageAdapter");
    const secret = await storage.getAiSecret?.(profileId);
    if (secret?.apiKey?.trim()) {
      return {
        configured: true,
        hint: profile.requiresSecondary
          ? `已配置 ${profile.providerName} 凭据（App ID + Access Token，仅存本机）`
          : `已配置 ${profile.providerName} API Key（仅存本机）`,
      };
    }
  } catch {
    /* 预览或 storage 未就绪：视为未配置 */
  }
  return {
    configured: false,
    hint: `${profile.providerName} 凭据未配置${profile.requiresSecondary ? "（需 App ID 与 Access Token）" : ""}`,
  };
};

/** 写入 Provider 本机凭据。豆包等双字段供应商用 apiKey=AppID、apiKeySecondary=AccessToken。 */
export const saveProviderCredential = async (
  profileId: string,
  apiKey: string,
  apiKeySecondary?: string,
): Promise<void> => {
  const { storage } = await import("../../services/storageAdapter");
  await storage.saveAiSecret?.(apiKey, profileId, apiKeySecondary);
};

/** 清除 Provider 本机凭据。 */
export const clearProviderCredential = async (profileId: string): Promise<void> => {
  const { storage } = await import("../../services/storageAdapter");
  await storage.clearAiSecret?.(profileId);
};

/** 解析当前选择对应的 ASR / TTS 档案（用于设置抽屉与起始页展示）。 */
export const resolveSelectedProfiles = (selection: VoiceProviderSelection): {
  asr?: AsrProviderProfile;
  tts?: TtsProviderProfile;
  llmProfileId: string;
} => ({
  asr: resolveAsrProfile(selection.asrProfileId),
  tts: resolveTtsProfile(selection.ttsProfileId),
  llmProfileId: selection.llmProfileId,
});
