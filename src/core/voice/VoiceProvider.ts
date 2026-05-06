import type { VoiceEventMap, VoiceEventName } from "./types";

export interface VoiceProvider {
  readonly id: "doubao" | "openai-realtime";
  start(): Promise<void>;
  stop(): Promise<void>;
  speak(text: string): Promise<void>;
  on<K extends VoiceEventName>(event: K, listener: VoiceEventMap[K]): () => void;
}
