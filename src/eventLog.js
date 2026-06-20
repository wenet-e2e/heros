import fs from 'node:fs';

function parseEventLine(line, lineNumber) {
  try {
    return JSON.parse(line);
  } catch (error) {
    return {
      type: 'event_log.malformed',
      lineNumber,
      message: error.message,
    };
  }
}

export function readEventLog(logPath) {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const text = fs.readFileSync(logPath, 'utf8').trim();
  if (!text) {
    return [];
  }
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => parseEventLine(line, index + 1));
}

export function eventMatchesFilter(event, { backgroundTaskId, turnId, type } = {}) {
  if (type && event.type !== type) {
    return false;
  }
  if (turnId && event.turnId !== turnId) {
    return false;
  }
  if (backgroundTaskId && event.backgroundTaskId !== backgroundTaskId) {
    return false;
  }
  return true;
}

export function filterEvents(events, { backgroundTaskId, turnId, type } = {}) {
  return events.filter((event) => eventMatchesFilter(event, { backgroundTaskId, turnId, type }));
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

export async function followEventLog(logPath, {
  backgroundTaskId,
  fromStart = false,
  onEvent,
  pollMs = 500,
  signal,
  turnId,
  type,
} = {}) {
  let offset = fromStart || !fs.existsSync(logPath) ? 0 : fs.statSync(logPath).size;
  let pending = '';
  let lineNumber = 0;
  const filters = { backgroundTaskId, turnId, type };

  function readNewEvents() {
    if (!fs.existsSync(logPath)) {
      return;
    }
    const stat = fs.statSync(logPath);
    if (stat.size < offset) {
      offset = 0;
      pending = '';
      lineNumber = 0;
    }
    if (stat.size === offset) {
      return;
    }
    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      offset = stat.size;
      pending += buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }

    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      if (!line) {
        continue;
      }
      lineNumber += 1;
      const event = parseEventLine(line, lineNumber);
      if (eventMatchesFilter(event, filters)) {
        onEvent?.(event);
      }
    }
  }

  return new Promise((resolve) => {
    const interval = setInterval(readNewEvents, Math.max(50, pollMs));
    const stop = () => {
      clearInterval(interval);
      resolve();
    };
    signal?.addEventListener('abort', stop, { once: true });
    readNewEvents();
    if (signal?.aborted) {
      stop();
    }
  });
}
