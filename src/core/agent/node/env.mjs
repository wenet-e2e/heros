import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_MODEL = "gpt-4.1-mini";
export const DEFAULT_BASE_URL = "https://api.openai.com/v1/responses";
export const DEFAULT_MAX_ROUNDS = 6;

function loadEnvFile(pathname) {
  if (!existsSync(pathname)) return {};
  const out = {};
  for (const rawLine of readFileSync(pathname, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const localEnv = loadEnvFile(resolve(process.cwd(), ".env.local"));

export function readEnv(key, fallback = "") {
  return process.env[key] || localEnv[key] || fallback;
}

export function normalize(text) {
  return String(text || "").trim();
}

export function toChatCompletionsUrl(baseUrl) {
  const raw = normalize(baseUrl);
  if (raw.endsWith("/chat/completions")) return raw;
  if (raw.endsWith("/responses")) return `${raw.slice(0, -"/responses".length)}/chat/completions`;
  if (raw.endsWith("/v1")) return `${raw}/chat/completions`;
  if (raw.endsWith("/v1/")) return `${raw}chat/completions`;
  return `${raw.replace(/\/+$/, "")}/chat/completions`;
}
