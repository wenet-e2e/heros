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

export function eventMatchesFilter(event, { backgroundTaskId, sourceTurnId, turnId, type } = {}) {
  if (type && event.type !== type) {
    return false;
  }
  if (turnId && event.turnId !== turnId) {
    return false;
  }
  if (sourceTurnId && event.sourceTurnId !== sourceTurnId && event.turnId !== sourceTurnId) {
    return false;
  }
  if (backgroundTaskId && event.backgroundTaskId !== backgroundTaskId) {
    return false;
  }
  return true;
}

export function filterEvents(events, { backgroundTaskId, sourceTurnId, turnId, type } = {}) {
  return events.filter((event) => eventMatchesFilter(event, { backgroundTaskId, sourceTurnId, turnId, type }));
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

export function summarizeTurns(events) {
  const turns = new Map();
  for (const event of events) {
    if (event.type === 'transcript.completed' && event.turnId) {
      turns.set(event.turnId, {
        ...(turns.get(event.turnId) || {}),
        turnId: event.turnId,
        role: 'user',
        text: event.text || '',
        source: 'transcript',
        contextVersion: event.contextVersion || null,
        createdAt: event.createdAt || null,
      });
    } else if (event.type === 'response.completed' && event.turnId) {
      turns.set(event.turnId, {
        ...(turns.get(event.turnId) || {}),
        turnId: event.turnId,
        role: 'assistant',
        text: event.text || null,
        source: event.source || 'response',
        sourceTurnId: event.sourceTurnId || null,
        backgroundTaskId: event.backgroundTaskId || null,
        createdAt: event.createdAt || null,
      });
    }
  }

  return {
    total: turns.size,
    turns: [...turns.values()].sort((a, b) => {
      const aTime = Date.parse(a.createdAt || 0);
      const bTime = Date.parse(b.createdAt || 0);
      return aTime - bTime;
    }),
  };
}

const ERROR_EVENT_TYPES = new Set([
  'announcement.failed',
  'doctor.failed',
  'error',
  'event_log.malformed',
  'tool_call.failed',
]);

export function summarizeErrors(events) {
  const errors = events
    .filter((event) => ERROR_EVENT_TYPES.has(event.type) || event.type?.endsWith?.('.failed'))
    .map((event) => ({
      type: event.type,
      createdAt: event.createdAt || null,
      source: event.source || null,
      toolName: event.toolName || null,
      backgroundTaskId: event.backgroundTaskId || null,
      turnId: event.turnId || event.sourceTurnId || null,
      message: event.message || event.error?.message || event.error || event.result?.error || null,
      lineNumber: event.lineNumber || null,
    }));

  return {
    total: errors.length,
    errors,
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
  if (result?.action === 'clarify' || result?.action?.endsWith?.('needs_clarification')) {
    return 'needs_clarification';
  }
  if (result?.action?.endsWith?.('_ambiguous')) {
    return 'ambiguous';
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
    } else if (event.type === 'background_task.needs_clarification') {
      current.status = 'needs_clarification';
      current.reason = event.reason || current.reason;
      current.result = {
        action: 'needs_clarification',
        question: event.question || null,
        candidates: event.candidates || null,
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

function stateFromEvent(fallback, event) {
  if (event.type === 'state.changed') {
    return {
      state: event.state || fallback.state,
      previousState: event.previousState || fallback.previousState,
      reason: event.reason || null,
      updatedAt: event.createdAt || fallback.updatedAt,
    };
  }
  if (event.type === 'input_audio.started') {
    return { state: 'listening', previousState: fallback.state, reason: 'input_audio_started', updatedAt: event.createdAt || fallback.updatedAt };
  }
  if (event.type === 'transcript.completed') {
    return { state: 'interacting', previousState: fallback.state, reason: 'transcript_completed', updatedAt: event.createdAt || fallback.updatedAt };
  }
  if (event.type === 'background_task.started' || event.type === 'background_task.progress') {
    return { state: 'background_running', previousState: fallback.state, reason: event.type, updatedAt: event.createdAt || fallback.updatedAt };
  }
  if (event.type === 'response.started') {
    return { state: 'speaking', previousState: fallback.state, reason: 'response_started', updatedAt: event.createdAt || fallback.updatedAt };
  }
  if (event.type === 'response.interrupted') {
    return { state: 'interrupted', previousState: fallback.state, reason: event.reason || 'response_interrupted', updatedAt: event.createdAt || fallback.updatedAt };
  }
  if (event.type === 'response.completed' || event.type === 'background_task.completed' || event.type === 'background_task.cancelled') {
    return { state: 'idle', previousState: fallback.state, reason: event.type, updatedAt: event.createdAt || fallback.updatedAt };
  }
  return fallback;
}

export function summarizeRuntimeState(events) {
  const backgroundTasks = summarizeBackgroundTasks(events);
  const activeBackgroundTasks = backgroundTasks.tasks.filter((task) => ['requested', 'running'].includes(task.status));
  const pendingClarifications = backgroundTasks.tasks.filter((task) => task.status === 'needs_clarification');
  const state = events.reduce(stateFromEvent, {
    state: 'idle',
    previousState: null,
    reason: null,
    updatedAt: null,
  });
  const lastEvent = events.at(-1) || null;
  const lastTurnEvent = [...events].reverse().find((event) => event.turnId || event.sourceTurnId) || null;

  return {
    state: state.state,
    previousState: state.previousState,
    reason: state.reason,
    updatedAt: state.updatedAt,
    speaking: state.state === 'speaking',
    backgroundRunning: activeBackgroundTasks.length > 0,
    activeBackgroundTaskCount: activeBackgroundTasks.length,
    pendingClarificationCount: pendingClarifications.length,
    lastEventType: lastEvent?.type || null,
    lastEventAt: lastEvent?.createdAt || null,
    lastTurnId: lastTurnEvent?.turnId || lastTurnEvent?.sourceTurnId || null,
    lastBackgroundTask: backgroundTasks.tasks[0] || null,
  };
}

export async function followEventLog(logPath, {
  backgroundTaskId,
  fromStart = false,
  onEvent,
  pollMs = 500,
  signal,
  sourceTurnId,
  turnId,
  type,
} = {}) {
  let offset = fromStart || !fs.existsSync(logPath) ? 0 : fs.statSync(logPath).size;
  let pending = '';
  let lineNumber = 0;
  const filters = { backgroundTaskId, sourceTurnId, turnId, type };

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
