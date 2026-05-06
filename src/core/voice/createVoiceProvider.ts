import { Agent } from "../agent/Agent";
import { LLMIntentClassifier } from "../agent/IntentClassifier";
import { doubaoRuntimeConfig } from "./doubaoConfig";
import { DoubaoVoiceProvider } from "./DoubaoVoiceProvider";
import { OpenAIRealtimeVoiceProvider } from "./OpenAIRealtimeVoiceProvider";
import type { VoiceProvider } from "./VoiceProvider";

type RuntimeEnv = Record<string, string | undefined>;
declare const process: { env: RuntimeEnv };
const VOICE_PROVIDER = process.env.HEROS_VOICE_PROVIDER;

export function createVoiceProvider(): VoiceProvider {
  if (VOICE_PROVIDER === "openai-realtime") {
    return new OpenAIRealtimeVoiceProvider();
  }

  const agent = new Agent({
    apiKey: process.env.HEROS_LLM_API_KEY,
    model: process.env.HEROS_LLM_MODEL,
    baseUrl: process.env.HEROS_LLM_BASE_URL,
  });
  const intentClassifier = new LLMIntentClassifier({
    apiKey: process.env.HEROS_LLM_API_KEY,
    model: process.env.HEROS_LLM_MODEL,
    baseUrl: process.env.HEROS_LLM_BASE_URL,
  });

  return new DoubaoVoiceProvider({
    agent,
    intentClassifier,
    config: doubaoRuntimeConfig,
    demoUtterance: process.env.HEROS_DEMO_UTTERANCE,
    greetingText: process.env.HEROS_DOUBAO_GREETING ?? "你好",
  });
}
