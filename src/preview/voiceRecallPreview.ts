import { isDesktopPlatform, isNativePlatform } from "../lib/platform";

const isLocalhost = (): boolean => {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "127.0.0.1" || host === "localhost";
};

const previewParam = (): string | null => {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("preview");
};

/**
 * localhost-only 语音复述 Phase 0 隔离原型入口（§18 阶段 0、AGENTS.md ?preview= 约定）。
 * 不 seed 数据库，纯 Mock 驱动。gated out of native shell 与 desktop。
 */
export const isVoiceStage0PreviewRequest = (): boolean => {
  if (isNativePlatform() || isDesktopPlatform()) return false;
  return isLocalhost() && previewParam() === "voice-stage0";
};

/**
 * localhost-only 语音复述 Phase 3 开始页入口（§6 起始页、§18 阶段 3）。
 * 确定性种子日志驱动；开始通话后写入会话检查点（生产实现写 schema 21，预览内存态）。
 */
export const isVoiceStage3PreviewRequest = (): boolean => {
  if (isNativePlatform() || isDesktopPlatform()) return false;
  return isLocalhost() && previewParam() === "voice-stage3";
};
