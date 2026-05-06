import { VoiceEventBus } from "./VoiceEventBus";
import type { VoiceProvider } from "./VoiceProvider";
import type { VoiceEventMap, VoiceEventName } from "./types";

export class OpenAIRealtimeVoiceProvider implements VoiceProvider {
  readonly id = "openai-realtime" as const;
  private readonly events = new VoiceEventBus();

  async start(): Promise<void> {
    this.events.emit("stage", "listening");
  }

  async stop(): Promise<void> {
    this.events.emit("stage", "idle");
  }

  async speak(text: string): Promise<void> {
    this.events.emit("response", text);
    this.events.emit("stage", "speaking");
    await Promise.resolve();
    this.events.emit("stage", "listening");
  }

  on<K extends VoiceEventName>(event: K, listener: VoiceEventMap[K]): () => void {
    return this.events.on(event, listener);
  }
}
