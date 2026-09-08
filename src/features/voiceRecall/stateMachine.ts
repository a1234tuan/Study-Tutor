/**
 * 通话状态机迁移表（§14、§8.1）。
 *
 * 纯函数 transition(from, event)，供 UI 与测试共用。状态所有权分三层（§14）：
 * App 级 runtime controller 持有活动连接/播放器/内存队列；导航状态只持有来源身份；
 * schema 21 保存可恢复检查点。组件卸载不能等同于会话结束，但必须触发采集/播放暂停。
 *
 * 静音是正交的 userMuted / systemCaptureGate（见 domain.ts），不作为混合旁路状态。
 * 因此本表只描述主状态与旁路状态的迁移；静音/门控由 runtime 在状态之外维护。
 */

import type { VoiceCallState } from "./domain";

export type VoiceCallEvent =
  | "start-preflight" // idle → preflight
  | "preflight-passed" // preflight → connecting
  | "preflight-failed" // preflight → failed
  | "connected" // connecting → listening
  | "connect-failed" // connecting → failed
  | "capture-started" // listening → listening（幂等）
  | "silence-detected" // listening → finalizing-asr
  | "manual-end-turn" // listening → finalizing-asr（点击/松开/二次点击，最高优先级 §9 第 6 条）
  | "asr-finalized" // finalizing-asr → thinking
  | "asr-failed" // finalizing-asr → failed
  | "llm-first-token" // thinking → speaking（首句可朗读时 §13.1）
  | "llm-empty" // thinking → listening（无输出，回退聆听）
  | "tts-finished" // speaking → listening（auto half-duplex §8.1）
  | "interrupt" // speaking → listening（用户打断 §13.2，停止 TTS + 取消 LLM 流）
  | "pause" // listening/preflight/connecting → paused
  | "resume" // paused → listening（恢复后由用户明确继续，§14）
  | "reconnecting" // 任意活动态 → reconnecting
  | "reconnected" // reconnecting → listening
  | "reconnect-failed" // reconnecting → failed
  | "start-ending" // 任意态 → ending
  | "ended" // ending → idle
  | "retry" // failed → preflight
  | "dismiss-failure"; // failed → idle

const TABLE: Partial<Record<VoiceCallState, Partial<Record<VoiceCallEvent, VoiceCallState>>>> = {
  idle: { "start-preflight": "preflight" },
  preflight: {
    "preflight-passed": "connecting",
    "preflight-failed": "failed",
    pause: "paused",
    "start-ending": "ending",
  },
  connecting: {
    connected: "listening",
    "connect-failed": "failed",
    pause: "paused",
    "start-ending": "ending",
    reconnecting: "reconnecting",
  },
  listening: {
    "capture-started": "listening",
    "silence-detected": "finalizing-asr",
    "manual-end-turn": "finalizing-asr",
    pause: "paused",
    "start-ending": "ending",
    reconnecting: "reconnecting",
  },
  "finalizing-asr": {
    "asr-finalized": "thinking",
    "asr-failed": "failed",
    "start-ending": "ending",
    reconnecting: "reconnecting",
  },
  thinking: {
    "llm-first-token": "speaking",
    "llm-empty": "listening",
    interrupt: "listening",
    "start-ending": "ending",
    reconnecting: "reconnecting",
  },
  speaking: {
    "tts-finished": "listening",
    interrupt: "listening",
    "start-ending": "ending",
    reconnecting: "reconnecting",
  },
  paused: {
    resume: "listening",
    "start-ending": "ending",
    reconnecting: "reconnecting",
  },
  reconnecting: {
    reconnected: "listening",
    "reconnect-failed": "failed",
    "start-ending": "ending",
  },
  ending: { ended: "idle" },
  failed: { retry: "preflight", "dismiss-failure": "idle" },
};

export interface VoiceTransitionResult {
  from: VoiceCallState;
  event: VoiceCallEvent;
  state: VoiceCallState;
  illegal: boolean;
}

/** 计算迁移。非法迁移返回 { illegal: true, state: from }，调用方不得改变当前状态。 */
export const transition = (from: VoiceCallState, event: VoiceCallEvent): VoiceTransitionResult => {
  const next = TABLE[from]?.[event];
  if (next === undefined) {
    return { from, event, state: from, illegal: true };
  }
  return { from, event, state: next, illegal: false };
};

/** 主循环是否活动（非 idle/ending）。用于判断返回键是否需要弹出确认面板（§4.3）。 */
export const isActiveCallState = (state: VoiceCallState): boolean =>
  state !== "idle" && state !== "ending";

/** 采集或播放是否在活动（决定离开通话页时是否必须暂停，§4.3）。 */
export const isMediaActive = (state: VoiceCallState): boolean =>
  state === "listening" || state === "finalizing-asr" || state === "speaking";

/** 当前态可否切换输入模式（§8.1：通话中只允许在暂停状态切换）。 */
export const canChangeInputMode = (state: VoiceCallState): boolean =>
  state === "paused" || state === "idle" || state === "preflight";
