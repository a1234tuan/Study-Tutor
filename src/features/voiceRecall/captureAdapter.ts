/**
 * 采集 adapter 契约（§8.3、§12.3）。
 *
 * VoiceCaptureAdapter 输出带 sequence、单调时钟时间戳与格式描述的音频帧。
 * 优先使用系统/WebRTC 回声消除、噪声抑制与自动增益。
 * - Web：getUserMedia + AudioWorklet（Phase 2 真接入；Phase 0/1 仅契约 + Mock）。
 * - Android：新增 NativeVoiceCapture 流式 PCM 插件，不在现有 NativeAudioRecorder 上硬加状态。
 *   Java 插件实现列为用户具备 Android 环境后的后续项；本文件只交付 TS 契约 + Mock。
 * - Electron：主进程音频/网络桥接（Phase 2 真接入；Phase 1 契约）。
 *
 * 本机 VAD 只判断"像不像人声"，不保证语义；目标是降低非语音触发概率。
 */

import type { VoiceAudioFrame } from "./providerContracts";

export interface VoiceCaptureStartOptions {
  /** 期望采样率（16kHz 单声道 PCM 为规范格式，但不假定所有 Provider 接受同一采样率/编码）。 */
  sampleRate: number;
  channels: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  onFrame: (frame: VoiceAudioFrame) => void;
  signal: AbortSignal;
}

export interface VoiceCaptureAdapter {
  readonly platform: "web" | "android" | "electron" | "mock";
  isAvailable(): boolean;
  start(options: VoiceCaptureStartOptions): Promise<void>;
  stop(): Promise<void>;
}

/**
 * 确定性 Mock 采集 adapter。按固定间隔产生静音帧，便于 Vitest fake timers 驱动。
 * 不使用 Math.random；不接触麦克风或权限。
 */
export class MockVoiceCaptureAdapter implements VoiceCaptureAdapter {
  readonly platform = "mock" as const;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sequence = 0;

  constructor(private readonly intervalMs = 100) {}

  isAvailable(): boolean {
    return true;
  }

  async start(options: VoiceCaptureStartOptions): Promise<void> {
    this.sequence = 0;
    const startedAt = 0; // 单调时钟起点；真实实现用 performance.now()
    this.timer = setInterval(() => {
      if (options.signal.aborted) {
        this.stop();
        return;
      }
      const frame: VoiceAudioFrame = {
        sequence: this.sequence,
        timestampMs: startedAt + this.sequence * this.intervalMs,
        format: "pcm-s16le",
        sampleRate: options.sampleRate,
        channels: options.channels,
        samples: new Int16Array(options.sampleRate * options.channels * this.intervalMs / 1000),
      };
      this.sequence += 1;
      options.onFrame(frame);
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Web 采集 adapter（Phase 2 真接入）。Phase 1 提供 isAvailable=false 的骨架，
 * 避免在未配置浏览器直连时误启用；真实 getUserMedia + AudioWorklet 在 Phase 2 落地。
 */
export class WebVoiceCaptureAdapter implements VoiceCaptureAdapter {
  readonly platform = "web" as const;
  private stream: MediaStream | null = null;

  isAvailable(): boolean {
    return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
  }

  async start(_options: VoiceCaptureStartOptions): Promise<void> {
    // Phase 2：getUserMedia({ echoCancellation, noiseSuppression, autoGainControl }) + AudioWorklet → onFrame。
    throw new Error("Web 语音采集将在 Phase 2 接入；当前仅启用 Mock、自建中继或 browserDirectSupported 的 Provider。");
  }

  async stop(): Promise<void> {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}

/**
 * Android NativeVoiceCapture 契约（§12.3）。Java 插件实现列为用户后续项。
 */
export interface NativeVoiceCaptureContract {
  start(options: VoiceCaptureStartOptions): Promise<void>;
  stop(): Promise<void>;
}

export class AndroidVoiceCaptureAdapter implements VoiceCaptureAdapter {
  readonly platform = "android" as const;
  constructor(private readonly native?: NativeVoiceCaptureContract) {}

  isAvailable(): boolean {
    return this.native !== undefined;
  }

  async start(options: VoiceCaptureStartOptions): Promise<void> {
    if (!this.native) {
      throw new Error("Android 流式 PCM 插件未安装；现有 NativeAudioRecorder 不支持实时帧传输。");
    }
    await this.native.start(options);
  }

  async stop(): Promise<void> {
    await this.native?.stop();
  }
}

/**
 * Electron 主进程音频/网络桥接契约（§12.3）。Phase 1 只交付 TS 契约；
 * 主进程 getUserMedia/system-keytap 监听与 IPC 真接入在 Phase 2 落地。
 * 渲染进程不直接持有麦克风句柄或网络密钥，统一由主进程代理并回传规范帧。
 */
export interface ElectronVoiceBridgeContract {
  start(options: VoiceCaptureStartOptions): Promise<void>;
  stop(): Promise<void>;
}

export class ElectronVoiceCaptureAdapter implements VoiceCaptureAdapter {
  readonly platform = "electron" as const;
  constructor(private readonly bridge?: ElectronVoiceBridgeContract) {}

  isAvailable(): boolean {
    return this.bridge !== undefined;
  }

  async start(options: VoiceCaptureStartOptions): Promise<void> {
    if (!this.bridge) {
      throw new Error("Electron 主进程音频桥接未就绪；将在 Phase 2 接入 getUserMedia 代理与 IPC。");
    }
    await this.bridge.start(options);
  }

  async stop(): Promise<void> {
    await this.bridge?.stop();
  }
}
