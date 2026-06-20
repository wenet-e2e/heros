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

function statusFromCompletion(result) {
  if (result?.action === 'timeout') {
    return 'timeout';
  }
  if (result?.action === 'cancelled') {
    return 'cancelled';
  }
  if (result?.action === 'failed') {
    return 'failed';
  }
  return 'completed';
}

export function summarizeBackgroundTasks(events) {
  const tasks = new Map();
  for (const event of events) {
    if (!event.backgroundTaskId) {
      continue;
    }
    const current = tasks.get(event.backgroundTaskId) || {
      backgroundTaskId: event.backgroundTaskId,
      taskType: null,
      turnId: null,
      status: 'observed',
      model: null,
      reason: null,
      progress: null,
      result: null,
      startedAt: null,
      updatedAt: null,
      lastEventType: null,
      responseTurnId: null,
      responseSource: null,
    };

    current.turnId ||= event.turnId || null;
    current.taskType ||= event.taskType || null;
    current.updatedAt = event.createdAt || current.updatedAt;
    current.lastEventType = event.type;

    if (event.type === 'background_task.requested') {
      current.status = 'requested';
      current.reason = event.reason || current.reason;
    } else if (event.type === 'background_task.started') {
      current.status = 'running';
      current.startedAt = event.createdAt || current.startedAt;
      current.model = event.model || current.model;
    } else if (event.type === 'background_task.progress') {
      current.status = 'running';
      current.progress = {
        stage: event.stage || null,
        action: event.action || null,
      };
    } else if (event.type === 'background_task.cancelled') {
      current.status = 'cancelled';
      current.reason = event.reason || current.reason;
    } else if (event.type === 'background_task.completed') {
      current.status = statusFromCompletion(event.result);
      current.result = event.result || null;
    } else if (event.type === 'tool_call.failed') {
      current.status = 'tool_failed';
      current.result = {
        action: 'tool_failed',
        toolName: event.toolName || null,
        error: event.message || null,
      };
    } else if (event.type === 'response.completed') {
      current.responseTurnId = event.turnId || current.responseTurnId;
      current.responseSource = event.source || current.responseSource;
    }

    tasks.set(event.backgroundTaskId, current);
  }

  return {
    total: tasks.size,
    tasks: [...tasks.values()].sort((a, b) => {
      const aTime = Date.parse(a.updatedAt || a.startedAt || 0);
      const bTime = Date.parse(b.updatedAt || b.startedAt || 0);
      return bTime - aTime;
    }),
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
