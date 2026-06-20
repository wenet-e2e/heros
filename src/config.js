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

  return {
    dashscopeApiKey: apiKey,
    dashscopeBaseUrl: process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    realtimeUrl: process.env.HEROS_REALTIME_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    realtimeModel: process.env.HEROS_REALTIME_MODEL || 'qwen3.5-omni-plus-realtime',
    realtimeVoice: process.env.HEROS_REALTIME_VOICE || 'Ethan',
    backgroundModel: process.env.HEROS_BACKGROUND_MODEL || 'qwen3.7-plus',
    timeZone: process.env.HEROS_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    dataDir: process.env.HEROS_DATA_DIR || path.join(process.cwd(), '.heros'),
  };
}
