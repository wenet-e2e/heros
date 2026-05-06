export interface DoubaoRuntimeConfig {
  baseUrl: string;
  appId: string;
  accessKey: string;
  resourceId: string;
  appKey: string;
  speaker: string;
  botName: string;
  systemRole: string;
  speakingStyle: string;
}

type RuntimeEnv = Record<string, string | undefined>;
declare const process: { env: RuntimeEnv };

export const doubaoRuntimeConfig: DoubaoRuntimeConfig = {
  baseUrl: process.env.HEROS_DOUBAO_BASE_URL ?? "wss://openspeech.bytedance.com/api/v3/realtime/dialogue",
  appId: process.env.HEROS_DOUBAO_APP_ID ?? "",
  accessKey: process.env.HEROS_DOUBAO_ACCESS_KEY ?? "",
  resourceId: process.env.HEROS_DOUBAO_RESOURCE_ID ?? "volc.speech.dialog",
  appKey: process.env.HEROS_DOUBAO_APP_KEY ?? "PlgvMymc7f3tQnJ6",
  speaker: process.env.HEROS_DOUBAO_SPEAKER ?? "zh_female_xiaohe_jupiter_bigtts",
  botName: process.env.HEROS_DOUBAO_BOT_NAME ?? "豆包",
  systemRole: process.env.HEROS_DOUBAO_SYSTEM_ROLE ?? "你使用活泼灵动的女声，性格开朗，热爱生活。",
  speakingStyle: process.env.HEROS_DOUBAO_SPEAKING_STYLE ?? "你的说话风格简洁明了，语速适中，语调自然。",
};

export function hasValidDoubaoCredentials(config: DoubaoRuntimeConfig): boolean {
  return Boolean(config.appId && config.accessKey);
}
