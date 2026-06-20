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

function parseSinceMs(since) {
  if (!since) {
    return null;
  }
  const numeric = Number(since);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const parsed = Date.parse(since);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function eventMatchesFilter(event, { backgroundTaskId, since, sourceTurnId, turnId, type } = {}) {
  if (type && event.type !== type) {
    return false;
  }
  const sinceMs = parseSinceMs(since);
  if (since && !Number.isFinite(sinceMs)) {
    return false;
  }
  if (Number.isFinite(sinceMs)) {
    const eventMs = Date.parse(event.createdAt || '');
    if (!Number.isFinite(eventMs) || eventMs < sinceMs) {
      return false;
    }
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

export function filterEvents(events, { backgroundTaskId, since, sourceTurnId, turnId, type } = {}) {
  return events.filter((event) => eventMatchesFilter(event, { backgroundTaskId, since, sourceTurnId, turnId, type }));
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

function timelineEntry(event, taskTypesById = new Map()) {
  const taskType = event.taskType || (event.backgroundTaskId ? taskTypesById.get(event.backgroundTaskId) : null) || null;
  const base = {
    at: event.createdAt || null,
    eventType: event.type,
    turnId: event.turnId || event.sourceTurnId || null,
    backgroundTaskId: event.backgroundTaskId || null,
    taskType,
  };
  if (event.type === 'state.changed') {
    return {
      ...base,
      kind: 'state',
      state: event.state || null,
      previousState: event.previousState || null,
      reason: event.reason || null,
    };
  }
  if (event.type === 'transcript.completed') {
    return {
      ...base,
      kind: 'user_turn',
      text: event.text || '',
      contextVersion: event.contextVersion || null,
    };
  }
  if (event.type === 'response.started' || event.type === 'response.completed' || event.type === 'response.interrupted') {
    return {
      ...base,
      kind: 'response',
      source: event.source || null,
      text: event.text || null,
      reason: event.reason || null,
    };
  }
  if (event.type?.startsWith?.('background_task.')) {
    return {
      ...base,
      kind: 'background_task',
      status: event.type.split('.').at(-1),
      reason: event.reason || null,
      action: event.action || event.result?.action || null,
      question: event.question || null,
    };
  }
  if (event.type?.startsWith?.('announcement.')) {
    return {
      ...base,
      kind: 'announcement',
      status: event.type.split('.').at(-1),
      source: event.source || null,
      outlet: event.outlet || null,
      text: event.text || null,
      reason: event.reason || null,
    };
  }
  if (event.type?.startsWith?.('tool_call.')) {
    return {
      ...base,
      kind: 'tool_call',
      status: event.type.split('.').at(-1),
      toolName: event.toolName || null,
      message: event.message || null,
    };
  }
  if (event.type?.startsWith?.('reminder.')) {
    return {
      ...base,
      kind: 'reminder',
      status: event.type.split('.').at(-1),
      reminderId: event.reminder?.id || event.reminderId || null,
      title: event.reminder?.title || null,
      remindAt: event.reminder?.remindAt || null,
    };
  }
  if (event.type?.startsWith?.('memory.')) {
    return {
      ...base,
      kind: 'memory',
      status: event.type.split('.').at(-1),
      memoryId: event.memory?.id || event.memoryId || null,
      content: event.memory?.content || null,
    };
  }
  if (event.type === 'error' || event.type?.endsWith?.('.failed')) {
    return {
      ...base,
      kind: 'error',
      source: event.source || null,
      message: event.message || event.error?.message || event.error || null,
    };
  }
  return null;
}

export function summarizeTimeline(events) {
  const taskTypesById = new Map();
  for (const event of events) {
    if (event.backgroundTaskId && event.taskType) {
      taskTypesById.set(event.backgroundTaskId, event.taskType);
    }
  }
  const entries = events.map((event) => timelineEntry(event, taskTypesById)).filter(Boolean);
  return {
    total: entries.length,
    entries,
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
  if (result?.action === 'clarify' || result?.action?.endsWith?.('_needs_clarification')) {
    return 'needs_clarification';
  }
  if (result?.action?.endsWith?.('_ambiguous')) {
    return 'ambiguous';
  }
  return 'completed';
}

const PENDING_CLARIFICATION_TASK_TYPES = new Set([
  'cancel_reminder',
  'forget_memory',
  'reminder',
  'update_memory',
  'update_reminder',
]);
const PENDING_CLARIFICATION_STATUSES = new Set(['ambiguous', 'needs_clarification']);

function unresolvedPendingClarifications(tasks) {
  const newerTaskTypes = new Set();
  const pending = [];
  for (const task of tasks) {
    const taskType = task.taskType || task.type || null;
    if (
      PENDING_CLARIFICATION_STATUSES.has(task.status)
      && PENDING_CLARIFICATION_TASK_TYPES.has(taskType)
      && !newerTaskTypes.has(taskType)
    ) {
      pending.push(task);
    }
    if (taskType) {
      newerTaskTypes.add(taskType);
    }
  }
  return pending;
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
      const nextStatus = statusFromCompletion(event.result);
      current.status = nextStatus;
      current.result = ['ambiguous', 'needs_clarification'].includes(nextStatus)
        ? { ...(current.result || {}), ...(event.result || {}) }
        : event.result || null;
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

export function summarizeBackgroundTaskDetail(events, backgroundTaskId) {
  const task = summarizeBackgroundTasks(events).tasks.find((item) => item.backgroundTaskId === backgroundTaskId) || null;
  if (!task) {
    return {
      backgroundTaskId,
      found: false,
      task: null,
      turns: [],
      timeline: [],
      events: [],
    };
  }

  const turnIds = new Set([
    task.turnId,
    task.responseTurnId,
  ].filter(Boolean));

  for (const event of events) {
    if (event.backgroundTaskId !== backgroundTaskId) {
      continue;
    }
    if (event.turnId) {
      turnIds.add(event.turnId);
    }
    if (event.sourceTurnId) {
      turnIds.add(event.sourceTurnId);
    }
  }

  const relatedEvents = events.filter((event) => (
    event.backgroundTaskId === backgroundTaskId
    || turnIds.has(event.turnId)
    || turnIds.has(event.sourceTurnId)
  ));
  const turns = summarizeTurns(relatedEvents).turns.filter((turn) => (
    turn.backgroundTaskId === backgroundTaskId
    || turnIds.has(turn.turnId)
    || turnIds.has(turn.sourceTurnId)
  ));

  return {
    backgroundTaskId,
    found: true,
    task,
    turns,
    timeline: summarizeTimeline(relatedEvents).entries,
    events: relatedEvents,
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
  const pendingClarifications = unresolvedPendingClarifications(backgroundTasks.tasks);
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
    pendingClarifications,
    lastEventType: lastEvent?.type || null,
    lastEventAt: lastEvent?.createdAt || null,
    lastTurnId: lastTurnEvent?.turnId || lastTurnEvent?.sourceTurnId || null,
    lastBackgroundTask: backgroundTasks.tasks[0] || null,
  };
}

export function summarizeSharedContext(
  events,
  { bootstrapFiles = [], localTaskRouter = { handledLocally: [] }, memories = [], reminders = [] } = {},
) {
  const turnSummary = summarizeTurns(events);
  const taskSummary = summarizeBackgroundTasks(events);
  const runtimeState = summarizeRuntimeState(events);
  const contextVersion = events.reduce((max, event) => (
    Number.isFinite(event.contextVersion) ? Math.max(max, event.contextVersion) : max
  ), 0);
  const scheduledReminders = reminders
    .filter((reminder) => reminder.status === 'scheduled')
    .sort((a, b) => Date.parse(a.remindAt) - Date.parse(b.remindAt));
  const activeBackgroundTasks = taskSummary.tasks.filter((task) => ['requested', 'running'].includes(task.status));
  const pendingClarifications = unresolvedPendingClarifications(taskSummary.tasks);

  return {
    contextVersion,
    runtimeState,
    turns: {
      total: turnSummary.total,
      recent: turnSummary.turns.slice(-10),
    },
    backgroundTasks: {
      total: taskSummary.total,
      active: activeBackgroundTasks,
      pendingClarifications,
      recent: taskSummary.tasks.slice(0, 10),
    },
    localTaskRouter: {
      handledLocally: [...(localTaskRouter.handledLocally || [])],
    },
    reminders: {
      total: reminders.length,
      scheduled: scheduledReminders.length,
      nextScheduled: scheduledReminders[0] || null,
    },
    longTermMemory: {
      total: memories.length,
      items: memories.map((memory) => ({
        id: memory.id,
        content: memory.content,
        updatedAt: memory.updatedAt,
      })),
    },
    bootstrap: {
      files: bootstrapFiles.map((filePath) => filePath.split(/[\\/]/).at(-1)),
    },
  };
}

export async function followEventLog(logPath, {
  backgroundTaskId,
  fromStart = false,
  onEvent,
  pollMs = 500,
  signal,
  since,
  sourceTurnId,
  turnId,
  type,
} = {}) {
  let offset = fromStart || !fs.existsSync(logPath) ? 0 : fs.statSync(logPath).size;
  let pending = '';
  let lineNumber = 0;
  const filters = { backgroundTaskId, since, sourceTurnId, turnId, type };

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
