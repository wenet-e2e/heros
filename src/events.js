import fs from 'node:fs';
import path from 'node:path';

let eventLogPath = null;
const SECRET_REDACTIONS = [
  /\b(DASHSCOPE_API_KEY|API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s,;]+/gi,
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
];

export function configureEvents({ logPath } = {}) {
  eventLogPath = logPath || null;
  if (eventLogPath) {
    fs.mkdirSync(path.dirname(eventLogPath), { recursive: true });
  }
}

function redactString(value) {
  return SECRET_REDACTIONS.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), value);
}

export function redactSecrets(value) {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSecrets(item)]),
    );
  }
  return value;
}

export function emitEvent(type, payload = {}) {
  const event = {
    ...redactSecrets(payload),
    type,
    createdAt: new Date().toISOString(),
  };
  const line = JSON.stringify(event);
  process.stdout.write(`[event] ${line}\n`);
  if (eventLogPath) {
    fs.appendFileSync(eventLogPath, `${line}\n`);
  }
  return event;
}
