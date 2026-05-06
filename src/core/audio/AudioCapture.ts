import { NativeEventEmitter, NativeModules, Platform } from "react-native";

export interface AudioCaptureConfig {
  sampleRate: number;
  channelCount: number;
  bitsPerSample: 16;
}

export interface AudioCapture {
  start(): Promise<void>;
  stop(): Promise<void>;
  onAudioData(callback: (chunk: Int16Array) => void): () => void;
}

const NativeAudio = NativeModules.NativeAudio as {
  startCapture(config: AudioCaptureConfig): Promise<boolean>;
  stopCapture(): Promise<void>;
} | null;

const hasNativeAudio =
  NativeAudio != null &&
  typeof NativeAudio.startCapture === "function" &&
  typeof NativeAudio.stopCapture === "function";

function createNativeAudioEmitter() {
  if (!NativeAudio) return null;
  try {
    return new NativeEventEmitter(NativeAudio as never);
  } catch {
    return null;
  }
}

class NativeAudioCapture implements AudioCapture {
  private listeners = new Set<(chunk: Int16Array) => void>();
  private emitter = createNativeAudioEmitter();
  private subscription: { remove(): void } | null = null;

  async start(): Promise<void> {
    if (!NativeAudio) {
      throw new Error("NativeAudio 模块未注册，请在 macOS/Windows 原生层实现音频采集。");
    }
    const ok = await NativeAudio.startCapture({
      sampleRate: 24000,
      channelCount: 1,
      bitsPerSample: 16,
    });
    if (!ok) throw new Error("麦克风启动失败");

    if (this.emitter) {
      this.subscription = this.emitter.addListener(
        "NativeAudio.onAudioData",
        (payload: { data: number[] }) => {
          const chunk = new Int16Array(payload.data);
          for (const cb of this.listeners) {
            cb(chunk);
          }
        }
      );
    }
  }

  async stop(): Promise<void> {
    this.subscription?.remove();
    this.subscription = null;
    if (NativeAudio) {
      await NativeAudio.stopCapture();
    }
  }

  onAudioData(callback: (chunk: Int16Array) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }
}

class MockAudioCapture implements AudioCapture {
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(chunk: Int16Array) => void>();

  async start(): Promise<void> {
    this.timer = setInterval(() => {
      const silence = new Int16Array(480);
      for (const cb of this.listeners) {
        cb(silence);
      }
    }, 20);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onAudioData(callback: (chunk: Int16Array) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }
}

export function createAudioCapture(): AudioCapture {
  if (Platform.OS === "macos" || Platform.OS === "windows") {
    if (hasNativeAudio) {
      return new NativeAudioCapture();
    }
    if (Platform.OS === "macos") {
      console.warn(
        "NativeAudio 模块未注册，使用 Mock 采集。请在 Xcode 中添加 NativeAudio 原生模块实现。"
      );
    } else {
      console.warn(
        "NativeAudio 模块未注册，使用 Mock 采集。请在 Visual Studio 中添加 NativeAudio 原生模块实现。"
      );
    }
  }
  return new MockAudioCapture();
}
