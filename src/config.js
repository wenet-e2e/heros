import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export function loadEnvFile(filePath = '.env.local') {
  const absolutePath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolutePath)) {
    return;
  }

  const lines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function getConfig() {
  loadEnvFile();
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new Error('Missing DASHSCOPE_API_KEY in .env.local or environment.');
  }

  const realtimeInstructions = process.env.HEROS_REALTIME_INSTRUCTIONS || [
    '你是 HerOS，一个受到电影《HER》启发的个人 AI。',
    '你要像一个自然、温暖、聪明的长期伙伴一样对话，也要在需要时把复杂任务交给后台能力更强的 LLM/Agent。',
    '实时语音层优先保持低延迟、可打断、自然简洁；复杂推理、长期任务、工具执行由后台模型完成。',
    '如果用户表达提醒、日程、待办或执行任务意图，要自然回应你会处理，运行时会把任务交给后台 Agent。',
    '默认使用中文，除非用户明确使用其他语言。',
  ].join('\n');

  return {
    dashscopeApiKey: apiKey,
    dashscopeBaseUrl: process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    dashscopeRequestTimeoutMs: Number(process.env.DASHSCOPE_REQUEST_TIMEOUT_MS || '60000'),
    realtimeUrl: process.env.HEROS_REALTIME_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    realtimeModel: process.env.HEROS_REALTIME_MODEL || 'qwen3.5-omni-plus-realtime',
    realtimeVoice: process.env.HEROS_REALTIME_VOICE || 'Ethan',
    realtimeInstructions,
    realtimeInputTranscriptionModel: process.env.HEROS_REALTIME_INPUT_TRANSCRIPTION_MODEL || 'gummy-realtime-v1',
    realtimeVadThreshold: process.env.HEROS_REALTIME_VAD_THRESHOLD || '0.5',
    realtimeVadPrefixPaddingMs: process.env.HEROS_REALTIME_VAD_PREFIX_PADDING_MS || '500',
    realtimeVadSilenceDurationMs: process.env.HEROS_REALTIME_VAD_SILENCE_DURATION_MS || '800',
    backgroundModel: process.env.HEROS_BACKGROUND_MODEL || 'qwen3.7-plus',
    timeZone: process.env.HEROS_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    dataDir: process.env.HEROS_DATA_DIR || path.join(process.cwd(), '.heros'),
  };
}
