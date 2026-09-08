/**
 * 语音复述开始页（§6 起始页落地，Phase 3）。
 *
 * 分段控件选择来源（自由主题 / 资料范围；任务绑定 Phase 5 才开放）；
 * 自由主题输入主题 + 知识边界策略；资料范围会话复用 AiKnowledgeScopePicker
 * （minSelectedRecords=1，§22）——生产路由嵌入完整选择器；本预览用确定性种子日志做轻量展示。
 * 显示费用等级与时长上限（§16：默认 10min，80% 提醒，软上限 20min）。
 * 开始通话时构造 VoiceRecallSessionLocal 检查点写入 schema 21 local-only 表，再进入沉浸式通话页。
 *
 * 所有错误经 src/lib/uiError.ts（context voice-recall）。预览入口 ?preview=voice-stage3。
 */

import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, Mic, Clock, Info } from "lucide-react";
import { formatUiError } from "../../lib/uiError";
import { buildVoiceRecallSession } from "./voiceRecallSessionBuilder";
import { VOICE_DEFAULT_REGISTRY } from "./voiceProviderTemplates";
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
const SOFT_CAP_MINUTES = 20;
const REMINDER_PERCENT = 80;

const KNOWLEDGE_POLICIES: Array<{ value: KnowledgePolicy; label: string; hint: string }> = [
  { value: "notes-only", label: "仅依据日志", hint: "只回答日志里有依据的内容，不足时说明。" },
  { value: "notes-plus", label: "日志优先", hint: "优先日志，必要时补充并标明「日志外补充」。" },
  { value: "expand", label: "允许教材补充", hint: "可补充标准表述，但须显式标注。" },
];

const INPUT_MODES: Array<{ value: InputMode; label: string }> = [
  { value: "auto-half-duplex", label: "自动半双工" },
  { value: "push-to-talk", label: "按住说话" },
  { value: "tap-to-record", label: "点击录音" },
];

export const VoiceRecallStartPage = ({ onPersistSession, onBack, seedRecordTitles = [] }: VoiceRecallStartPageProps) => {
  const [tab, setTab] = useState<SourceTab>("free-topic");
  const [freeTopic, setFreeTopic] = useState("");
  const [knowledgePolicy, setKnowledgePolicy] = useState<KnowledgePolicy>("expand");
  const [inputMode, setInputMode] = useState<InputMode>("auto-half-duplex");
  const [startedSessionId, setStartedSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const template = VOICE_DEFAULT_REGISTRY.template;

  const startConfig = useMemo<VoiceCallConfig>(() => ({
    asrProviderId: template.asrProfileId,
    llmProviderId: template.llmProfileId,
    ttsProviderId: template.ttsProfileId,
    inputMode,
    maxSessionMinutes: DEFAULT_MAX_SESSION_MINUTES,
    defaultKnowledgePolicy: knowledgePolicy,
  }), [template, inputMode, knowledgePolicy]);

  const handleStart = useCallback(async () => {
    setError(null);
    if (tab === "free-topic" && !freeTopic.trim()) {
      setError(formatUiError(new Error("empty topic"), "voice-recall"));
      return;
    }
    setBusy(true);
    try {
      const sourceKind: VoiceRecallSourceKind = tab === "free-topic" ? "free-topic" : "scope-practice";
      const sessionId = `voice-session-${Date.now()}`;
      const session = buildVoiceRecallSession({
        sessionId,
        sourceKind,
        config: startConfig,
        // 自由主题默认 expand（允许教材补充）；范围会话默认 notes-only。构造器内部已处理；
        // 此处显式传用户当前选择，保证用户覆盖优先。
        knowledgePolicy,
        startedAt: new Date().toISOString(),
        navSource: sourceKind === "scope-practice"
          ? { origin: "review-home", filterSnapshot: { seedRecordTitles } }
          : { origin: "today" },
      });
      // 注入初始记忆（自由主题以用户输入为目标；范围会话以范围为标签）。
      const initialMemory = createInitialMemory(
        sourceKind === "free-topic" ? freeTopic.trim() : "资料范围复述",
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
    return <VoiceRecallPrototypeApp />;
  }

  return (
    <div className="voice-recall-start" data-visual-theme="reading" data-theme="light">
      <header className="voice-recall-start__header">
        {onBack && (
          <button type="button" className="icon-button" onClick={onBack} aria-label="返回">
            <ArrowLeft size={18} />
          </button>
        )}
        <h1>语音主动回忆</h1>
        <span className="voice-recall-start__status">模板 {template.templateId}@{template.version} · {template.status}</span>
      </header>

      <section className="voice-recall-start__source">
        <div className="segmented" role="tablist" aria-label="会话来源">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "free-topic"}
            className={`segmented__item${tab === "free-topic" ? " active" : ""}`}
            onClick={() => setTab("free-topic")}
          >自由主题</button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "scope-practice"}
            className={`segmented__item${tab === "scope-practice" ? " active" : ""}`}
            onClick={() => setTab("scope-practice")}
          >资料范围</button>
          <button
            type="button"
            role="tab"
            aria-selected={false}
            className="segmented__item segmented__item--disabled"
            disabled
            title="Phase 5 Review Coach 深度接入后开放"
          >任务绑定（即将）</button>
        </div>

        {tab === "free-topic" ? (
          <div className="voice-recall-start__field">
            <label htmlFor="voice-free-topic">主题或学习目标</label>
            <textarea
              id="voice-free-topic"
              value={freeTopic}
              onChange={(e) => setFreeTopic(e.target.value)}
              placeholder="例如：用比例原则分析三个子原则的关系"
              rows={3}
            />
          </div>
        ) : (
          <div className="voice-recall-start__scope">
            <p className="voice-recall-start__hint">
              生产路由复用 <code>AiKnowledgeScopePicker</code>（minSelectedRecords=1，§22）选择日志范围。
            </p>
            {seedRecordTitles.length > 0 && (
              <ul className="voice-recall-start__seed-records">
                {seedRecordTitles.map((title, idx) => (
                  <li key={idx}>{title}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <fieldset className="voice-recall-start__policy">
          <legend>知识边界</legend>
          {KNOWLEDGE_POLICIES.map((policy) => (
            <label key={policy.value} className={`radio-row${knowledgePolicy === policy.value ? " selected" : ""}`}>
              <input
                type="radio"
                name="knowledge-policy"
                value={policy.value}
                checked={knowledgePolicy === policy.value}
                onChange={() => setKnowledgePolicy(policy.value)}
              />
              <span className="radio-row__label">{policy.label}</span>
              <span className="radio-row__hint">{policy.hint}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="voice-recall-start__input-mode">
          <legend>输入模式（通话中只允许在暂停时切换）</legend>
          {INPUT_MODES.map((mode) => (
            <label key={mode.value} className={`radio-row${inputMode === mode.value ? " selected" : ""}`}>
              <input
                type="radio"
                name="input-mode"
                value={mode.value}
                checked={inputMode === mode.value}
                onChange={() => setInputMode(mode.value)}
              />
              <span className="radio-row__label">{mode.label}</span>
            </label>
          ))}
        </fieldset>
      </section>

      <aside className="voice-recall-start__cost" aria-label="费用与时长">
        <div className="cost-row"><Clock size={16} /> <span>默认 {DEFAULT_MAX_SESSION_MINUTES} 分钟，软上限 {SOFT_CAP_MINUTES} 分钟</span></div>
        <div className="cost-row"><Info size={16} /> <span>{REMINDER_PERCENT}% 用量提醒，达软上限请求门控</span></div>
        <div className="cost-row"><Mic size={16} /> <span>ASR/TTS：候选模板（未验证）；LLM：DeepSeek 流式</span></div>
      </aside>

      {error && <p className="voice-recall-start__error" role="alert">{error}</p>}

      <button
        type="button"
        className="primary-button voice-recall-start__start"
        onClick={() => void handleStart()}
        disabled={busy}
      >开始通话</button>

      <style>{CSS}</style>
    </div>
  );
};

const CSS = `
.voice-recall-start{max-width:640px;margin:0 auto;padding:24px 16px;min-height:100dvh;display:flex;flex-direction:column;gap:16px;background:var(--color-surface,#fbfaf7);color:var(--color-text,#2a2622)}
.voice-recall-start__header{display:flex;align-items:center;gap:12px}
.voice-recall-start__header h1{font-size:20px;margin:0;flex:1}
.voice-recall-start__status{font-size:12px;color:var(--color-text-muted,#7a726b)}
.segmented{display:flex;gap:4px;background:var(--color-surface-raised,#f3efe9);border-radius:10px;padding:4px}
.segmented__item{flex:1;border:0;background:transparent;padding:10px;border-radius:8px;font-size:14px;color:var(--color-text,#2a2622);cursor:pointer}
.segmented__item.active{background:var(--color-surface,#fbfaf7);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.segmented__item--disabled{opacity:.45;cursor:not-allowed}
.voice-recall-start__field,.voice-recall-start__scope{display:flex;flex-direction:column;gap:8px}
.voice-recall-start__field textarea{resize:vertical;padding:10px;border:1px solid var(--color-border,#d8d2c9);border-radius:8px;font:inherit;background:var(--color-surface,#fbfaf7)}
.voice-recall-start__hint{font-size:13px;color:var(--color-text-muted,#7a726b);margin:0}
.voice-recall-start__seed-records{margin:0;padding-left:18px;font-size:13px}
fieldset{border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:6px}
legend{font-size:13px;font-weight:600;margin-bottom:4px}
.radio-row{display:flex;align-items:center;gap:8px;padding:10px;border:1px solid var(--color-border,#d8d2c9);border-radius:8px;background:var(--color-surface-raised,#f3efe9)}
.radio-row.selected{border-color:var(--color-accent,#5b8def)}
.radio-row__label{font-size:14px}
.radio-row__hint{font-size:12px;color:var(--color-text-muted,#7a726b);flex:1}
.voice-recall-start__cost{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:10px;background:var(--color-surface-raised,#f3efe9);font-size:13px}
.cost-row{display:flex;align-items:center;gap:8px;color:var(--color-text-muted,#7a726b)}
.voice-recall-start__error{color:var(--color-danger,#c0392b);font-size:13px;margin:0}
.voice-recall-start__start{margin-top:auto;padding:14px;font-size:16px}
@media (prefers-reduced-motion: reduce){.segmented__item{transition:none}}
`;
