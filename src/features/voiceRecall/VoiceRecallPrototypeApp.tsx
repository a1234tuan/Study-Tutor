/**
 * 语音复述 Phase 0 隔离原型（§7、§8、§4.3）。
 *
 * 通过 ?preview=voice-stage0（localhost-only）打开。纯 Mock 驱动，不接触真实 Provider、
 * 凭据或数据库。演示完整状态机循环与三种互斥输入模式、静音、打断、返回/结束确认面板。
 * 视觉复用 visual-v2.css 的 reading/modern 主题 token；深色为独立维度。
 * 所有 Provider 错误经 uiError.ts 归一化（src/lib/uiError.ts）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, Mic, MicOff, PhoneOff, Settings, X } from "lucide-react";

import type { InputMode, VoiceCallState } from "./domain";
import type { VoiceAudioFrame } from "./providerContracts";
import { buildMockAsrAdapter, buildMockLlmAdapter, buildMockTtsAdapter } from "./mockProvider";
import {
  PlaybackGenerationFactoryImpl,
  VoiceStreamEmitterImpl,
} from "./runtime";
import { canChangeInputMode, isActiveCallState, isMediaActive, transition } from "./stateMachine";
import type { VoiceCallEvent } from "./stateMachine";
import type { VoiceStreamEmitter } from "./providerContracts";
import { formatUiError } from "../../lib/uiError";
import { COST_ESTIMATE_DISCLAIMER, createSessionBudget } from "./voiceCostGating";

type Theme = "reading" | "modern";
type Mode = "light" | "dark";

interface EndPanelOption {
  key: "pause-leave" | "end-call" | "continue";
  label: string;
}

const END_PANEL_OPTIONS: EndPanelOption[] = [
  { key: "pause-leave", label: "暂停并离开" },
  { key: "end-call", label: "结束通话" },
  { key: "continue", label: "继续通话" },
];

const STATUS_LABEL: Record<VoiceCallState, string> = {
  idle: "未开始",
  preflight: "通话前检查",
  connecting: "正在连接",
  listening: "正在听",
  "finalizing-asr": "正在整理",
  thinking: "正在思考",
  speaking: "正在回答",
  paused: "已暂停",
  reconnecting: "正在重连",
  ending: "结束中",
  failed: "出错",
};

const buildSilenceAudioInput = async function* (): AsyncGenerator<VoiceAudioFrame> {
  for (let i = 0; i < 16; i += 1) {
    yield {
      sequence: i,
      timestampMs: i * 100,
      format: "pcm-s16le",
      sampleRate: 16000,
      channels: 1,
      samples: new Int16Array(160), // 静音帧
    };
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

export const VoiceRecallPrototypeApp = () => {
  const [callState, setCallState] = useState<VoiceCallState>("idle");
  const [inputMode, setInputMode] = useState<InputMode>("auto-half-duplex");
  const [userMuted, setUserMuted] = useState(false);
  const [systemCaptureGate, setSystemCaptureGate] = useState(false);
  const [transcriptPartial, setTranscriptPartial] = useState("");
  const [transcriptFinal, setTranscriptFinal] = useState("");
  const [llmText, setLlmText] = useState("");
  const [spokenText, setSpokenText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showEndPanel, setShowEndPanel] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [reminderFired, setReminderFired] = useState(false);
  const [costReminder, setCostReminder] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>("reading");
  const [mode, setMode] = useState<Mode>("light");
  const [seconds, setSeconds] = useState(0);
  const budget = useMemo(() => createSessionBudget(), []);
  // §16 成本门控状态（80% 提醒、达软上限请求门控）。放在 runMockTurn 之前供其引用。
  const budgetStatus = budget.statusAt(seconds * 1000, reminderFired);

  const emitterRef = useRef<VoiceStreamEmitter | null>(null);
  const generationFactoryRef = useRef(new PlaybackGenerationFactoryImpl());
  const runningTurnRef = useRef<AbortController | null>(null);

  // 主题与明暗应用到 documentElement，复用 visual-v2.css token 作用域。
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.visualTheme = theme;
    root.dataset.theme = mode;
  }, [theme, mode]);

  // 通话计时（仅活动态计秒）。
  useEffect(() => {
    if (!isActiveCallState(callState)) {
      setSeconds(0);
      return;
    }
    const id = globalThis.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => globalThis.clearInterval(id);
  }, [callState]);

  const apply = useCallback((event: VoiceCallEvent) => {
    setCallState((prev) => {
      const result = transition(prev, event);
      return result.state;
    });
  }, []);

  const consumeEmitter = useCallback(
    async (emitter: VoiceStreamEmitter) => {
      for await (const event of emitter) {
        if (event.type === "asr-partial") {
          setTranscriptPartial(event.text);
        } else if (event.type === "asr-final") {
          setTranscriptFinal(event.text);
          setTranscriptPartial(event.text);
          apply("asr-finalized"); // finalizing-asr → thinking
        } else if (event.type === "llm-token") {
          setLlmText((prev) => prev + event.text);
          apply("llm-first-token"); // thinking → speaking（首个 token；已 speaking 时为合法 no-op）
        } else if (event.type === "llm-completed") {
          setLlmText(event.fullText);
          setSpokenText(event.fullText);
        } else if (event.type === "tts-audio") {
          setSystemCaptureGate(true); // 扬声器播放时设置系统麦克风门控（§8.2）
        } else if (event.type === "tts-completed") {
          setSystemCaptureGate(false);
          apply("tts-finished"); // speaking → listening（auto half-duplex）
        } else if (event.type === "error") {
          setError(formatUiError(event.error, "voice-recall"));
          if (event.error.stage === "asr") apply("asr-failed");
          else if (event.error.stage === "tts") setSystemCaptureGate(false);
        }
      }
    },
    [apply],
  );

  const startCall = useCallback(async () => {
    setError(null);
    setLlmText("");
    setTranscriptFinal("");
    setTranscriptPartial("");
    setSpokenText("");
    apply("start-preflight"); // idle → preflight
    await sleep(300);
    apply("preflight-passed"); // → connecting
    await sleep(300);
    apply("connected"); // → listening
  }, [apply]);

  const runMockTurn = useCallback(async () => {
    if (callState !== "listening") return;
    if (userMuted || systemCaptureGate) return; // 有效采集条件 §8.2
    if (budgetStatus.softCapReached) return; // §16 请求门控：达软上限不再开新轮次
    setError(null);
    setLlmText("");
    apply("silence-detected"); // listening → finalizing-asr

    const emitter = new VoiceStreamEmitterImpl();
    emitterRef.current = emitter;
    const turnAbort = new AbortController();
    runningTurnRef.current = turnAbort;
    // 先起消费循环，再并行跑三个 Mock adapter。
    const consume = consumeEmitter(emitter);
    const audioInput = buildSilenceAudioInput();
    const asr = buildMockAsrAdapter();
    await asr.stream({ emitter, signal: turnAbort.signal, audioInput });
    // ASR final 已触发 thinking；并行启动 LLM 与 TTS（Mock 各自独立计时）。
    const generation = generationFactoryRef.current.next().generation;
    await Promise.all([
      buildMockLlmAdapter().stream({ emitter, signal: turnAbort.signal, messages: [] }),
      buildMockTtsAdapter().stream({ emitter, signal: turnAbort.signal, text: spokenText || "比例原则包含目的性、必要性与均衡性。", generation }),
    ]);
    emitter.close(); // 通知消费者迭代结束，避免 await consume 挂起
    await consume;
    runningTurnRef.current = null;
  }, [callState, userMuted, systemCaptureGate, apply, consumeEmitter, spokenText, budgetStatus.softCapReached]);

  const interrupt = useCallback(() => {
    if (callState !== "speaking") return;
    runningTurnRef.current?.abort();
    generationFactoryRef.current.invalidateAll();
    setSystemCaptureGate(false);
    apply("interrupt"); // speaking → listening
  }, [callState, apply]);

  const toggleMute = useCallback(() => {
    setUserMuted((prev) => !prev);
  }, []);

  const requestEnd = useCallback(() => {
    setShowEndPanel(true);
  }, []);

  const handleEndPanel = useCallback(
    (option: EndPanelOption["key"]) => {
      setShowEndPanel(false);
      if (option === "continue") return;
      runningTurnRef.current?.abort();
      generationFactoryRef.current.invalidateAll();
      emitterRef.current?.close();
      if (option === "pause-leave") {
        apply("pause"); // 暂停并离开：保留检查点，返回来源页（原型：回 idle 简化）
        apply("start-ending");
        apply("ended");
      } else if (option === "end-call") {
        apply("start-ending");
        apply("ended");
      }
    },
    [apply],
  );

  const mainButton = useMemo<{ label: string; onClick: () => void; disabled?: boolean }>(() => {
    if (callState === "idle") return { label: "开始语音复述", onClick: startCall };
    if (callState === "speaking") {
      return { label: userMuted ? "取消静音并说话" : "打断并说话", onClick: interrupt };
    }
    if (callState === "listening") {
      if (inputMode === "auto-half-duplex") return { label: "立即发送", onClick: runMockTurn };
      if (inputMode === "tap-to-record") return { label: "发送", onClick: runMockTurn };
      return { label: "按住说话", onClick: runMockTurn }; // push-to-talk 原型：点击模拟按下
    }
    if (callState === "finalizing-asr" || callState === "thinking") {
      return { label: "取消本轮", onClick: () => runningTurnRef.current?.abort(), disabled: true };
    }
    return { label: STATUS_LABEL[callState], onClick: () => {}, disabled: true };
  }, [callState, inputMode, userMuted, startCall, runMockTurn, interrupt]);

  const captureEffective = !userMuted && !systemCaptureGate;
  const showWaveform = isMediaActive(callState);

  // 豆包式字幕优先级：说话中显示 AI 流式文本，聆听/整理显示用户转写，思考显示提示，空闲显示主题。
  const caption = useMemo(() => {
    if (callState === "speaking") return llmText || spokenText || "正在回答…";
    if (callState === "thinking") return "正在组织回答…";
    if (callState === "finalizing-asr") return transcriptPartial || transcriptFinal || "正在整理你的话…";
    if (callState === "listening") return transcriptPartial || transcriptFinal || "我在听，请说…";
    if (callState === "connecting" || callState === "reconnecting") return "正在连接…";
    if (callState === "paused") return "已暂停";
    if (callState === "failed") return error ?? "通话出错";
    return spokenText || "请复述行政法中的比例原则。";
  }, [callState, llmText, spokenText, transcriptPartial, transcriptFinal, error]);

  const captionRole: "ai" | "user" | "status" = callState === "speaking" || callState === "thinking" ? "ai" : callState === "listening" || callState === "finalizing-asr" ? "user" : "status";

  // §16 成本提醒：达 80% 用量只触发一次。
  useEffect(() => {
    if (budgetStatus.reminderDue) {
      setReminderFired(true);
      setCostReminder(`已用约 80% 预计时长。${COST_ESTIMATE_DISCLAIMER}`);
    }
  }, [budgetStatus.reminderDue]);

  return (
    <div className="vr-root" data-theme={mode} data-visual-theme={theme} data-call={callState}>
      <style>{CSS}</style>
      {/* 环境层：深色渐变 + 球体辉光底，随通话状态变色 */}
      <div className="vr-ambient" aria-hidden="true">
        <div className="vr-ambient-haze" data-call={callState} />
      </div>

      <header className="vr-header">
        <button className="vr-icon-btn" onClick={requestEnd} aria-label="返回" type="button">
          <ArrowLeft size={22} />
        </button>
        <span className="vr-timer">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>
        <button
          className="vr-icon-btn"
          onClick={() => setShowSettings((prev) => !prev)}
          aria-label="设置"
          aria-pressed={showSettings}
          type="button"
        >
          <Settings size={20} />
        </button>
      </header>

      <main className="vr-stage">
        {/* 上一轮交换的薄玻璃卡片，让对话有连续感（无历史时空） */}
        {transcriptFinal && callState !== "listening" && callState !== "finalizing-asr" ? (
          <div className="vr-prior" aria-label="你刚才说的">
            <span className="vr-prior-tag">你</span>
            <span className="vr-prior-text">{transcriptFinal}</span>
          </div>
        ) : null}

        {/* 中央在场感球体：呼吸/涟漪/色泽随状态变化，兼作声波可视化 */}
        <div className="vr-orb-wrap" data-active={showWaveform} aria-hidden="true">
          <div className="vr-orb" data-call={callState}>
            <span className="vr-orb-ring" />
            <span className="vr-orb-ring vr-orb-ring--2" />
            <span className="vr-orb-ring vr-orb-ring--3" />
            <span className="vr-orb-core" />
          </div>
        </div>

        {/* 字幕式实时文本 */}
        <div className="vr-caption" data-role={captionRole} aria-live="polite">
          {caption}
        </div>
      </main>

      <footer className="vr-dock">
        <button
          className="vr-dock-btn"
          onClick={toggleMute}
          aria-pressed={userMuted}
          aria-label={userMuted ? "取消静音" : "静音"}
          type="button"
        >
          {userMuted ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
        <button
          className="vr-fab"
          onClick={mainButton.onClick}
          disabled={mainButton.disabled}
          data-call={callState}
          aria-label={mainButton.label}
          type="button"
        >
          <span className="vr-fab-ring" aria-hidden="true" />
          <span className="vr-fab-core">
            {callState === "finalizing-asr" || callState === "thinking" || callState === "connecting" || callState === "reconnecting" ? (
              <LoaderCircle className="spin" size={26} />
            ) : callState === "speaking" ? (
              <PhoneOff size={24} />
            ) : (
              <Mic size={24} />
            )}
          </span>
          <span className="vr-fab-label">{mainButton.label}</span>
        </button>
        <button className="vr-dock-btn vr-dock-btn--end" onClick={requestEnd} aria-label="结束通话" type="button">
          <X size={22} />
        </button>
      </footer>

      {/* 错误 Toast（经 uiError 归一化，不暴露 Provider 原始响应） */}
      {error ? (
        <div className="vr-toast" role="alert">
          {error}
          <button className="vr-toast-close" onClick={() => setError(null)} aria-label="关闭" type="button">×</button>
        </div>
      ) : null}

      {/* §16 成本提醒 Toast（80% 用量，只触发一次） */}
      {costReminder ? (
        <div className="vr-toast vr-toast--info" role="status">
          {costReminder}
          <button className="vr-toast-close" onClick={() => setCostReminder(null)} aria-label="关闭" type="button">×</button>
        </div>
      ) : null}

      {/* 设置抽屉：主题/明暗/输入模式与采集诊断，不污染沉浸屏 */}
      {showSettings ? (
        <aside className="vr-drawer" role="dialog" aria-label="通话设置" aria-modal="false">
          <div className="vr-drawer-head">
            <span>通话设置</span>
            <button className="vr-icon-btn" onClick={() => setShowSettings(false)} aria-label="关闭" type="button"><X size={18} /></button>
          </div>
          <label className="vr-control">
            主题
            <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
              <option value="reading">温润阅读</option>
              <option value="modern">清爽现代</option>
            </select>
          </label>
          <label className="vr-control">
            明暗
            <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <label className="vr-control">
            输入模式
            <select
              value={inputMode}
              disabled={!canChangeInputMode(callState)}
              onChange={(e) => setInputMode(e.target.value as InputMode)}
            >
              <option value="auto-half-duplex">自动轮次（半双工）</option>
              <option value="push-to-talk">长按说话</option>
              <option value="tap-to-record">点击录音</option>
            </select>
          </label>
          <span className="vr-hint">有效采集：{captureEffective ? "是" : "否"}</span>
        </aside>
      ) : null}

      {/* 结束确认面板：玻璃拟态 */}
      {showEndPanel ? (
        <div className="vr-panel-backdrop" role="dialog" aria-modal="true" aria-label="通话中断确认">
          <div className="vr-panel">
            <p className="vr-panel-title">通话进行中</p>
            <p className="vr-panel-hint">采集或播放正在进行，请选择如何处理当前通话。</p>
            <p className="vr-panel-estimate" aria-label="本机估算">{budgetStatus.estimateText}</p>
            {END_PANEL_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                className={`vr-panel-btn ${opt.key === "end-call" ? "vr-panel-btn--danger" : opt.key === "continue" ? "vr-panel-btn--primary" : ""}`}
                onClick={() => handleEndPanel(opt.key)}
                type="button"
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};

const CSS = `
/* 语音通话沉浸式视觉。参考豆包：深色渐变 + 在场感球体 + 字幕式文本 + 玻璃拟态。
   颜色集中为语音域语义变量（--vr-*），由 data-theme / data-call 驱动，不散落硬编码。 */
.vr-root{
  --vr-bg-1:#0b1020; --vr-bg-2:#1a1f3f;
  --vr-text:#eef1f8; --vr-text-muted:#9aa3bd;
  --vr-surface:rgba(255,255,255,.06); --vr-surface-border:rgba(255,255,255,.10);
  --vr-orb:#6b7aff; --vr-glow:#6b7aff; --vr-ring:rgba(107,122,255,.55);
  --vr-caption-ai:#eef1f8; --vr-caption-user:#cfe9e4; --vr-caption-status:#9aa3bd;
  --vr-fab-bg:linear-gradient(180deg,#7c8bff,#5a6bf0); --vr-fab-ring:rgba(107,122,255,.6);
  --vr-danger:#ef5a6f;
  position:fixed;inset:0;display:flex;flex-direction:column;
  background:radial-gradient(120% 80% at 50% 18%,var(--vr-bg-2),var(--vr-bg-1) 70%);
  color:var(--vr-text);font-family:var(--font-ui);font-size:17px;overflow:hidden;
  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
}
.vr-root[data-theme="light"]{
  --vr-bg-1:#f3efe6; --vr-bg-2:#fbf8f1;
  --vr-text:#2a2a30; --vr-text-muted:#7a7470;
  --vr-surface:rgba(0,0,0,.04); --vr-surface-border:rgba(0,0,0,.08);
  --vr-orb:#5a6bf0; --vr-glow:#7c8bff; --vr-ring:rgba(90,107,240,.35);
  --vr-caption-ai:#2a2a30; --vr-caption-user:#1f5a52; --vr-caption-status:#7a7470;
}
/* 状态驱动球体色泽（暗色为主，浅色沿用同 token） */
.vr-root[data-call="listening"]{--vr-orb:#34d6c8;--vr-glow:#34d6c8;--vr-ring:rgba(52,214,200,.55);}
.vr-root[data-call="finalizing-asr"]{--vr-orb:#f0a958;--vr-glow:#f0a958;--vr-ring:rgba(240,169,88,.5);}
.vr-root[data-call="thinking"]{--vr-orb:#9b7bf0;--vr-glow:#9b7bf0;--vr-ring:rgba(155,123,240,.5);}
.vr-root[data-call="speaking"]{--vr-orb:#ff8a5b;--vr-glow:#ff8a5b;--vr-ring:rgba(255,138,91,.55);}
.vr-root[data-call="connecting"],.vr-root[data-call="reconnecting"]{--vr-orb:#5b8cff;--vr-glow:#5b8cff;--vr-ring:rgba(91,140,255,.5);}
.vr-root[data-call="paused"]{--vr-orb:#6b7280;--vr-glow:#6b7280;--vr-ring:rgba(107,114,128,.4);}
.vr-root[data-call="failed"]{--vr-orb:#ef5a6f;--vr-glow:#ef5a6f;--vr-ring:rgba(239,90,111,.5);}

/* 环境辉光：球体后方的大面积柔光，随状态位移/变色 */
.vr-ambient{position:absolute;inset:0;pointer-events:none;overflow:hidden;}
.vr-ambient-haze{position:absolute;left:50%;top:38%;width:140vmax;height:140vmax;transform:translate(-50%,-50%);
  background:radial-gradient(circle,var(--vr-glow) 0%,transparent 60%);opacity:.32;filter:blur(40px);transition:opacity .6s ease,background .6s ease;}
.vr-root[data-call="speaking"] .vr-ambient-haze{opacity:.42;}
.vr-root[data-call="listening"] .vr-ambient-haze{opacity:.38;}

.vr-header{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;padding:10px 12px;gap:8px;}
.vr-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border:none;background:var(--vr-surface);border:1px solid var(--vr-surface-border);color:var(--vr-text);border-radius:999px;cursor:pointer;backdrop-filter:blur(8px);transition:transform .15s ease,background .2s ease;}
.vr-icon-btn:hover{background:rgba(255,255,255,.10);}
.vr-icon-btn:active{transform:scale(.94);}
.vr-timer{color:var(--vr-text-muted);font-variant-numeric:tabular-nums;font-size:15px;letter-spacing:.5px;}

.vr-stage{position:relative;z-index:2;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;padding:0 18px;overflow:hidden;}

/* 上一轮交换的薄玻璃卡 */
.vr-prior{max-width:560px;width:100%;display:flex;gap:8px;align-items:flex-start;background:var(--vr-surface);border:1px solid var(--vr-surface-border);border-radius:14px;padding:10px 12px;backdrop-filter:blur(6px);opacity:.86;}
.vr-prior-tag{flex:0 0 auto;font-size:12px;color:var(--vr-text-muted);border:1px solid var(--vr-surface-border);border-radius:6px;padding:1px 6px;}
.vr-prior-text{font-size:15px;line-height:1.5;color:var(--vr-text);}

/* 在场感球体 */
.vr-orb-wrap{position:relative;width:200px;height:200px;display:flex;align-items:center;justify-content:center;}
.vr-orb{position:relative;width:128px;height:128px;display:flex;align-items:center;justify-content:center;animation:vr-breath 4.5s ease-in-out infinite;}
.vr-orb-core{position:absolute;inset:0;border-radius:999px;
  background:radial-gradient(circle at 38% 32%,#fff6,transparent 40%),radial-gradient(circle at 50% 50%,var(--vr-orb),var(--vr-orb) 38%,transparent 70%);
  box-shadow:0 0 60px 8px var(--vr-glow),inset 0 0 30px rgba(255,255,255,.25);transition:background .6s ease,box-shadow .6s ease;}
.vr-orb-ring{position:absolute;border-radius:999px;border:2px solid var(--vr-ring);opacity:0;}
.vr-orb-wrap[data-active="true"] .vr-orb-ring{animation:vr-ripple 2.4s ease-out infinite;}
.vr-orb-wrap[data-active="true"] .vr-orb-ring--2{animation-delay:.8s;}
.vr-orb-wrap[data-active="true"] .vr-orb-ring--3{animation-delay:1.6s;}
.vr-root[data-call="speaking"] .vr-orb{animation-duration:2.6s;}
.vr-root[data-call="thinking"] .vr-orb{animation-duration:5.5s;}
.vr-root[data-call="paused"] .vr-orb,.vr-root[data-call="idle"] .vr-orb{animation-duration:6s;}
@keyframes vr-breath{0%,100%{transform:scale(.95);}50%{transform:scale(1.04);}}
@keyframes vr-ripple{0%{inset:50%;opacity:.8;}100%{inset:-40%;opacity:0;}}

/* 字幕式实时文本 */
.vr-caption{max-width:560px;text-align:center;font-size:19px;line-height:1.7;font-family:var(--font-reading);
  color:var(--vr-caption-status);min-height:48px;transition:color .3s ease;}
.vr-caption[data-role="ai"]{color:var(--vr-caption-ai);}
.vr-caption[data-role="user"]{color:var(--vr-caption-user);font-style:italic;}

/* 底部 dock：两侧图标 + 中央大圆主键 */
.vr-dock{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px calc(16px + env(safe-area-inset-bottom));}
.vr-dock-btn{display:inline-flex;align-items:center;justify-content:center;width:52px;height:52px;border:1px solid var(--vr-surface-border);background:var(--vr-surface);color:var(--vr-text);border-radius:999px;cursor:pointer;backdrop-filter:blur(8px);transition:transform .15s ease,background .2s ease;}
.vr-dock-btn:hover{background:rgba(255,255,255,.10);}
.vr-dock-btn:active{transform:scale(.92);}
.vr-dock-btn[aria-pressed="true"]{background:rgba(239,90,111,.18);border-color:rgba(239,90,111,.5);color:#ff8a95;}
.vr-dock-btn--end{background:rgba(239,90,111,.16);border-color:rgba(239,90,111,.45);color:#ff8a95;}

.vr-fab{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;border:none;background:transparent;cursor:pointer;color:var(--vr-text);}
.vr-fab-core{width:76px;height:76px;border-radius:999px;display:flex;align-items:center;justify-content:center;
  background:var(--vr-fab-bg);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.12) inset;transition:transform .15s ease,box-shadow .3s ease;}
.vr-fab-ring{position:absolute;top:0;width:76px;height:76px;border-radius:999px;border:2px solid var(--vr-fab-ring);opacity:.6;pointer-events:none;}
.vr-fab:hover .vr-fab-core{transform:scale(1.05);}
.vr-fab:active .vr-fab-core{transform:scale(.95);}
.vr-fab:disabled .vr-fab-core{opacity:.5;cursor:not-allowed;}
.vr-fab-label{font-size:13px;color:var(--vr-text-muted);letter-spacing:.5px;min-height:16px;}
.vr-fab[data-call="listening"] .vr-fab-ring{animation:vr-fab-ring 2s ease-out infinite;}
.vr-fab[data-call="speaking"] .vr-fab-ring{animation:vr-fab-ring 1.2s ease-out infinite;border-color:rgba(255,138,91,.6);}
@keyframes vr-fab-ring{0%{transform:scale(1);opacity:.6;}100%{transform:scale(1.6);opacity:0;}}

/* 错误 Toast */
.vr-toast{position:relative;z-index:3;margin:0 16px 8px;padding:10px 36px 10px 12px;background:rgba(239,90,111,.16);border:1px solid rgba(239,90,111,.4);border-radius:12px;color:#ffd7dc;font-size:14px;line-height:1.4;backdrop-filter:blur(8px);}
.vr-toast--info{background:rgba(91,140,255,.16);border-color:rgba(91,140,255,.4);color:#cfe0ff;}
.vr-toast-close{position:absolute;right:6px;top:6px;width:28px;height:28px;border:none;background:transparent;color:inherit;font-size:20px;cursor:pointer;}

/* 设置抽屉（底部薄板，非模态） */
.vr-drawer{position:absolute;z-index:3;right:12px;bottom:calc(96px + env(safe-area-inset-bottom));width:min(320px,86vw);display:flex;flex-direction:column;gap:12px;
  background:rgba(20,24,48,.86);border:1px solid var(--vr-surface-border);border-radius:16px;padding:14px;backdrop-filter:blur(14px);box-shadow:0 12px 36px rgba(0,0,0,.4);}
.vr-drawer-head{display:flex;align-items:center;justify-content:space-between;font-weight:600;}
.vr-control{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--vr-text-muted);}
.vr-control select{min-height:40px;background:var(--vr-surface);color:var(--vr-text);border:1px solid var(--vr-surface-border);border-radius:10px;padding:0 8px;}
.vr-hint{font-size:12px;color:var(--vr-text-muted);}

/* 结束确认面板：玻璃拟态 */
.vr-panel-backdrop{position:absolute;inset:0;z-index:4;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center;}
.vr-panel{width:100%;max-width:480px;background:rgba(28,32,56,.92);border:1px solid var(--vr-surface-border);border-radius:18px 18px 0 0;padding:20px 16px calc(20px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:8px;backdrop-filter:blur(16px);box-shadow:0 -8px 32px rgba(0,0,0,.4);}
.vr-panel-title{margin:0;font-size:18px;font-weight:600;}
.vr-panel-hint{margin:0 0 6px;font-size:14px;color:var(--vr-text-muted);}
.vr-panel-estimate{margin:0 0 8px;font-size:12px;color:var(--vr-text-muted);font-variant-numeric:tabular-nums;}
.vr-panel-btn{min-height:48px;padding:14px;border:1px solid var(--vr-surface-border);background:var(--vr-surface);color:var(--vr-text);border-radius:12px;font-size:16px;cursor:pointer;transition:transform .15s ease,background .2s ease;}
.vr-panel-btn:active{transform:scale(.98);}
.vr-panel-btn--primary{background:var(--vr-fab-bg);border-color:transparent;color:#fff;}
.vr-panel-btn--danger{background:rgba(239,90,111,.85);border-color:transparent;color:#fff;}

.spin{animation:vr-spin 1s linear infinite;}
@keyframes vr-spin{to{transform:rotate(360deg);}}

@media (prefers-reduced-motion: reduce){
  .vr-orb{animation:none;}
  .vr-orb-wrap[data-active="true"] .vr-orb-ring{animation:none;opacity:.25;inset:-12%;}
  .vr-fab[data-call="listening"] .vr-fab-ring,.vr-fab[data-call="speaking"] .vr-fab-ring{animation:none;opacity:.35;}
  .vr-ambient-haze{transition:none;}
  .spin{animation:none;}
}
@media (max-width:380px){.vr-orb-wrap{width:168px;height:168px;}.vr-orb{width:108px;height:108px;}.vr-fab-core{width:68px;height:68px;}.vr-fab-ring{width:68px;height:68px;}.vr-caption{font-size:17px;}}
`;
