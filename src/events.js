import fs from 'node:fs';
import path from 'node:path';

let eventLogPath = null;

export function configureEvents({ logPath } = {}) {
  eventLogPath = logPath || null;
  if (eventLogPath) {
    fs.mkdirSync(path.dirname(eventLogPath), { recursive: true });
  }
}

export function emitEvent(type, payload = {}) {
  const event = {
    ...payload,
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
