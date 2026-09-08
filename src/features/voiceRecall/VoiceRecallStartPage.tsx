/**
 * 语音复述开始页（§6 起始页落地，Phase 3）。
 *
 * 分段选择来源（自由主题 / 资料范围；任务绑定 Phase 5 才开放）；自由主题输入主题 +
 * 知识边界策略；资料范围会话复用 AiKnowledgeScopePicker（minSelectedRecords=1，§22）
 * ——生产路由嵌入完整选择器；本预览用确定性种子日志做轻量展示。
 * 显示费用等级与时长上限（§16：默认 10min，80% 提醒，软上限 20min）。
 * 开始通话时构造 VoiceRecallSessionLocal 检查点写入 schema 21 local-only 表，再进入沉浸式通话页。
 *
 * 视觉复用 APP 既有设计系统（.page/.ai-topbar/.surface-card/.ai-image-mode-options/
 * .inline-section-header/.primary-button），不使用内联样式或自造类；主题两轴
 * （data-visual-theme + data-theme）在挂载时写到 documentElement，使 visual-v2.css
 * token 作用域在预览态（不经 <App>）也生效。所有错误经 src/lib/uiError.ts（voice-recall）。
 * 预览入口 ?preview=voice-stage3。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, BookOpen, Clock3, Compass, Mic, Settings } from "lucide-react";
import { formatUiError } from "../../lib/uiError";
import { readVisualTheme } from "../../lib/visualTheme";
import { buildVoiceRecallSession } from "./voiceRecallSessionBuilder";
import { getVoiceProviderSelection, resolveSelectedProfiles } from "./voiceProviderSelection";
import { VoiceProviderSettingsDrawer } from "./VoiceProviderSettingsDrawer";
import { createInitialMemory } from "./sessionMemory";
import type { InputMode, KnowledgePolicy, VoiceCallConfig, VoiceRecallSourceKind } from "./domain";
import { VoiceRecallPrototypeApp } from "./VoiceRecallPrototypeApp";

export interface VoiceRecallStartPageProps {
  /** 写入会话检查点（local-only；生产实现写 StudyJournalDatabase，预览用 noop/内存）。 */
  onPersistSession?: (session: ReturnType<typeof buildVoiceRecallSession>) => Promise<void> | void;
  onBack?: () => void;
  /** 资料范围会话的种子日志标题（预览用）。 */
  seedRecordTitles?: string[];
}

type SourceTab = "free-topic" | "scope-practice";

const DEFAULT_MAX_SESSION_MINUTES = 10;

const SOURCES: Array<{ value: SourceTab; label: string; hint: string; icon: typeof Mic }> = [
  { value: "free-topic", label: "自由主题", hint: "直接说一个想复述的主题，不要求本地日志。", icon: Compass },
  { value: "scope-practice", label: "资料范围", hint: "从一条或多条日志出发做闭卷复述。", icon: BookOpen },
];

const KNOWLEDGE_POLICIES: Array<{ value: KnowledgePolicy; label: string; hint: string }> = [
  { value: "notes-only", label: "仅依据日志", hint: "只回答日志里有依据的内容，不足时说明。" },
  { value: "notes-plus", label: "日志优先", hint: "优先日志，必要时补充并标明「日志外补充」。" },
  { value: "expand", label: "允许教材补充", hint: "可补充标准表述，但须显式标注。" },
];

const INPUT_MODES: Array<{ value: InputMode; label: string; hint: string }> = [
  { value: "auto-half-duplex", label: "自动半双工", hint: "AI 说完自动听你说，说完一段自动提交。" },
  { value: "push-to-talk", label: "按住说话", hint: "按住采集、松开发送，适合嘈杂环境。" },
  { value: "tap-to-record", label: "点击录音", hint: "点一下开始、再点一下发送。" },
];

const QUICK_TOPICS = ["比例原则三个子原则", "操作系统进程调度", "行政法信赖保护原则"];

export const VoiceRecallStartPage = ({ onPersistSession, onBack, seedRecordTitles = [] }: VoiceRecallStartPageProps) => {
  const [tab, setTab] = useState<SourceTab>("free-topic");
  const [freeTopic, setFreeTopic] = useState("");
  const [knowledgePolicy, setKnowledgePolicy] = useState<KnowledgePolicy>("expand");
  const [inputMode, setInputMode] = useState<InputMode>("auto-half-duplex");
  const [startedSessionId, setStartedSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 用户在本机选择的 ASR/LLM/TTS 档案（§12.2：非敏感，localStorage，不进云同步）。
  const [selection, setSelection] = useState(() => getVoiceProviderSelection());

  // 预览态不经 <App>，需把主题两轴写到 documentElement，visual-v2.css token 才生效。
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.visualTheme = readVisualTheme();
    if (!root.dataset.theme) {
      const prefersDark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
      root.dataset.theme = prefersDark ? "dark" : "light";
    }
  }, []);

  const profiles = resolveSelectedProfiles(selection);
  const asrProfile = profiles.asr;
  const ttsProfile = profiles.tts;

  const startConfig = useMemo<VoiceCallConfig>(() => ({
    asrProviderId: selection.asrProfileId,
    llmProviderId: selection.llmProfileId,
    ttsProviderId: selection.ttsProfileId,
    inputMode,
    maxSessionMinutes: DEFAULT_MAX_SESSION_MINUTES,
    defaultKnowledgePolicy: knowledgePolicy,
  }), [selection, inputMode, knowledgePolicy]);

  const handleStart = useCallback(async () => {
    setError(null);
    // 主题留空时走自由复述默认，不强迫输入（§3.2 自由主题不要求存在本地日志）。
    const topic = freeTopic.trim() || "自由主题复述";
    setBusy(true);
    try {
      const sourceKind: VoiceRecallSourceKind = tab === "free-topic" ? "free-topic" : "scope-practice";
      const sessionId = `voice-session-${Date.now()}`;
      const session = buildVoiceRecallSession({
        sessionId,
        sourceKind,
        config: startConfig,
        knowledgePolicy,
        startedAt: new Date().toISOString(),
        navSource: sourceKind === "scope-practice"
          ? { origin: "review-home", filterSnapshot: { seedRecordTitles } }
          : { origin: "today" },
      });
      const initialMemory = createInitialMemory(
        sourceKind === "free-topic" ? topic : "资料范围复述",
        sourceKind === "free-topic" ? "自由主题" : `已选 ${seedRecordTitles.length || 0} 条日志`,
      );
      session.memory = initialMemory;
      if (onPersistSession) await onPersistSession(session);
      setStartedSessionId(sessionId);
    } catch (e) {
      setError(formatUiError(e, "voice-recall"));
    } finally {
      setBusy(false);
    }
  }, [tab, freeTopic, startConfig, knowledgePolicy, seedRecordTitles, onPersistSession]);

  if (startedSessionId) {
    return <VoiceRecallPrototypeApp onExit={() => setStartedSessionId(null)} />;
  }

  return (
    <main className="page voice-recall-start-page">
      <header className="ai-topbar">
        {onBack && (
          <button type="button" className="icon-button" onClick={onBack} aria-label="返回" title="返回">
            <ArrowLeft size={18} />
          </button>
        )}
        <div className="ai-topbar-title">
          <p className="eyebrow">语音复述</p>
          <h1>语音主动回忆</h1>
        </div>
        <div className="ai-topbar-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Provider 设置"
            title="ASR / LLM / TTS 设置"
          >
            <Settings size={18} />
          </button>
        </div>
      </header>

      <section className="surface-card voice-recall-hero">
        <label htmlFor="voice-free-topic" className="voice-recall-hero__label">
          想复述或检查什么？
        </label>
        <textarea
          id="voice-free-topic"
          value={freeTopic}
          onChange={(e) => setFreeTopic(e.target.value)}
          placeholder="例如：用比例原则分析三个子原则的关系。留空可直接开始自由复述。"
          rows={3}
          className="voice-recall-hero__textarea"
        />
        <div className="provider-template-row">
          {QUICK_TOPICS.map((topic) => (
            <button
              key={topic}
              type="button"
              className="secondary-button"
              onClick={() => setFreeTopic(topic)}
            >
              {topic}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="primary-button voice-recall-hero__start"
          onClick={() => void handleStart()}
          disabled={busy}
        >
          <Mic size={18} /> 开始通话
        </button>

        <p className="helper-text voice-recall-hero__summary">
          <Clock3 size={13} /> 默认 {DEFAULT_MAX_SESSION_MINUTES} 分钟 · {asrProfile?.providerName ?? "识别"} / DeepSeek 教学 / {ttsProfile?.providerName ?? "合成"} · 点右上设置改凭据
        </p>

        {error && <p className="status-message" role="alert">{error}</p>}
      </section>

      <details className="voice-tech-details voice-recall-advanced">
        <summary>高级选项</summary>
        <section className="surface-card" style={{ border: 0, padding: 0, boxShadow: "none", background: "transparent" }}>
          <header className="inline-section-header">
            <div>
              <h3>会话来源</h3>
              <p>默认自由主题；资料范围从日志出发做闭卷复述。</p>
            </div>
          </header>
          <div className="ai-image-mode-options">
            {SOURCES.map((source) => {
              const Icon = source.icon;
              const active = tab === source.value;
              return (
                <label key={source.value} className={active ? "active" : ""}>
                  <input
                    type="radio"
                    name="voice-source"
                    value={source.value}
                    checked={active}
                    onChange={() => setTab(source.value)}
                  />
                  <span>
                    <strong><Icon size={16} /> {source.label}</strong>
                    <small>{source.hint}</small>
                  </span>
                </label>
              );
            })}
          </div>
          {tab === "scope-practice" && seedRecordTitles.length > 0 && (
            <p className="helper-text" style={{ marginTop: 8 }}>
              当前预览种子：<strong>{seedRecordTitles.join("、")}</strong>
            </p>
          )}
        </section>

        <section className="surface-card" style={{ border: 0, padding: 0, boxShadow: "none", background: "transparent" }}>
          <header className="inline-section-header">
            <div>
              <h3>知识边界</h3>
              <p>默认允许教材补充；回答会显式标注来源。</p>
            </div>
          </header>
          <div className="ai-image-mode-options">
            {KNOWLEDGE_POLICIES.map((policy) => (
              <label key={policy.value} className={knowledgePolicy === policy.value ? "active" : ""}>
                <input
                  type="radio"
                  name="knowledge-policy"
                  value={policy.value}
                  checked={knowledgePolicy === policy.value}
                  onChange={() => setKnowledgePolicy(policy.value)}
                />
                <span>
                  <strong>{policy.label}</strong>
                  <small>{policy.hint}</small>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className="surface-card" style={{ border: 0, padding: 0, boxShadow: "none", background: "transparent" }}>
          <header className="inline-section-header">
            <div>
              <h3>输入模式</h3>
              <p>默认自动半双工；通话中只允许暂停时切换。</p>
            </div>
          </header>
          <div className="ai-image-mode-options">
            {INPUT_MODES.map((mode) => (
              <label key={mode.value} className={inputMode === mode.value ? "active" : ""}>
                <input
                  type="radio"
                  name="input-mode"
                  value={mode.value}
                  checked={inputMode === mode.value}
                  onChange={() => setInputMode(mode.value)}
                />
                <span>
                  <strong>{mode.label}</strong>
                  <small>{mode.hint}</small>
                </span>
              </label>
            ))}
          </div>
        </section>
      </details>

      <VoiceProviderSettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSelectionChanged={() => setSelection(getVoiceProviderSelection())}
      />
    </main>
  );
};
