import fs from 'node:fs';

export function readEventLog(logPath) {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

export function filterEvents(events, { type } = {}) {
  if (!type) {
    return events;
  }
  return events.filter((event) => event.type === type);
}

export function summarizeEvents(events) {
  const byType = events.reduce((acc, event) => {
    acc[event.type] = (acc[event.type] || 0) + 1;
    return acc;
  }, {});
  const last = events.at(-1) || null;
  return {
    total: events.length,
    byType,
    lastEventType: last?.type || null,
    lastEventAt: last?.createdAt || null,
  };
}
