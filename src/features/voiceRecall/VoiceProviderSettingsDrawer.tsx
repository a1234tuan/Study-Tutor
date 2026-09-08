/**
 * 语音复述 Provider 设置抽屉（§6.1 设置入口、§6.2 通话前检查、§12.2 配置抽象落地）。
 *
 * 起始页 header 的「设置」打开此抽屉。设计要点：
 * - 每个 Provider 一张友好卡：图标 + 友好名 + 一句用户语言的角色说明 + 配置状态药丸。
 * - 技术字段（endpoint、resourceId、transport、采样率、profile id、模板版本）默认折叠进
 *   <details className="voice-tech-details">，不堆在用户脸上（§6.2「用量与技术详情」边界）。
 * - LLM 复用现有 AiProviderProfile，不在此复制 DeepSeek Key；只展示绑定关系与跳转入口。
 * - 外发清单用大白话，不显示 stage/asr/llm/tts 内部标签。
 *
 * 视觉复用 APP 既有类（.ai-history-backdrop/.ai-history-drawer/.provider-profile-card/
 * .ai-image-mode-options/.settings-grid/.secret-input/.inline-section-header/.helper-text/
 * .status-message/.secondary-button/.icon-button.danger），无内联 <style>。
 * 凭据读写走 storageAdapter.aiSecrets（device-local，不进备份/导出）；预览态 storage 不可用
 * 时降级为「未配置」，不阻断 UI。所有错误经 src/lib/uiError.ts（voice-recall）。
 */

import { useCallback, useEffect, useState } from "react";
import { Bot, Eye, EyeOff, Headphones, KeyRound, Mic, Save, Shield, Trash2, X } from "lucide-react";
import { BUILTIN_ASR_PROFILES, BUILTIN_TTS_PROFILES, VOICE_DEFAULT_REGISTRY } from "./voiceProviderTemplates";
import {
  clearProviderCredential,
  getVoiceProviderSelection,
  readCredentialStatus,
  saveProviderCredential,
  saveVoiceProviderSelection,
  type VoiceProviderCredentialStatus,
  type VoiceProviderSelection,
} from "./voiceProviderSelection";
import { formatUiError } from "../../lib/uiError";
import type { AsrProviderProfile, TtsProviderProfile } from "./domain";

export interface VoiceProviderSettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  onSelectionChanged?: () => void;
}

/** 豆包 ASR 需 App ID + Access Token 双字段；阿里云只需 API Key。 */
const asrNeedsSecondary = (profile: AsrProviderProfile): boolean => profile.providerId === "doubao";
const ttsNeedsCredential = (profile: TtsProviderProfile): boolean => profile.providerId !== "system";

const EGRESS_ROWS: Array<{ icon: typeof Mic; label: string; detail: string }> = [
  { icon: Mic, label: "你说话的音频", detail: "发给语音识别服务转成文字。" },
  { icon: Bot, label: "你的日志和回答", detail: "发给教学模型出题、追问和讲解。" },
  { icon: Headphones, label: "老师的回复文本", detail: "发给语音合成读给你听。" },
];

export const VoiceProviderSettingsDrawer = ({ open, onClose, onSelectionChanged }: VoiceProviderSettingsDrawerProps) => {
  const [selection, setSelection] = useState<VoiceProviderSelection>(() => getVoiceProviderSelection());
  const [asrKeys, setAsrKeys] = useState<{ primary: string; secondary: string }>({ primary: "", secondary: "" });
  const [ttsKey, setTtsKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [asrStatus, setAsrStatus] = useState<VoiceProviderCredentialStatus | null>(null);
  const [ttsStatus, setTtsStatus] = useState<VoiceProviderCredentialStatus | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedAsr = BUILTIN_ASR_PROFILES.find((p) => p.id === selection.asrProfileId);
  const selectedTts = BUILTIN_TTS_PROFILES.find((p) => p.id === selection.ttsProfileId);

  const refreshStatus = useCallback(async () => {
    if (!selectedAsr) {
      setAsrStatus({ configured: false, hint: "未选择识别服务。" });
    } else {
      setAsrStatus(await readCredentialStatus(selectedAsr.id, {
        providerName: selectedAsr.providerName,
        requiresSecondary: asrNeedsSecondary(selectedAsr),
      }));
    }
    if (!selectedTts) {
      setTtsStatus({ configured: false, hint: "未选择语音合成。" });
    } else if (!ttsNeedsCredential(selectedTts)) {
      setTtsStatus({ configured: true, hint: "系统语音合成离线兜底，无需凭据。" });
    } else {
      setTtsStatus(await readCredentialStatus(selectedTts.id, { providerName: selectedTts.providerName }));
    }
  }, [selectedAsr, selectedTts]);

  useEffect(() => {
    if (!open) return;
    setSelection(getVoiceProviderSelection());
    setAsrKeys({ primary: "", secondary: "" });
    setTtsKey("");
    setMessage("");
    void refreshStatus();
  }, [open, refreshStatus]);

  if (!open) return null;

  const persistSelection = (next: VoiceProviderSelection) => {
    setSelection(next);
    saveVoiceProviderSelection(next);
    onSelectionChanged?.();
  };

  const saveAsrCredential = async () => {
    if (!selectedAsr) return;
    setMessage("");
    setBusy(true);
    try {
      const primary = asrKeys.primary.trim();
      if (!primary) { setMessage("请填写主凭据后再保存。"); return; }
      const secondary = asrNeedsSecondary(selectedAsr) ? asrKeys.secondary.trim() : undefined;
      if (asrNeedsSecondary(selectedAsr) && !secondary) {
        setMessage("豆包识别需要同时填写 App ID 与 Access Token。");
        return;
      }
      await saveProviderCredential(selectedAsr.id, primary, secondary);
      setAsrKeys({ primary: "", secondary: "" });
      await refreshStatus();
      setMessage(`已保存 ${selectedAsr.providerName} 凭据到本机，不进入备份或云同步。`);
    } catch (e) {
      setMessage(formatUiError(e, "voice-recall"));
    } finally {
      setBusy(false);
    }
  };

  const removeAsrCredential = async () => {
    if (!selectedAsr) return;
    setBusy(true);
    try {
      await clearProviderCredential(selectedAsr.id);
      setAsrKeys({ primary: "", secondary: "" });
      await refreshStatus();
      setMessage(`已从本机清除 ${selectedAsr.providerName} 凭据。`);
    } catch (e) {
      setMessage(formatUiError(e, "voice-recall"));
    } finally {
      setBusy(false);
    }
  };

  const saveTtsCredential = async () => {
    if (!selectedTts) return;
    setMessage("");
    setBusy(true);
    try {
      const key = ttsKey.trim();
      if (!key) { setMessage("请填写 API Key 后再保存。"); return; }
      await saveProviderCredential(selectedTts.id, key);
      setTtsKey("");
      await refreshStatus();
      setMessage(`已保存 ${selectedTts.providerName} API Key 到本机。`);
    } catch (e) {
      setMessage(formatUiError(e, "voice-recall"));
    } finally {
      setBusy(false);
    }
  };

  const removeTtsCredential = async () => {
    if (!selectedTts) return;
    setBusy(true);
    try {
      await clearProviderCredential(selectedTts.id);
      setTtsKey("");
      await refreshStatus();
      setMessage(`已从本机清除 ${selectedTts.providerName} 凭据。`);
    } catch (e) {
      setMessage(formatUiError(e, "voice-recall"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-history-backdrop" onClick={onClose}>
      <aside
        className="ai-history-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="语音 Provider 设置"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow">Voice providers</p>
            <h2>语音 Provider 设置</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="ai-history-list">
          {/* ASR */}
          <article className="surface-card">
            <header className="inline-section-header">
              <div>
                <h3><Mic size={16} /> 语音识别（ASR）</h3>
                <p>把你说的转成文字。</p>
              </div>
              {asrStatus && (
                <span className={`voice-status-pill ${asrStatus.configured ? "ok" : "warn"}`}>
                  {asrStatus.configured ? "已配置" : "未配置"}
                </span>
              )}
            </header>

            <div className="ai-image-mode-options">
              {BUILTIN_ASR_PROFILES.map((profile) => {
              const active = profile.id === selection.asrProfileId;
              return (
                <label key={profile.id} className={active ? "active" : ""}>
                  <input
                    type="radio"
                    name="voice-asr"
                    value={profile.id}
                    checked={active}
                    onChange={() => persistSelection({ ...selection, asrProfileId: profile.id })}
                  />
                  <span>
                    <strong>{profile.providerName}</strong>
                    <small>{profile.providerId === "doubao" ? "需 App ID + Access Token" : "需 API Key"}</small>
                  </span>
                </label>
              );
            })}
            </div>

            {selectedAsr && (
              <div className="settings-grid" style={{ marginTop: 12 }}>
                <label style={{ gridColumn: "1 / -1" }}>
                  {asrNeedsSecondary(selectedAsr) ? "豆包应用凭证" : "API Key"}
                  <span className="secret-input">
                    <input
                      value={asrKeys.primary}
                      type={showKey ? "text" : "password"}
                      onChange={(e) => setAsrKeys((c) => ({ ...c, primary: e.target.value }))}
                      placeholder={asrNeedsSecondary(selectedAsr) ? "App ID（火山引擎控制台）" : "sk-... / dashscope key"}
                    />
                    <button type="button" onClick={() => setShowKey((v) => !v)} aria-label="切换密钥显示">
                      {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </span>
                </label>
                {asrNeedsSecondary(selectedAsr) && (
                  <label style={{ gridColumn: "1 / -1" }}>
                    Access Token
                    <span className="secret-input">
                      <input
                        value={asrKeys.secondary}
                        type={showKey ? "text" : "password"}
                        onChange={(e) => setAsrKeys((c) => ({ ...c, secondary: e.target.value }))}
                        placeholder="Access Token（与 App ID 同一控制台）"
                      />
                    </span>
                  </label>
                )}
                <div className="provider-template-row" style={{ gridColumn: "1 / -1" }}>
                  <button type="button" className="secondary-button" onClick={() => void saveAsrCredential()} disabled={busy}>
                    <Save size={16} /> 保存凭据
                  </button>
                  {asrStatus?.configured && (
                    <button type="button" className="icon-button danger" onClick={() => void removeAsrCredential()} disabled={busy} aria-label="清除凭据">
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </div>
            )}
            {asrStatus && <p className="helper-text">{asrStatus.hint}</p>}

            {selectedAsr && (
              <details className="voice-tech-details">
                <summary>技术详情</summary>
                <dl>
                  <dt>传输协议</dt><dd>{selectedAsr.transport}</dd>
                  <dt>端点</dt><dd>{selectedAsr.endpoint}</dd>
                  {selectedAsr.model && <><dt>模型</dt><dd>{selectedAsr.model}</dd></>}
                  {selectedAsr.resourceId && <><dt>资源 ID</dt><dd>{selectedAsr.resourceId}</dd></>}
                  <dt>采样率</dt><dd>{selectedAsr.acceptedSampleRates.join(", ")} Hz</dd>
                  <dt>档案 ID</dt><dd>{selectedAsr.id}</dd>
                </dl>
              </details>
            )}
          </article>

          {/* LLM */}
          <article className="surface-card">
            <header className="inline-section-header">
              <div>
                <h3><Bot size={16} /> 教学模型（LLM）</h3>
                <p>出题、追问和讲解的老师。</p>
              </div>
              <span className="voice-status-pill info">复用 AI 设置</span>
            </header>
            <p className="helper-text">
              语音链复用「更多 → AI 设置」里已配好的供应商档案（DeepSeek 或 OpenAI 兼容中转 API），不在此重复填写密钥，避免泄漏面扩大。
            </p>
            <div className="provider-template-row">
              <button type="button" className="secondary-button" disabled title="预览态不可跳转；正式态进入更多 → AI 设置">
                前往 AI 设置
              </button>
            </div>
            <details className="voice-tech-details">
              <summary>技术详情</summary>
              <dl>
                <dt>绑定档案</dt><dd>{selection.llmProfileId}</dd>
                <dt>流式协议</dt><dd>DeepSeek SSE（Phase 2 接入）</dd>
                <dt>模板版本</dt><dd>{VOICE_DEFAULT_REGISTRY.template.templateId}@{VOICE_DEFAULT_REGISTRY.template.version}</dd>
              </dl>
            </details>
          </article>

          {/* TTS */}
          <article className="surface-card">
            <header className="inline-section-header">
              <div>
                <h3><Headphones size={16} /> 语音合成（TTS）</h3>
                <p>把老师的回答读给你听。</p>
              </div>
              {ttsStatus && (
                <span className={`voice-status-pill ${ttsStatus.configured ? "ok" : "warn"}`}>
                  {ttsStatus.configured ? "已配置" : "未配置"}
                </span>
              )}
            </header>

            <div className="ai-image-mode-options">
              {BUILTIN_TTS_PROFILES.map((profile) => {
              const active = profile.id === selection.ttsProfileId;
              return (
                <label key={profile.id} className={active ? "active" : ""}>
                  <input
                    type="radio"
                    name="voice-tts"
                    value={profile.id}
                    checked={active}
                    onChange={() => persistSelection({ ...selection, ttsProfileId: profile.id })}
                  />
                  <span>
                    <strong>{profile.providerName}</strong>
                    <small>{ttsNeedsCredential(profile) ? "需 API Key" : "离线兜底，无需凭据"}</small>
                  </span>
                </label>
              );
            })}
            </div>

            {selectedTts && (
              <div className="settings-grid" style={{ marginTop: 12 }}>
                <label style={{ gridColumn: "1 / -1" }}>
                  音色
                  <input
                    value={selection.ttsVoiceIdOverride ?? ""}
                    onChange={(e) => persistSelection({ ...selection, ttsVoiceIdOverride: e.target.value.trim() || undefined })}
                    placeholder={selectedTts.voiceId ? `默认：${selectedTts.voiceId}` : "使用档案默认音色"}
                  />
                  <small style={{ color: "var(--color-muted)" }}>留空使用档案默认音色。该选择保存在本机，不进云同步。</small>
                </label>
                {ttsNeedsCredential(selectedTts) && (
                  <label style={{ gridColumn: "1 / -1" }}>
                    API Key
                    <span className="secret-input">
                      <input
                        value={ttsKey}
                        type={showKey ? "text" : "password"}
                        onChange={(e) => setTtsKey(e.target.value)}
                        placeholder="Fish Audio API Key"
                      />
                      <button type="button" onClick={() => setShowKey((v) => !v)} aria-label="切换密钥显示">
                        {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
                      </button>
                    </span>
                  </label>
                )}
                {ttsNeedsCredential(selectedTts) && (
                  <div className="provider-template-row" style={{ gridColumn: "1 / -1" }}>
                    <button type="button" className="secondary-button" onClick={() => void saveTtsCredential()} disabled={busy}>
                      <Save size={16} /> 保存凭据
                    </button>
                    {ttsStatus?.configured && (
                      <button type="button" className="icon-button danger" onClick={() => void removeTtsCredential()} disabled={busy} aria-label="清除凭据">
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            {ttsStatus && <p className="helper-text">{ttsStatus.hint}</p>}

            {selectedTts && (
              <details className="voice-tech-details">
                <summary>技术详情</summary>
                <dl>
                  <dt>传输协议</dt><dd>{selectedTts.transport}</dd>
                  <dt>端点</dt><dd>{selectedTts.endpoint}</dd>
                  {selectedTts.model && <><dt>模型</dt><dd>{selectedTts.model}</dd></>}
                  {selectedTts.voiceId && <><dt>默认音色</dt><dd>{selectedTts.voiceId}</dd></>}
                  <dt>档案 ID</dt><dd>{selectedTts.id}</dd>
                </dl>
              </details>
            )}
          </article>

          {/* 外发清单 */}
          <article className="surface-card">
            <header className="inline-section-header">
              <div>
                <h3><Shield size={16} /> 内容外发清单</h3>
                <p>开始通话前确认：以下内容会发送给对应服务。</p>
              </div>
            </header>
            <div className="voice-egress-list">
              {EGRESS_ROWS.map((row) => {
                const Icon = row.icon;
                const status = row.icon === Mic ? asrStatus : row.icon === Headphones ? ttsStatus : null;
                return (
                  <div className="voice-egress-row" key={row.label}>
                    <div>
                      <strong><Icon size={15} /> {row.label}</strong>
                      <small>{row.detail}</small>
                    </div>
                    {row.icon === Bot ? (
                      <span className="voice-status-pill info">复用 AI 设置</span>
                    ) : status?.configured ? (
                      <span className="voice-status-pill ok">已配置</span>
                    ) : (
                      <span className="voice-status-pill warn">未配置</span>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="helper-text">
              <KeyRound size={13} /> 凭据、Token、App ID 仅存本机密钥引用，不进入备份、云同步或导出；真实接口连通测试为 Phase 2，此处只查凭据是否已配置。
            </p>
          </article>

          {message && <p className="status-message">{message}</p>}
        </div>
      </aside>
    </div>
  );
};
