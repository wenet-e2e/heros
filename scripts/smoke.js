#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { configureEvents, emitEvent } from '../src/events.js';
import { BackgroundAgent } from '../src/backgroundAgent.js';
import { MemoryStore } from '../src/memoryStore.js';
import { ReminderStore } from '../src/reminders.js';
import { ReminderScheduler } from '../src/reminderScheduler.js';
import { SharedContext } from '../src/context.js';
import { TaskRouter } from '../src/taskRouter.js';
import { likelyCancelReminder, likelyForgetMemory, likelyListMemory, likelyListReminders, likelyReminder } from '../src/intents.js';
import {
  filterEvents,
  followEventLog,
  readEventLog,
  summarizeBackgroundTasks,
  summarizeEvents,
  summarizeRuntimeState,
} from '../src/eventLog.js';
import { VoiceLoop } from '../src/voiceLoop.js';
import { ensureAgentBootstrap, readAgentBootstrap } from '../src/bootstrap.js';
import { connectRealtimeWithRetry } from '../src/realtimeRetry.js';
import { DashScopeRealtimeClient } from '../src/realtimeClient.js';
import { getConfig } from '../src/config.js';
import { CliInteractionModel } from '../src/interactionModel.js';
import { DashScopeClient } from '../src/dashscope.js';

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function testEventLog() {
  const dir = createTempDir('heros-events-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  emitEvent('smoke.event_log', { ok: true, type: 'payload_must_not_override_event_type' });
  emitEvent('smoke.secret_redaction', {
    backgroundTaskId: 'task_smoke',
    apiKey: 'plain-secret',
    nested: { token: 'nested-secret' },
    text: 'DASHSCOPE_API_KEY=abc123 Bearer secret-token',
    turnId: 'turn_smoke',
  });
  const events = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
  const event = events[0];
  if (event.type !== 'smoke.event_log' || event.ok !== true) {
    throw new Error('event log smoke failed');
  }
  const redacted = events[1];
  if (redacted.text.includes('abc123') || redacted.text.includes('secret-token')) {
    throw new Error('event secret redaction smoke failed');
  }
  if (redacted.apiKey !== '[REDACTED]' || redacted.nested.token !== '[REDACTED]') {
    throw new Error('event secret key redaction smoke failed');
  }
  const summary = summarizeEvents(readEventLog(logPath));
  if (summary.total !== 2 || summary.byType['smoke.event_log'] !== 1) {
    throw new Error('event summary smoke failed');
  }
  const filtered = filterEvents(readEventLog(logPath), { type: 'smoke.secret_redaction' });
  if (filtered.length !== 1 || filtered[0].type !== 'smoke.secret_redaction') {
    throw new Error('event filter smoke failed');
  }
  const turnFiltered = filterEvents(readEventLog(logPath), { turnId: 'turn_smoke' });
  if (turnFiltered.length !== 1 || turnFiltered[0].turnId !== 'turn_smoke') {
    throw new Error('event turn filter smoke failed');
  }
  const taskFiltered = filterEvents(readEventLog(logPath), { backgroundTaskId: 'task_smoke' });
  if (taskFiltered.length !== 1 || taskFiltered[0].backgroundTaskId !== 'task_smoke') {
    throw new Error('event background task filter smoke failed');
  }
  fs.appendFileSync(logPath, 'not-json\n');
  const malformed = readEventLog(logPath).at(-1);
  if (malformed.type !== 'event_log.malformed' || malformed.lineNumber !== 3) {
    throw new Error('malformed event log smoke failed');
  }
  emitEvent('smoke.source_turn', { sourceTurnId: 'turn_source' });
  const sourceFiltered = filterEvents(readEventLog(logPath), { sourceTurnId: 'turn_source' });
  if (sourceFiltered.length !== 1 || sourceFiltered[0].sourceTurnId !== 'turn_source') {
    throw new Error('event source turn filter smoke failed');
  }

  const controller = new AbortController();
  const followed = [];
  const following = followEventLog(logPath, {
    pollMs: 50,
    signal: controller.signal,
    type: 'smoke.follow',
    onEvent(event) {
      followed.push(event);
    },
  });
  emitEvent('smoke.follow', { turnId: 'turn_follow' });
  await new Promise((resolve) => setTimeout(resolve, 120));
  controller.abort('smoke_complete');
  await following;
  if (followed.length !== 1 || followed[0].turnId !== 'turn_follow') {
    throw new Error('event follow smoke failed');
  }
  configureEvents();
}

function testReminderScheduler() {
  const dir = createTempDir('heros-reminder-');
  const store = new ReminderStore(dir);
  store.create({
    title: 'smoke',
    remindAt: new Date(Date.now() - 1000).toISOString(),
    note: 'test',
  });
  const scheduler = new ReminderScheduler({ reminderStore: store, pollMs: 1000 });
  let triggeredByListener = false;
  scheduler.onTriggered(() => {
    triggeredByListener = true;
  });
  scheduler.start();
  scheduler.stop();
  const item = store.list()[0];
  if (item.status !== 'triggered') {
    throw new Error('reminder scheduler smoke failed');
  }
  if (!triggeredByListener) {
    throw new Error('reminder trigger listener smoke failed');
  }
  if (store.cancel(item.id) !== null || store.list()[0].status !== 'triggered') {
    throw new Error('triggered reminder should not be cancellable');
  }

  let refused = false;
  try {
    store.create({ title: 'bad', remindAt: 'not-a-date', note: '' });
  } catch {
    refused = true;
  }
  if (!refused) {
    throw new Error('invalid reminder time was not refused');
  }
  refused = false;
  try {
    store.create({ title: '', remindAt: new Date(Date.now() + 60000).toISOString(), note: '' });
  } catch {
    refused = true;
  }
  if (!refused) {
    throw new Error('empty reminder title was not refused');
  }

  const future = store.create({
    title: 'future',
    remindAt: new Date(Date.now() + 60000).toISOString(),
    note: '',
  });
  const cancelled = store.cancel(future.id);
  if (cancelled.status !== 'cancelled') {
    throw new Error('reminder cancellation smoke failed');
  }
}

function testMemoryStore() {
  const dir = createTempDir('heros-memory-');
  const store = new MemoryStore(path.join(dir, 'MEMORY.md'));
  const memory = store.create('用户喜欢简洁的语音回答');
  const updated = store.update(memory.id, '用户喜欢简洁但有温度的语音回答');
  if (!updated?.content.includes('温度')) {
    throw new Error('memory update smoke failed');
  }
  if (!store.delete(memory.id) || store.list().length !== 0) {
    throw new Error('memory delete smoke failed');
  }

  let refused = false;
  try {
    store.create('Bearer abc');
  } catch {
    refused = true;
  }
  if (!refused) {
    throw new Error('memory secret refusal smoke failed');
  }
}

function testBackgroundTaskSummary() {
  const dir = createTempDir('heros-task-summary-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  emitEvent('background_task.requested', {
    backgroundTaskId: 'task_summary',
    turnId: 'turn_summary_user',
    taskType: 'reminder',
    reason: 'likely_reminder',
  });
  emitEvent('background_task.started', {
    backgroundTaskId: 'task_summary',
    turnId: 'turn_summary_user',
    taskType: 'reminder',
    model: 'fake',
  });
  emitEvent('background_task.progress', {
    backgroundTaskId: 'task_summary',
    turnId: 'turn_summary_user',
    stage: 'agent_decision',
    action: 'create_reminder',
  });
  emitEvent('background_task.completed', {
    backgroundTaskId: 'task_summary',
    turnId: 'turn_summary_user',
    result: { action: 'create_reminder', reminderId: 'reminder_summary' },
  });
  emitEvent('response.completed', {
    backgroundTaskId: 'task_summary',
    turnId: 'turn_summary_assistant',
    source: 'background_agent',
  });
  const summary = summarizeBackgroundTasks(readEventLog(logPath));
  const task = summary.tasks[0];
  if (
    summary.total !== 1
    || task.status !== 'completed'
    || task.taskType !== 'reminder'
    || task.progress.action !== 'create_reminder'
    || task.responseTurnId !== 'turn_summary_assistant'
  ) {
    throw new Error('background task summary smoke failed');
  }
  configureEvents();
}

function testRuntimeStateSummary() {
  const dir = createTempDir('heros-runtime-state-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  emitEvent('state.changed', {
    previousState: 'idle',
    state: 'listening',
    reason: 'smoke_start',
  });
  emitEvent('transcript.completed', {
    text: '提醒我喝水',
    turnId: 'turn_runtime_state',
  });
  emitEvent('background_task.started', {
    backgroundTaskId: 'task_runtime_state',
    turnId: 'turn_runtime_state',
    taskType: 'reminder',
    model: 'fake',
  });
  emitEvent('background_task.needs_clarification', {
    backgroundTaskId: 'task_runtime_state',
    turnId: 'turn_runtime_state',
    question: '什么时候提醒？',
    reason: 'missing_time',
  });
  emitEvent('background_task.completed', {
    backgroundTaskId: 'task_runtime_state',
    turnId: 'turn_runtime_state',
    result: { action: 'clarify' },
  });
  const summary = summarizeRuntimeState(readEventLog(logPath));
  if (
    summary.state !== 'idle'
    || summary.pendingClarificationCount !== 1
    || summary.lastTurnId !== 'turn_runtime_state'
    || summary.lastBackgroundTask.status !== 'needs_clarification'
  ) {
    throw new Error('runtime state summary smoke failed');
  }
  configureEvents();
}

function testAgentBootstrap() {
  const dir = createTempDir('heros-bootstrap-');
  const bootstrap = ensureAgentBootstrap(dir);
  const content = readAgentBootstrap(bootstrap.files);
  if (!content['AGENTS.md']?.includes('Mission') || !content['SOUL.md']?.includes('Voice')) {
    throw new Error('agent bootstrap read smoke failed');
  }
}

function testCliStatusOutput() {
  const dir = createTempDir('heros-status-');
  const result = spawnSync(process.execPath, ['src/cli.js', '--status'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: dir,
      HEROS_EVENT_LOG_PATH: path.join(dir, 'events.ndjson'),
      HEROS_BACKGROUND_TASK_TIMEOUT_MS: '1234',
    },
  });
  if (result.status !== 0) {
    throw new Error(`cli status smoke failed: ${result.stderr || result.stdout}`);
  }
  const status = JSON.parse(result.stdout);
  if (status.backgroundTaskTimeoutMs !== 1234 || status.dataDir !== dir) {
    throw new Error('cli status config smoke failed');
  }
  if (status.backgroundTasks.total !== 0 || typeof status.backgroundTasks.byStatus !== 'object') {
    throw new Error('cli status background task summary smoke failed');
  }
  if (status.runtimeState.state !== 'idle' || status.runtimeState.pendingClarificationCount !== 0) {
    throw new Error('cli status runtime state smoke failed');
  }
}

function testCliRuntimeStateCommand() {
  const dir = createTempDir('heros-cli-runtime-state-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  emitEvent('state.changed', {
    previousState: 'listening',
    state: 'speaking',
    reason: 'response_created',
    turnId: 'turn_cli_runtime_state',
  });
  configureEvents();
  const result = spawnSync(process.execPath, ['src/cli.js', '--runtime-state'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: dir,
      HEROS_EVENT_LOG_PATH: logPath,
    },
  });
  if (result.status !== 0) {
    throw new Error(`cli runtime state smoke failed: ${result.stderr || result.stdout}`);
  }
  const state = JSON.parse(result.stdout);
  if (state.state !== 'speaking' || !state.speaking || state.lastTurnId !== 'turn_cli_runtime_state') {
    throw new Error('cli runtime state output smoke failed');
  }
}

function testCliReminderCommands() {
  const dir = createTempDir('heros-cli-reminders-');
  const store = new ReminderStore(dir);
  const reminder = store.create({
    title: '喝水',
    remindAt: new Date(Date.now() + 60000).toISOString(),
    note: '',
  });
  const env = {
    ...process.env,
    HEROS_DATA_DIR: dir,
    HEROS_EVENT_LOG_PATH: path.join(dir, 'events.ndjson'),
  };
  const listResult = spawnSync(process.execPath, ['src/cli.js', '--reminders'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (listResult.status !== 0) {
    throw new Error(`cli reminders smoke failed: ${listResult.stderr || listResult.stdout}`);
  }
  const reminders = JSON.parse(listResult.stdout);
  if (reminders.length !== 1 || reminders[0].id !== reminder.id) {
    throw new Error('cli reminders list smoke failed');
  }

  const cancelResult = spawnSync(process.execPath, ['src/cli.js', '--cancel-reminder', reminder.id], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (cancelResult.status !== 0) {
    throw new Error(`cli cancel reminder smoke failed: ${cancelResult.stderr || cancelResult.stdout}`);
  }
  const cancelled = JSON.parse(cancelResult.stdout);
  if (cancelled.status !== 'cancelled' || store.list()[0].status !== 'cancelled') {
    throw new Error('cli cancel reminder output smoke failed');
  }
}

function testCliMemoryCommands() {
  const dir = createTempDir('heros-cli-memory-');
  const env = {
    ...process.env,
    HEROS_DATA_DIR: dir,
    HEROS_EVENT_LOG_PATH: path.join(dir, 'events.ndjson'),
  };

  const rememberResult = spawnSync(process.execPath, ['src/cli.js', '--remember', '用户喜欢安静的语音风格'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (rememberResult.status !== 0) {
    throw new Error(`cli remember smoke failed: ${rememberResult.stderr || rememberResult.stdout}`);
  }
  const memory = JSON.parse(rememberResult.stdout);
  if (!memory.id || !memory.content.includes('安静')) {
    throw new Error('cli remember output smoke failed');
  }

  const updateResult = spawnSync(process.execPath, ['src/cli.js', '--update-memory', memory.id, '用户喜欢安静但有温度的语音风格'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (updateResult.status !== 0) {
    throw new Error(`cli update memory smoke failed: ${updateResult.stderr || updateResult.stdout}`);
  }
  const updated = JSON.parse(updateResult.stdout);
  if (!updated.content.includes('温度')) {
    throw new Error('cli update memory output smoke failed');
  }

  const listResult = spawnSync(process.execPath, ['src/cli.js', '--memories'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (listResult.status !== 0) {
    throw new Error(`cli memories smoke failed: ${listResult.stderr || listResult.stdout}`);
  }
  const memories = JSON.parse(listResult.stdout);
  if (memories.length !== 1 || memories[0].id !== memory.id) {
    throw new Error('cli memories list smoke failed');
  }

  const forgetResult = spawnSync(process.execPath, ['src/cli.js', '--forget-memory', memory.id], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (forgetResult.status !== 0) {
    throw new Error(`cli forget memory smoke failed: ${forgetResult.stderr || forgetResult.stdout}`);
  }
  const forgotten = JSON.parse(forgetResult.stdout);
  if (!forgotten.deleted) {
    throw new Error('cli forget memory output smoke failed');
  }
}

function testConfigNumberFallback() {
  const previous = process.env.HEROS_BACKGROUND_TASK_TIMEOUT_MS;
  process.env.HEROS_BACKGROUND_TASK_TIMEOUT_MS = 'not-a-number';
  const fallbackConfig = getConfig({ requireApiKey: false });
  process.env.HEROS_BACKGROUND_TASK_TIMEOUT_MS = '1234';
  const overrideConfig = getConfig({ requireApiKey: false });
  if (previous === undefined) {
    delete process.env.HEROS_BACKGROUND_TASK_TIMEOUT_MS;
  } else {
    process.env.HEROS_BACKGROUND_TASK_TIMEOUT_MS = previous;
  }
  if (fallbackConfig.backgroundTaskTimeoutMs !== 60000 || overrideConfig.backgroundTaskTimeoutMs !== 1234) {
    throw new Error('config number fallback smoke failed');
  }
}

async function testBackgroundAgentInvalidReminder() {
  const dir = createTempDir('heros-agent-');
  const reminderStore = new ReminderStore(dir);
  const agent = new BackgroundAgent({
    reminderStore,
    model: 'fake',
    timeZone: 'Asia/Shanghai',
    client: {
      async text() {
        return JSON.stringify({
          action: 'create_reminder',
          title: 'bad',
          remindAt: 'not-a-date',
          note: '',
          clarifyingQuestion: '',
        });
      },
    },
  });
  const result = await agent.handleTask({ userText: '提醒我', context: {} });
  if (result.type !== 'reminder_failed') {
    throw new Error('background agent invalid reminder smoke failed');
  }
}

async function testBackgroundAgentPastReminder() {
  const dir = createTempDir('heros-agent-past-');
  const reminderStore = new ReminderStore(dir);
  const agent = new BackgroundAgent({
    reminderStore,
    model: 'fake',
    timeZone: 'Asia/Shanghai',
    client: {
      async text() {
        return JSON.stringify({
          action: 'create_reminder',
          title: 'past',
          remindAt: '2000-01-01T09:00:00+08:00',
          note: '',
          clarifyingQuestion: '',
        });
      },
    },
  });
  const result = await agent.handleTask({ userText: '提醒我', context: {} });
  if (result.type !== 'reminder_failed' || reminderStore.list().length !== 0) {
    throw new Error('background agent past reminder smoke failed');
  }
}

async function testBackgroundAgentLifecycleEvents() {
  const dir = createTempDir('heros-agent-events-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  const reminderStore = new ReminderStore(dir);
  const agent = new BackgroundAgent({
    reminderStore,
    model: 'fake',
    timeZone: 'Asia/Shanghai',
    client: {
      async text() {
        return JSON.stringify({
          action: 'none',
          title: '',
          remindAt: '',
          note: '',
          clarifyingQuestion: '',
        });
      },
    },
  });
  await agent.handleTask({
    backgroundTaskId: 'task_agent_events',
    turnId: 'turn_agent_events',
    userText: '你好',
    context: {},
  });
  const events = readEventLog(logPath);
  const started = events.find((event) => event.type === 'agent.started');
  const completed = events.find((event) => event.type === 'agent.completed');
  const progress = events.find((event) => event.type === 'background_task.progress');
  if (
    started?.backgroundTaskId !== 'task_agent_events'
    || completed?.action !== 'none'
    || progress?.stage !== 'agent_decision'
  ) {
    throw new Error('background agent lifecycle events smoke failed');
  }
  configureEvents();
}

async function testBackgroundAgentAbortBeforeToolCall() {
  const dir = createTempDir('heros-agent-abort-');
  const reminderStore = new ReminderStore(dir);
  const controller = new AbortController();
  const agent = new BackgroundAgent({
    reminderStore,
    model: 'fake',
    timeZone: 'Asia/Shanghai',
    client: {
      async text() {
        controller.abort('user_speech_started');
        return JSON.stringify({
          action: 'create_reminder',
          title: '喝水',
          remindAt: new Date(Date.now() + 60000).toISOString(),
          note: '',
          clarifyingQuestion: '',
        });
      },
    },
  });
  let cancelled = false;
  try {
    await agent.handleTask({ userText: '提醒我喝水', context: {}, signal: controller.signal });
  } catch (error) {
    cancelled = error.name === 'BackgroundTaskCancelledError';
  }
  if (!cancelled || reminderStore.list().length !== 0) {
    throw new Error('background agent abort before tool call smoke failed');
  }
}

async function testDashScopeExternalAbortReason() {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
  try {
    const client = new DashScopeClient({
      apiKey: 'test',
      baseUrl: 'https://example.com',
      timeoutMs: 1000,
    });
    const controller = new AbortController();
    const error = new Error('cancelled externally');
    error.name = 'BackgroundTaskCancelledError';
    const request = client.text({
      model: 'fake',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    });
    controller.abort(error);
    let preserved = false;
    try {
      await request;
    } catch (caught) {
      preserved = caught === error && caught.name === 'BackgroundTaskCancelledError';
    }
    if (!preserved) {
      throw new Error('dashscope external abort reason smoke failed');
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function testTaskRouterMemory() {
  const dir = createTempDir('heros-router-memory-');
  const memoryStore = new MemoryStore(path.join(dir, 'MEMORY.md'));
  const context = new SharedContext();
  const router = new TaskRouter({
    context,
    memoryStore,
    backgroundAgent: null,
  });
  const result = router.handleMemory('记住用户喜欢安静的语音风格');
  if (result.type !== 'memory_created' || memoryStore.list().length !== 1) {
    throw new Error('task router memory smoke failed');
  }
  if (!result.backgroundTaskId || !result.backgroundTaskId.startsWith('task_')) {
    throw new Error('task router memory background task id smoke failed');
  }
  if (context.snapshot().longTermMemory.length !== 1) {
    throw new Error('task router memory context smoke failed');
  }
  if (context.snapshot().backgroundTasks.length !== 1) {
    throw new Error('task router memory background task smoke failed');
  }
}

async function testTaskRouterTurnLink() {
  const dir = createTempDir('heros-router-turn-link-');
  const memoryStore = new MemoryStore(path.join(dir, 'MEMORY.md'));
  const context = new SharedContext();
  const router = new TaskRouter({
    context,
    memoryStore,
    backgroundAgent: null,
  });
  await router.maybeHandle('记住用户喜欢短回答', { turnId: 'turn_smoke' });
  if (context.snapshot().backgroundTasks.at(-1).turnId !== 'turn_smoke') {
    throw new Error('task router turn link smoke failed');
  }
}

async function testTaskRouterBackgroundFailure() {
  const context = new SharedContext();
  const router = new TaskRouter({
    context,
    memoryStore: null,
    reminderStore: null,
    backgroundAgent: {
      async handleTask() {
        throw new Error('model returned invalid JSON');
      },
    },
  });
  const result = await router.maybeHandle('明天九点提醒我喝水', { turnId: 'turn_failure' });
  if (result.type !== 'background_failed' || !result.message) {
    throw new Error('task router background failure smoke failed');
  }
  const task = context.snapshot().backgroundTasks.at(-1);
  if (task.status !== 'background_failed' || task.turnId !== 'turn_failure') {
    throw new Error('task router background failure context smoke failed');
  }
}

async function testTaskRouterBackgroundClarification() {
  const context = new SharedContext();
  const router = new TaskRouter({
    context,
    memoryStore: null,
    reminderStore: null,
    backgroundAgent: {
      async handleTask() {
        return {
          type: 'clarify',
          message: '你想让我什么时候提醒？',
        };
      },
    },
  });
  const result = await router.maybeHandle('提醒我喝水', { turnId: 'turn_clarify' });
  if (result.type !== 'clarify' || !result.message.includes('什么时候')) {
    throw new Error('task router background clarification smoke failed');
  }
  const task = context.snapshot().backgroundTasks.at(-1);
  if (task.status !== 'needs_clarification' || task.turnId !== 'turn_clarify') {
    throw new Error('task router background clarification context smoke failed');
  }
}

async function testTaskRouterBackgroundTimeout() {
  const context = new SharedContext();
  let aborted = false;
  const router = new TaskRouter({
    context,
    memoryStore: null,
    reminderStore: null,
    taskTimeoutMs: 1,
    backgroundAgent: {
      async handleTask({ signal }) {
        signal.addEventListener('abort', () => {
          aborted = true;
        }, { once: true });
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { type: 'none', message: '' };
      },
    },
  });
  const result = await router.maybeHandle('明天九点提醒我喝水', { turnId: 'turn_timeout' });
  if (result.type !== 'background_timeout' || !aborted) {
    throw new Error('task router background timeout smoke failed');
  }
  const task = context.snapshot().backgroundTasks.at(-1);
  if (task.status !== 'background_timeout' || task.turnId !== 'turn_timeout') {
    throw new Error('task router background timeout context smoke failed');
  }
}

async function testTaskRouterBackgroundCancellation() {
  const context = new SharedContext();
  const controller = new AbortController();
  let aborted = false;
  const router = new TaskRouter({
    context,
    memoryStore: null,
    reminderStore: null,
    taskTimeoutMs: 1000,
    backgroundAgent: {
      async handleTask({ signal }) {
        signal.addEventListener('abort', () => {
          aborted = true;
        }, { once: true });
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { type: 'none', message: '' };
      },
    },
  });
  const handling = router.maybeHandle('明天九点提醒我喝水', {
    turnId: 'turn_cancel',
    signal: controller.signal,
  });
  controller.abort('user_speech_started');
  const result = await handling;
  if (result.type !== 'background_cancelled' || !aborted || result.message) {
    throw new Error('task router background cancellation smoke failed');
  }
  const task = context.snapshot().backgroundTasks.at(-1);
  if (task.status !== 'background_cancelled' || task.turnId !== 'turn_cancel') {
    throw new Error('task router background cancellation context smoke failed');
  }
}

function testTaskRouterForgetMemory() {
  const dir = createTempDir('heros-router-forget-memory-');
  const memoryStore = new MemoryStore(path.join(dir, 'MEMORY.md'));
  memoryStore.create('用户喜欢安静的语音风格');
  const context = new SharedContext();
  context.setLongTermMemory(memoryStore.list());
  const router = new TaskRouter({
    context,
    memoryStore,
    backgroundAgent: null,
  });
  const result = router.handleForgetMemory('忘记安静的语音风格');
  if (result.type !== 'memory_deleted' || memoryStore.list().length !== 0) {
    throw new Error('task router forget memory smoke failed');
  }
  if (context.snapshot().longTermMemory.length !== 0) {
    throw new Error('task router forget memory context smoke failed');
  }
}

function testSharedContextRedaction() {
  const context = new SharedContext();
  const turn = context.addTurn('user', 'Bearer secret-token');
  if (!turn.id?.startsWith('turn_')) {
    throw new Error('shared context turn id smoke failed');
  }
  if (context.snapshot().turns[0].content.includes('secret-token')) {
    throw new Error('shared context redaction smoke failed');
  }
}

async function testCliBackgroundResponseCorrelation() {
  const dir = createTempDir('heros-cli-correlation-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  const context = new SharedContext();
  const model = new CliInteractionModel({
    client: null,
    model: 'fake',
    context,
    taskRouter: {
      async maybeHandle() {
        return {
          backgroundTaskId: 'task_response',
          message: '已创建提醒：喝水',
          source: 'background_agent',
        };
      },
    },
  });
  await model.respond('明天九点提醒我喝水');
  const completed = readEventLog(logPath).find((event) => event.type === 'response.completed');
  if (completed?.backgroundTaskId !== 'task_response') {
    throw new Error('cli background response correlation smoke failed');
  }
  configureEvents();
}

function testIntentBoundaries() {
  if (likelyReminder('你记得我喜欢什么语音风格吗？')) {
    throw new Error('memory question was misclassified as reminder');
  }
  if (likelyReminder('你怎么看这个观点？')) {
    throw new Error('plain point-of-view question was misclassified as reminder');
  }
  if (likelyReminder('这个点子不错')) {
    throw new Error('plain idea statement was misclassified as reminder');
  }
  if (likelyReminder('明天下午天气怎么样？')) {
    throw new Error('daytime question was misclassified as reminder');
  }
  if (!likelyReminder('明天上午九点提醒我喝水')) {
    throw new Error('reminder intent smoke failed');
  }
  if (!likelyReminder('明天九点叫我喝水')) {
    throw new Error('implicit reminder intent smoke failed');
  }
  if (!likelyReminder('10分钟后通知我开会')) {
    throw new Error('relative reminder intent smoke failed');
  }
  if (!likelyListReminders('我有哪些提醒？')) {
    throw new Error('list reminders intent smoke failed');
  }
  if (!likelyListMemory('你记得什么？')) {
    throw new Error('list memory intent smoke failed');
  }
  if (!likelyForgetMemory('忘记用户喜欢安静的语音风格')) {
    throw new Error('forget memory intent smoke failed');
  }
  if (!likelyForgetMemory('删除记忆用户喜欢安静的语音风格')) {
    throw new Error('delete memory intent smoke failed');
  }
  if (likelyCancelReminder('删除记忆用户喜欢安静的语音风格')) {
    throw new Error('delete memory was misclassified as cancel reminder');
  }
  if (!likelyCancelReminder('删除喝水提醒')) {
    throw new Error('delete reminder intent smoke failed');
  }
}

function testStaleAnnouncementSkip() {
  const dir = createTempDir('heros-stale-announcement-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  const loop = new VoiceLoop({
    config: {},
    realtime: {},
    taskRouter: null,
    context: new SharedContext(),
    reminderScheduler: null,
    playAudio: false,
  });
  loop.turnEpoch = 2;
  loop.enqueueAnnouncement('old result', {
    backgroundTaskId: 'task_old',
    turnEpoch: 1,
    turnId: 'turn_old',
  });
  const events = readEventLog(logPath);
  const skipped = events.find((event) => event.type === 'announcement.skipped');
  if (
    !skipped
    || skipped.reason !== 'stale_turn'
    || skipped.backgroundTaskId !== 'task_old'
    || skipped.turnId !== 'turn_old'
  ) {
    throw new Error('stale announcement skip smoke failed');
  }
  configureEvents();
}

function testVoiceLoopRealtimeInstructions() {
  const context = new SharedContext();
  context.setLongTermMemory([{
    id: 'memory_1',
    content: '用户喜欢安静的语音风格',
    updatedAt: new Date().toISOString(),
  }]);
  const loop = new VoiceLoop({
    agentBootstrap: { 'SOUL.md': '# SOUL.md\n\nWarm voice.' },
    config: {
      realtimeInstructions: 'Base realtime instructions.',
    },
    realtime: {},
    taskRouter: null,
    context,
    reminderScheduler: null,
    playAudio: false,
  });
  const instructions = loop.buildRealtimeInstructions();
  if (!instructions.includes('Warm voice.') || !instructions.includes('用户喜欢安静的语音风格')) {
    throw new Error('voice loop realtime instructions smoke failed');
  }
}

function testVoiceLoopAssistantTurnId() {
  const loop = new VoiceLoop({
    config: {},
    realtime: {},
    taskRouter: null,
    context: new SharedContext(),
    reminderScheduler: null,
    playAudio: false,
  });
  loop.handleAssistantDone('好的');
  if (!loop.currentAssistantTurnId?.startsWith('turn_')) {
    throw new Error('voice loop assistant turn id smoke failed');
  }
}

function testVoiceLoopAnnouncementResponseCorrelation() {
  const dir = createTempDir('heros-voice-response-correlation-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  const realtime = new EventEmitter();
  const loop = new VoiceLoop({
    config: {},
    realtime,
    taskRouter: null,
    context: new SharedContext(),
    reminderScheduler: null,
    playAudio: false,
  });
  loop.attachRealtimeEvents();
  loop.activeAnnouncement = {
    backgroundTaskId: 'task_announcement',
    source: 'background_task',
    turnId: 'turn_user_source',
  };
  loop.currentAssistantTurnId = 'turn_announcement';
  realtime.emit('event', { type: 'response.done' });
  const completed = readEventLog(logPath).find((event) => event.type === 'response.completed');
  if (
    completed?.backgroundTaskId !== 'task_announcement'
    || completed.source !== 'background_task'
    || completed.sourceTurnId !== 'turn_user_source'
  ) {
    throw new Error('voice loop announcement response correlation smoke failed');
  }
  configureEvents();
}

async function testRealtimeConnectRetry() {
  let attempts = 0;
  const realtime = {
    async connect() {
      attempts += 1;
      if (attempts < 2) {
        throw new Error('temporary connect failure');
      }
    },
  };
  await connectRealtimeWithRetry(realtime, { retries: 1, delayMs: 0 });
  if (attempts !== 2) {
    throw new Error('realtime connect retry smoke failed');
  }
}

async function testRealtimeWaitForClose() {
  const realtime = new DashScopeRealtimeClient({
    apiKey: 'test',
    url: 'wss://example.com/realtime',
    model: 'fake',
  });
  const waiting = realtime.waitFor('session.updated', 1000);
  realtime.emit('close');
  let rejected = false;
  try {
    await waiting;
  } catch (error) {
    rejected = error.message.includes('closed');
  }
  if (!rejected) {
    throw new Error('realtime waitFor close smoke failed');
  }
}

async function testVoiceLoopBackgroundState() {
  const loop = new VoiceLoop({
    config: {},
    realtime: {},
    taskRouter: {
      async maybeHandle() {
        return { type: 'none', message: '' };
      },
    },
    context: new SharedContext(),
    reminderScheduler: null,
    playAudio: false,
  });
  loop.setState('listening', 'smoke_start');
  loop.delegateTask('明天九点提醒我喝水', { turnEpoch: 0 });
  if (loop.state !== 'background_running') {
    throw new Error('voice loop did not enter background_running');
  }
  await Promise.allSettled([...loop.backgroundTasks]);
  if (loop.state !== 'listening') {
    throw new Error('voice loop did not leave background_running');
  }
}

async function testVoiceLoopBackgroundCancellation() {
  let aborted = false;
  const loop = new VoiceLoop({
    config: {},
    realtime: {},
    taskRouter: {
      async maybeHandle(_text, { signal }) {
        signal.addEventListener('abort', () => {
          aborted = true;
        }, { once: true });
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { type: 'none', message: '' };
      },
    },
    context: new SharedContext(),
    reminderScheduler: null,
    playAudio: false,
  });
  loop.delegateTask('明天九点提醒我喝水', { turnEpoch: 0, turnId: 'turn_voice_cancel' });
  if (loop.backgroundTaskControllers.size !== 1) {
    throw new Error('voice loop did not track background task controller');
  }
  await loop.handleSpeechStarted();
  await Promise.allSettled([...loop.backgroundTasks]);
  if (!aborted || loop.backgroundTaskControllers.size !== 0) {
    throw new Error('voice loop background cancellation smoke failed');
  }
}

async function testVoiceLoopShutdownCancelsBackgroundTasks() {
  let aborted = false;
  const loop = new VoiceLoop({
    config: {},
    realtime: {
      close() {},
    },
    taskRouter: {
      async maybeHandle(_text, { signal }) {
        signal.addEventListener('abort', () => {
          aborted = true;
        }, { once: true });
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        return { type: 'background_cancelled', message: '' };
      },
    },
    context: new SharedContext(),
    reminderScheduler: null,
    playAudio: false,
  });
  loop.delegateTask('明天九点提醒我喝水', { turnEpoch: 0, turnId: 'turn_shutdown' });
  await loop.waitForShutdown({ durationMs: 1 });
  if (!aborted || loop.state !== 'stopped') {
    throw new Error('voice loop shutdown cancellation smoke failed');
  }
}

function testTaskRouterCancelReminder() {
  const dir = createTempDir('heros-router-reminder-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  const reminderStore = new ReminderStore(dir);
  const reminder = reminderStore.create({
    title: '喝水',
    remindAt: new Date(Date.now() + 60000).toISOString(),
    note: '',
  });
  const context = new SharedContext();
  const router = new TaskRouter({
    context,
    reminderStore,
    memoryStore: null,
    backgroundAgent: null,
  });
  const result = router.handleCancelReminder('取消喝水提醒');
  if (result.type !== 'reminder_cancelled') {
    throw new Error('task router cancel reminder smoke failed');
  }
  if (!result.backgroundTaskId || !context.snapshot().backgroundTasks.at(-1).backgroundTaskId) {
    throw new Error('task router cancel reminder background task id smoke failed');
  }
  if (reminderStore.list().find((item) => item.id === reminder.id)?.status !== 'cancelled') {
    throw new Error('task router cancel reminder did not persist');
  }
  const clarify = router.handleCancelReminder('取消提醒');
  if (clarify.type !== 'cancel_reminder_needs_clarification') {
    throw new Error('empty cancel reminder query did not clarify');
  }
  const clarificationEvent = readEventLog(logPath).find((event) => event.type === 'background_task.needs_clarification');
  if (clarificationEvent?.reason !== 'missing_cancel_reminder_query') {
    throw new Error('cancel reminder clarification event smoke failed');
  }
  configureEvents();
}

function testTaskRouterListReminders() {
  const dir = createTempDir('heros-router-list-reminders-');
  const reminderStore = new ReminderStore(dir);
  reminderStore.create({
    title: '喝水',
    remindAt: new Date(Date.now() + 60000).toISOString(),
    note: '',
  });
  const context = new SharedContext();
  const router = new TaskRouter({
    context,
    reminderStore,
    memoryStore: null,
    backgroundAgent: null,
    timeZone: 'Asia/Shanghai',
  });
  const result = router.handleListReminders();
  if (result.type !== 'reminders_listed' || result.reminders.length !== 1 || !result.message.includes('喝水')) {
    throw new Error('task router list reminders smoke failed');
  }
  if (context.snapshot().backgroundTasks.at(-1).type !== 'list_reminders') {
    throw new Error('task router list reminders context smoke failed');
  }
}

function testTaskRouterListMemory() {
  const dir = createTempDir('heros-router-list-memory-');
  const memoryStore = new MemoryStore(path.join(dir, 'MEMORY.md'));
  memoryStore.create('用户喜欢安静的语音风格');
  const context = new SharedContext();
  const router = new TaskRouter({
    context,
    memoryStore,
    reminderStore: null,
    backgroundAgent: null,
  });
  const result = router.handleListMemory();
  if (result.type !== 'memory_listed' || result.memories.length !== 1 || !result.message.includes('安静')) {
    throw new Error('task router list memory smoke failed');
  }
  if (context.snapshot().longTermMemory.length !== 1) {
    throw new Error('task router list memory context smoke failed');
  }
}

await testEventLog();
testReminderScheduler();
testMemoryStore();
testBackgroundTaskSummary();
testRuntimeStateSummary();
testAgentBootstrap();
testCliStatusOutput();
testCliRuntimeStateCommand();
testCliReminderCommands();
testCliMemoryCommands();
testConfigNumberFallback();
testSharedContextRedaction();
await testCliBackgroundResponseCorrelation();
testIntentBoundaries();
testStaleAnnouncementSkip();
testVoiceLoopRealtimeInstructions();
testVoiceLoopAssistantTurnId();
testVoiceLoopAnnouncementResponseCorrelation();
await testRealtimeConnectRetry();
await testRealtimeWaitForClose();
await testVoiceLoopBackgroundState();
await testVoiceLoopBackgroundCancellation();
await testVoiceLoopShutdownCancelsBackgroundTasks();
testTaskRouterMemory();
await testTaskRouterTurnLink();
await testTaskRouterBackgroundFailure();
await testTaskRouterBackgroundClarification();
await testTaskRouterBackgroundTimeout();
await testTaskRouterBackgroundCancellation();
testTaskRouterForgetMemory();
testTaskRouterCancelReminder();
testTaskRouterListReminders();
testTaskRouterListMemory();
await testBackgroundAgentInvalidReminder();
await testBackgroundAgentPastReminder();
await testBackgroundAgentLifecycleEvents();
await testBackgroundAgentAbortBeforeToolCall();
await testDashScopeExternalAbortReason();
console.log('smoke ok');
