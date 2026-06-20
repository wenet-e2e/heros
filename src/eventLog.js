import fs from 'node:fs';

export function readEventLog(logPath) {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const text = fs.readFileSync(logPath, 'utf8').trim();
  if (!text) {
    return [];
  }
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      return {
        type: 'event_log.malformed',
        lineNumber: index + 1,
        message: error.message,
      };
    }
  });
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
