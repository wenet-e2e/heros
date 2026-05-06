export type VoiceStage = "idle" | "listening" | "thinking" | "speaking" | "error";

export interface ReminderRequest {
  content: string;
  triggerAt: Date;
  sourceText: string;
}

export interface VoiceEventMap {
  stage: (stage: VoiceStage) => void;
  transcript: (text: string) => void;
  response: (text: string) => void;
  reminderCreated: (payload: ReminderRequest) => void;
  error: (message: string) => void;
  inputLevel: (level: number) => void;
  outputLevel: (level: number) => void;
}

export type VoiceEventName = keyof VoiceEventMap;
