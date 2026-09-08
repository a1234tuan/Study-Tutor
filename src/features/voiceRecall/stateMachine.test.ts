import { describe, expect, it } from "vitest";
import { canChangeInputMode, isActiveCallState, isMediaActive, transition } from "./stateMachine";
import type { VoiceCallEvent, VoiceTransitionResult } from "./stateMachine";

const legal = (from: Parameters<typeof transition>[0], event: VoiceCallEvent, expected: string): void => {
  const result = transition(from, event);
  expect(result.illegal, `${from} --${event}--> should be legal`).toBe(false);
  expect(result.state, `${from} --${event}--> ${expected}`).toBe(expected);
};

const illegal = (from: Parameters<typeof transition>[0], event: VoiceCallEvent): void => {
  const result = transition(from, event);
  expect(result.illegal, `${from} --${event}--> should be illegal`).toBe(true);
  expect(result.state, `illegal transition must not mutate state`).toBe(from);
};

describe("voiceRecall stateMachine legal main cycle", () => {
  it("runs the full main cycle idle -> ... -> speaking -> listening", () => {
    let r: VoiceTransitionResult = transition("idle", "start-preflight");
    expect(r.state).toBe("preflight");
    legal("preflight", "preflight-passed", "connecting");
    legal("connecting", "connected", "listening");
    legal("listening", "capture-started", "listening"); // idempotent while listening
    legal("listening", "silence-detected", "finalizing-asr");
    legal("finalizing-asr", "asr-finalized", "thinking");
    legal("thinking", "llm-first-token", "speaking");
    legal("speaking", "tts-finished", "listening"); // auto half-duplex returns to listening
  });

  it("supports manual end-turn at highest priority", () => {
    legal("listening", "manual-end-turn", "finalizing-asr");
  });

  it("falls back to listening when LLM emits nothing", () => {
    legal("thinking", "llm-empty", "listening");
  });
});

describe("voiceRecall stateMachine bypass states", () => {
  it("pauses and resumes from listening", () => {
    legal("listening", "pause", "paused");
    legal("paused", "resume", "listening");
  });

  it("pauses from preflight and connecting", () => {
    legal("preflight", "pause", "paused");
    legal("connecting", "pause", "paused");
  });

  it("reconnects and recovers to listening", () => {
    legal("listening", "reconnecting", "reconnecting");
    legal("reconnecting", "reconnected", "listening");
  });

  it("ends the call from any active state via ending -> idle", () => {
    for (const from of ["preflight", "connecting", "listening", "finalizing-asr", "thinking", "speaking", "paused", "reconnecting"] as const) {
      legal(from, "start-ending", "ending");
    }
    legal("ending", "ended", "idle");
  });

  it("fails and can retry or dismiss", () => {
    legal("preflight", "preflight-failed", "failed");
    legal("connecting", "connect-failed", "failed");
    legal("finalizing-asr", "asr-failed", "failed");
    legal("reconnecting", "reconnect-failed", "failed");
    legal("failed", "retry", "preflight");
    legal("failed", "dismiss-failure", "idle");
  });
});

describe("voiceRecall stateMachine illegal transitions", () => {
  it("cannot start speaking without going through thinking", () => {
    illegal("idle", "llm-first-token");
    illegal("listening", "llm-first-token");
    illegal("finalizing-asr", "tts-finished");
  });

  it("cannot jump straight to listening from idle", () => {
    illegal("idle", "connected");
    illegal("idle", "silence-detected");
  });

  it("cannot resume from a non-paused state", () => {
    illegal("listening", "resume");
    illegal("idle", "resume");
  });

  it("cannot end an already-idle call", () => {
    illegal("idle", "start-ending");
    illegal("idle", "ended");
  });

  it("does not allow speaking transitions when not speaking", () => {
    illegal("listening", "tts-finished");
    illegal("listening", "interrupt");
  });
});

describe("voiceRecall stateMachine helpers", () => {
  it("isActiveCallState distinguishes active from idle/ending", () => {
    expect(isActiveCallState("listening")).toBe(true);
    expect(isActiveCallState("speaking")).toBe(true);
    expect(isActiveCallState("paused")).toBe(true);
    expect(isActiveCallState("ending")).toBe(false);
    expect(isActiveCallState("idle")).toBe(false);
  });

  it("isMediaActive flags capture/playback states for leave confirmation", () => {
    expect(isMediaActive("listening")).toBe(true);
    expect(isMediaActive("finalizing-asr")).toBe(true);
    expect(isMediaActive("speaking")).toBe(true);
    expect(isMediaActive("thinking")).toBe(false);
    expect(isMediaActive("paused")).toBe(false);
  });

  it("canChangeInputMode only allows switching in paused/idle/preflight (§8.1)", () => {
    expect(canChangeInputMode("paused")).toBe(true);
    expect(canChangeInputMode("idle")).toBe(true);
    expect(canChangeInputMode("preflight")).toBe(true);
    expect(canChangeInputMode("listening")).toBe(false);
    expect(canChangeInputMode("speaking")).toBe(false);
  });
});
