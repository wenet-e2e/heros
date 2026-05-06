import { NativeEventEmitter, NativeModules, Platform } from "react-native";

export interface AudioPlayerConfig {
  sampleRate: number;
  channelCount: number;
  bitsPerSample: 16;
}

export interface AudioPlayer {
  play(pcm: Int16Array): Promise<void>;
  stop(): Promise<void>;
  reset(): Promise<void>;
}

const NativeAudio = NativeModules.NativeAudio as {
  playPCM(config: AudioPlayerConfig, pcmBase64: string): Promise<void>;
  stopPlayback(): Promise<void>;
  resetPlayback(): Promise<void>;
} | null;

const hasNativePlayer =
  NativeAudio != null &&
  typeof NativeAudio.playPCM === "function" &&
  typeof NativeAudio.stopPlayback === "function";

function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

class NativeAudioPlayer implements AudioPlayer {
  private readonly config: AudioPlayerConfig = {
    sampleRate: 24000,
    channelCount: 1,
    bitsPerSample: 16,
  };

  async play(pcm: Int16Array): Promise<void> {
    if (!NativeAudio) throw new Error("NativeAudio 模块未注册");
    const pcmBase64 = int16ToBase64(pcm);
    await NativeAudio.playPCM(this.config, pcmBase64);
  }

  async stop(): Promise<void> {
    await NativeAudio?.stopPlayback();
  }

  async reset(): Promise<void> {
    await NativeAudio?.resetPlayback();
  }
}

class MockAudioPlayer implements AudioPlayer {
  async play(_pcm: Int16Array): Promise<void> {}
  async stop(): Promise<void> {}
  async reset(): Promise<void> {}
}

export function createAudioPlayer(): AudioPlayer {
  if (Platform.OS === "macos" || Platform.OS === "windows") {
    if (hasNativePlayer) {
      return new NativeAudioPlayer();
    }
    if (Platform.OS === "macos") {
      console.warn(
        "NativeAudio 模块未注册，使用 Mock 播放。请在 Xcode 中添加 NativeAudio 原生模块实现。"
      );
    } else {
      console.warn(
        "NativeAudio 模块未注册，使用 Mock 播放。请在 Visual Studio 中添加 NativeAudio 原生模块实现。"
      );
    }
  }
  return new MockAudioPlayer();
}
