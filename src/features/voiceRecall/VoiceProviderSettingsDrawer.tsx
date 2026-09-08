/**
 * 语音复述 Provider 设置抽屉（§6.1 设置入口、§6.2 通话前检查、§12.2 配置抽象落地）。
 *
 * 设计方案要求起始页 header 提供「设置入口」，用户可在此：
 * - 选择 ASR / TTS 档案（设备本机，非敏感，localStorage 保存，不进云同步/备份）。
 * - 填写 Provider 凭据（本机密钥引用，storageAdapter 的 aiSecrets 表，不进 ZIP/流式备份/导出）。
 * - 查看当前 LLM 档案——LLM 复用现有 AiProviderProfile，不复制 DeepSeek Key，
 *   因此这里只展示绑定关系与跳转提示，编辑入口在「更多 → AI 设置」。
 * - 查看§6.2 内容外发清单与各 Provider 配置状态（真连通测试为 Phase 2，此处只查凭据是否存在）。
 *
 * 错误统一经 src/lib/uiError.ts（context voice-recall）。预览态 storage 不可用时凭据读写降级为内存态。
 */

import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, RefreshCw, Save, Shield, Trash2, X } from "lucide-react";
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
  /** 选择变化时回调，供起始页刷新展示。 */
  onSelectionChanged?: () => void;
}

/** 豆包 ASR 需要 App ID + Access Token 双字段；阿里云只需 API Key。 */
const asrNeedsSecondary = (profile: AsrProviderProfile): boolean => profile.providerId === "doubao";

/** 系统TTS / Fish Audio 是否需要凭据。系统 TTS 离线兜底，不需要。 */
const ttsNeedsCredential = (profile: TtsProviderProfile): boolean => profile.providerId !== "system";

const EGRESS_LIST: Array<{ stage: "asr" | "llm" | "tts"; label: string; detail: string }> = [
  { stage: "asr", label: "麦克风音频 → ASR", detail: "本机采集的 PCM 帧发送给 ASR Provider 转写。" },
  { stage: "llm", label: "日志片段 + 转写 → LLM", detail: "选定的日志范围与确认后的转写文本发送给 LLM 生成教学回应。" },
  { stage: "tts", label: "教师文本 → TTS", detail: "LLM 生成的口语化回应文本发送给 TTS 合成播放。" },
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

  const template = VOICE_DEFAULT_REGISTRY.template;
  const selectedAsr = BUILTIN_ASR_PROFILES.find((p) => p.id === selection.asrProfileId);
  const selectedTts = BUILTIN_TTS_PROFILES.find((p) => p.id === selection.ttsProfileId);

  const refreshStatus = useCallback(async () => {
    if (!selectedAsr) {
      setAsrStatus({ configured: false, hint: "未选择 ASR 档案" });
    } else {
      setAsrStatus(await readCredentialStatus(selectedAsr.id, {
        providerName: selectedAsr.providerName,
        requiresSecondary: asrNeedsSecondary(selectedAsr),
      }));
    }
    if (!selectedTts || !ttsNeedsCredential(selectedTts)) {
      setTtsStatus({ configured: !selectedTts ? false : !ttsNeedsCredential(selectedTts), hint: selectedTts ? "系统 TTS 离线兜底，无需凭据。" : "未选择 TTS 档案。" });
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
      if (!primary) {
        setMessage("请填写主凭据后再保存。");
        return;
      }
      const secondary = asrNeedsSecondary(selectedAsr) ? asrKeys.secondary.trim() : undefined;
      if (asrNeedsSecondary(selectedAsr) && !secondary) {
        setMessage("豆包 ASR 需要同时填写 App ID 与 Access Token。");
        return;
      }
      await saveProviderCredential(selectedAsr.id, primary, secondary);
      setAsrKeys({ primary: "", secondary: "" });
      await refreshStatus();
      setMessage(`${selectedAsr.providerName} 凭据已保存到本机，不进入备份或云同步。`);
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
      setMessage(`${selectedAsr.providerName} 凭据已从本机清除。`);
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
      if (!key) {
        setMessage("请填写 TTS API Key 后再保存。");
        return;
      }
      await saveProviderCredential(selectedTts.id, key);
      setTtsKey("");
      await refreshStatus();
      setMessage(`${selectedTts.providerName} API Key 已保存到本机。`);
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
      setMessage(`${selectedTts.providerName} 凭据已从本机清除。`);
    } catch (e) {
      setMessage(formatUiError(e, "voice-recall"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="voice-provider-drawer__overlay" role="dialog" aria-modal="true" aria-label="语音 Provider 设置">
      <div className="voice-provider-drawer">
        <header className="voice-provider-drawer__header">
          <h2>语音 Provider 设置</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <p className="voice-provider-drawer__intro">
          内置模板 <code>{template.templateId}@{template.version}</code>（{template.status}）。
          档案选择与音色覆盖保存在本机，不进云同步；密钥、Token、App ID 仅存本机密钥引用，不进备份或导出。
        </p>

        {/* ASR */}
        <section className="voice-provider-drawer__section">
          <header className="inline-section-header">
            <div>
              <h3>ASR · 语音识别</h3>
              <p>选择实时转写 Provider；豆包需 App ID + Access Token，阿里云需 API Key。</p>
            </div>
          </header>
          <div className="voice-provider-drawer__profile-list">
            {BUILTIN_ASR_PROFILES.map((profile) => {
              const active = profile.id === selection.asrProfileId;
              return (
                <button
                  key={profile.id}
                  type="button"
                  className={`voice-provider-drawer__profile-card${active ? " active" : ""}`}
                  onClick={() => persistSelection({ ...selection, asrProfileId: profile.id })}
                >
                  <strong>{profile.providerName}</strong>
                  <small>{profile.transport} · {profile.model ?? profile.resourceId ?? "—"}</small>
                  <small>endpoint: {profile.endpoint}</small>
                </button>
              );
            })}
          </div>

          {selectedAsr && (
            <div className="voice-provider-drawer__credential">
              <div className="settings-grid">
                <label>
                  {asrNeedsSecondary(selectedAsr) ? "App ID" : "API Key"}
                  <span className="secret-input">
                    <input
                      value={asrKeys.primary}
                      type={showKey ? "text" : "password"}
                      onChange={(e) => setAsrKeys((c) => ({ ...c, primary: e.target.value }))}
                      placeholder={asrNeedsSecondary(selectedAsr) ? "豆包 App ID" : "sk-... / dashscope key"}
                    />
                    <button type="button" onClick={() => setShowKey((v) => !v)} aria-label="切换密钥显示">
                      {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </span>
                </label>
                {asrNeedsSecondary(selectedAsr) && (
                  <label>
                    Access Token
                    <span className="secret-input">
                      <input
                        value={asrKeys.secondary}
                        type={showKey ? "text" : "password"}
                        onChange={(e) => setAsrKeys((c) => ({ ...c, secondary: e.target.value }))}
                        placeholder="豆包 Access Token"
                      />
                    </span>
                  </label>
                )}
              </div>
              <div className="voice-provider-drawer__row">
                <button type="button" className="secondary-button" onClick={() => void saveAsrCredential()} disabled={busy}>
                  <Save size={16} /> 保存凭据
                </button>
                {asrStatus?.configured && (
                  <button type="button" className="icon-button danger" onClick={() => void removeAsrCredential()} disabled={busy}>
                    <Trash2 size={16} />
                  </button>
                )}
                <button type="button" className="icon-button" onClick={() => void refreshStatus()} disabled={busy} aria-label="刷新状态">
                  <RefreshCw size={16} />
                </button>
                {asrStatus && (
                  <span className={`badge${asrStatus.configured ? " ok" : " warn"}`}>
                    {asrStatus.configured ? "已配置" : "未配置"}
                  </span>
                )}
              </div>
              {asrStatus && <p className="helper-text">{asrStatus.hint}</p>}
            </div>
          )}
        </section>

        {/* LLM */}
        <section className="voice-provider-drawer__section">
          <header className="inline-section-header">
            <div>
              <h3>LLM · 教学模型</h3>
              <p>语音链复用现有 AI 设置中的供应商档案，不在此重复填写 DeepSeek Key。</p>
            </div>
          </header>
          <div className="voice-provider-drawer__llm">
            <div>
              <strong>当前绑定档案</strong>
              <small>{selection.llmProfileId}（来自内置模板）</small>
              <small>编辑入口：更多 → AI 设置（DeepSeek / OpenAI 兼容中转 API）</small>
            </div>
            <span className="badge info">复用 AiProviderProfile</span>
          </div>
          <p className="helper-text">
            流式 LLM adapter（DeepSeek SSE）在 Phase 2 接入；此处只展示绑定关系，避免复制一份密钥造成泄漏面扩大。
          </p>
        </section>

        {/* TTS */}
        <section className="voice-provider-drawer__section">
          <header className="inline-section-header">
            <div>
              <h3>TTS · 语音合成</h3>
              <p>选择播放 Provider 与音色；Fish Audio 需 API Key，系统 TTS 离线兜底无需凭据。</p>
            </div>
          </header>
          <div className="voice-provider-drawer__profile-list">
            {BUILTIN_TTS_PROFILES.map((profile) => {
              const active = profile.id === selection.ttsProfileId;
              return (
                <button
                  key={profile.id}
                  type="button"
                  className={`voice-provider-drawer__profile-card${active ? " active" : ""}`}
                  onClick={() => persistSelection({ ...selection, ttsProfileId: profile.id })}
                >
                  <strong>{profile.providerName}</strong>
                  <small>{profile.transport} · {profile.model ?? "—"}</small>
                  <small>默认音色: {profile.voiceId ?? "—"}</small>
                </button>
              );
            })}
          </div>

          {selectedTts && (
            <div className="voice-provider-drawer__credential">
              <div className="settings-grid">
                <label>
                  音色覆盖（可选）
                  <input
                    value={selection.ttsVoiceIdOverride ?? ""}
                    onChange={(e) => persistSelection({ ...selection, ttsVoiceIdOverride: e.target.value.trim() || undefined })}
                    placeholder={selectedTts.voiceId ?? "使用档案默认音色"}
                  />
                  <small>留空则使用档案默认音色。该选择保存在本机，不进云同步。</small>
                </label>
                {ttsNeedsCredential(selectedTts) && (
                  <label>
                    TTS API Key
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
              </div>
              {ttsNeedsCredential(selectedTts) && (
                <div className="voice-provider-drawer__row">
                  <button type="button" className="secondary-button" onClick={() => void saveTtsCredential()} disabled={busy}>
                    <Save size={16} /> 保存凭据
                  </button>
                  {ttsStatus?.configured && (
                    <button type="button" className="icon-button danger" onClick={() => void removeTtsCredential()} disabled={busy}>
                      <Trash2 size={16} />
                    </button>
                  )}
                  <button type="button" className="icon-button" onClick={() => void refreshStatus()} disabled={busy} aria-label="刷新状态">
                    <RefreshCw size={16} />
                  </button>
                  {ttsStatus && (
                    <span className={`badge${ttsStatus.configured ? " ok" : " warn"}`}>
                      {ttsStatus.configured ? "已配置" : "未配置"}
                    </span>
                  )}
                </div>
              )}
              {ttsStatus && <p className="helper-text">{ttsStatus.hint}</p>}
            </div>
          )}
        </section>

        {/* 外发清单 + 连通状态 */}
        <section className="voice-provider-drawer__section">
          <header className="inline-section-header">
            <div>
              <h3><Shield size={16} /> 内容外发清单与配置状态</h3>
              <p>§6.2 通话前检查：三个 Provider 各需可用配置与本机密钥。真连通测试为 Phase 2，此处只查凭据是否已配置。</p>
            </div>
          </header>
          <ul className="voice-provider-drawer__egress">
            {EGRESS_LIST.map((item) => {
              const status = item.stage === "asr" ? asrStatus : item.stage === "tts" ? ttsStatus : null;
              const configured = item.stage === "llm" ? null : status?.configured;
              return (
                <li key={item.stage}>
                  <div>
                    <strong>{item.label}</strong>
                    <small>{item.detail}</small>
                  </div>
                  {item.stage === "llm" ? (
                    <span className="badge info">复用 AI 设置</span>
                  ) : configured ? (
                    <span className="badge ok">已配置</span>
                  ) : (
                    <span className="badge warn">未配置</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {message && <p className="status-message">{message}</p>}
      </div>

      <style>{CSS}</style>
    </div>
  );
};

const CSS = `
.voice-provider-drawer__overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;justify-content:flex-end;z-index:60}
.voice-provider-drawer{width:min(520px,92vw);height:100%;overflow-y:auto;background:var(--color-surface,#fbfaf7);color:var(--color-text,#2a2622);padding:20px 18px;display:flex;flex-direction:column;gap:16px;box-shadow:-8px 0 24px rgba(0,0,0,.18)}
.voice-provider-drawer__header{display:flex;align-items:center;gap:8px}
.voice-provider-drawer__header h2{font-size:18px;margin:0;flex:1}
.voice-provider-drawer__intro{font-size:12px;color:var(--color-text-muted,#7a726b);margin:0;line-height:1.6}
.voice-provider-drawer__intro code{font-size:12px}
.voice-provider-drawer__section{display:flex;flex-direction:column;gap:10px;padding-top:8px;border-top:1px solid var(--color-border,#d8d2c9)}
.voice-provider-drawer__section .inline-section-header h3{font-size:14px;margin:0;display:flex;align-items:center;gap:6px}
.voice-provider-drawer__section .inline-section-header p{font-size:12px;color:var(--color-text-muted,#7a726b);margin:2px 0 0}
.voice-provider-drawer__profile-list{display:flex;flex-direction:column;gap:8px}
.voice-provider-drawer__profile-card{display:flex;flex-direction:column;gap:2px;text-align:left;padding:10px 12px;border:1px solid var(--color-border,#d8d2c9);border-radius:8px;background:var(--color-surface-raised,#f3efe9);cursor:pointer}
.voice-provider-drawer__profile-card.active{border-color:var(--color-accent,#5b8def);box-shadow:0 0 0 1px var(--color-accent,#5b8def) inset}
.voice-provider-drawer__profile-card small{font-size:11px;color:var(--color-text-muted,#7a726b);word-break:break-all}
.voice-provider-drawer__credential{display:flex;flex-direction:column;gap:10px;padding:10px;border:1px dashed var(--color-border,#d8d2c9);border-radius:8px}
.voice-provider-drawer__llm{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px;border:1px solid var(--color-border,#d8d2c9);border-radius:8px;background:var(--color-surface-raised,#f3efe9)}
.voice-provider-drawer__llm small{display:block;font-size:11px;color:var(--color-text-muted,#7a726b)}
.voice-provider-drawer__row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.voice-provider-drawer__egress{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.voice-provider-drawer__egress li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid var(--color-border,#d8d2c9);border-radius:8px}
.voice-provider-drawer__egress li small{display:block;font-size:11px;color:var(--color-text-muted,#7a726b)}
.badge{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--color-border,#d8d2c9);color:var(--color-text-muted,#7a726b)}
.badge.ok{color:#2f7d52;border-color:#9bcfb1;background:rgba(120,200,150,.12)}
.badge.warn{color:#9a6a1f;border-color:#e6c98a;background:rgba(230,201,138,.16)}
.badge.info{color:var(--color-accent,#3a6cc6)}
.voice-provider-drawer .settings-grid{display:grid;grid-template-columns:1fr;gap:8px}
.voice-provider-drawer label{display:flex;flex-direction:column;gap:4px;font-size:12px}
.voice-provider-drawer label small{color:var(--color-text-muted,#7a726b)}
.voice-provider-drawer .secret-input{display:flex;align-items:center;gap:4px}
.voice-provider-drawer .secret-input input{flex:1}
.voice-provider-drawer input{padding:8px;border:1px solid var(--color-border,#d8d2c9);border-radius:6px;font:inherit;background:var(--color-surface,#fbfaf7)}
.voice-provider-drawer .helper-text{font-size:12px;color:var(--color-text-muted,#7a726b);margin:0}
.voice-provider-drawer .status-message{font-size:12px;margin:0;color:var(--color-accent,#3a6cc6)}
.voice-provider-drawer .primary-button,.voice-provider-drawer .secondary-button{display:inline-flex;align-items:center;gap:6px;font-size:13px}
.voice-provider-drawer .icon-button.danger{color:var(--color-danger,#c0392b)}
@media (prefers-reduced-motion: reduce){.voice-provider-drawer{transition:none}}
`;
