import type { VoiceEventMap, VoiceEventName } from "./types";

type ListenerSet<K extends VoiceEventName> = Set<VoiceEventMap[K]>;

export class VoiceEventBus {
  private listeners: {
    [K in VoiceEventName]: ListenerSet<K>;
  } = {
    stage: new Set(),
    transcript: new Set(),
    response: new Set(),
    reminderCreated: new Set(),
    error: new Set(),
    inputLevel: new Set(),
    outputLevel: new Set(),
  };

  on<K extends VoiceEventName>(event: K, listener: VoiceEventMap[K]): () => void {
    this.listeners[event].add(listener as never);
    return () => {
      this.listeners[event].delete(listener as never);
    };
  }

  emit<K extends VoiceEventName>(event: K, payload: Parameters<VoiceEventMap[K]>[0]): void {
    for (const listener of this.listeners[event]) {
      listener(payload as never);
    }
  }
}
