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
import { LOCAL_TASK_ROUTER_HANDLED_LOCALLY, TaskRouter } from '../src/taskRouter.js';
import { likelyCancelReminder, likelyForgetMemory, likelyListMemory, likelyListReminders, likelyNextReminder, likelyReminder, likelyUpdateMemory, likelyUpdateReminder } from '../src/intents.js';
import {
  filterEvents,
  followEventLog,
  readEventLog,
  summarizeBackgroundTasks,
  summarizeBackgroundTaskDetail,
  summarizeErrors,
  summarizeEvents,
  summarizeRuntimeState,
  summarizeSharedContext,
  summarizeTimeline,
  summarizeTurns,
} from '../src/eventLog.js';
import { VoiceLoop } from '../src/voiceLoop.js';
import { ensureAgentBootstrap, readAgentBootstrap } from '../src/bootstrap.js';
import { connectRealtimeWithRetry } from '../src/realtimeRetry.js';
import { DashScopeRealtimeClient } from '../src/realtimeClient.js';
import { getConfig } from '../src/config.js';
import { CliInteractionModel } from '../src/interactionModel.js';
import { DashScopeClient } from '../src/dashscope.js';
import { commandExists } from '../src/audio.js';
import { createRuntime } from '../src/runtime.js';

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
  const since = new Date(Date.now() + 10).toISOString();
  await new Promise((resolve) => setTimeout(resolve, 15));
  emitEvent('smoke.since', { turnId: 'turn_since' });
  const sinceFiltered = filterEvents(readEventLog(logPath), { since });
  if (sinceFiltered.length !== 1 || sinceFiltered[0].turnId !== 'turn_since') {
    throw new Error('event since filter smoke failed');
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

async function testCommandExistsMissingWhich() {
  const previousPath = process.env.PATH;
  process.env.PATH = '';
  try {
    if (await commandExists('rec')) {
      throw new Error('commandExists should be false without PATH');
    }
  } finally {
    process.env.PATH = previousPath;
  }
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
  if (!item.createdAt || !item.updatedAt) {
    throw new Error('reminder timestamp smoke failed');
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
  const originalFutureTime = future.remindAt;
  refused = false;
  try {
    store.update(future.id, { remindAt: 'not-a-date' });
  } catch {
    refused = true;
  }
  if (!refused || store.list().find((item) => item.id === future.id)?.remindAt !== originalFutureTime) {
    throw new Error('invalid reminder update time was not refused');
  }
  refused = false;
  try {
    store.update(future.id, { title: '' });
  } catch {
    refused = true;
  }
  if (!refused || store.list().find((item) => item.id === future.id)?.title !== 'future') {
    throw new Error('empty reminder update title was not refused');
  }
  const cancelled = store.cancel(future.id);
  if (cancelled.status !== 'cancelled') {
    throw new Error('reminder cancellation smoke failed');
  }

  const oneShot = store.create({
    title: 'one-shot',
    remindAt: new Date(Date.now() - 1000).toISOString(),
    note: '',
  });
  const triggered = scheduler.check({ print: false });
  if (triggered.length !== 1 || triggered[0].id !== oneShot.id || store.list().find((item) => item.id === oneShot.id)?.status !== 'triggered') {
    throw new Error('reminder scheduler one-shot check smoke failed');
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
  emitEvent('transcript.completed', {
    text: '明天九点提醒我喝水',
    turnId: 'turn_summary_user',
  });
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
  emitEvent('background_task.started', {
    backgroundTaskId: 'task_clarify_summary',
    turnId: 'turn_summary_user',
    taskType: 'reminder',
    model: 'fake',
  });
  emitEvent('background_task.needs_clarification', {
    backgroundTaskId: 'task_clarify_summary',
    turnId: 'turn_summary_user',
    question: '什么时候提醒？',
    reason: 'missing_time',
  });
  emitEvent('background_task.completed', {
    backgroundTaskId: 'task_clarify_summary',
    turnId: 'turn_summary_user',
    result: { action: 'reminder_needs_clarification' },
  });
  emitEvent('response.completed', {
    backgroundTaskId: 'task_summary',
    turnId: 'turn_summary_assistant',
    sourceTurnId: 'turn_summary_user',
    source: 'background_agent',
    text: '好的，已经创建提醒。',
  });
  const summary = summarizeBackgroundTasks(readEventLog(logPath));
  const task = summary.tasks.find((item) => item.backgroundTaskId === 'task_summary');
  const clarifyTask = summary.tasks.find((item) => item.backgroundTaskId === 'task_clarify_summary');
  if (
    summary.total !== 2
    || task.status !== 'completed'
    || task.taskType !== 'reminder'
    || task.progress.action !== 'create_reminder'
    || task.responseTurnId !== 'turn_summary_assistant'
    || clarifyTask.status !== 'needs_clarification'
    || clarifyTask.result.question !== '什么时候提醒？'
  ) {
    throw new Error('background task summary smoke failed');
  }
  const detail = summarizeBackgroundTaskDetail(readEventLog(logPath), 'task_summary');
  if (
    !detail.found
    || detail.task.backgroundTaskId !== 'task_summary'
    || detail.turns.length !== 2
    || !detail.timeline.some((entry) => entry.kind === 'background_task' && entry.taskType === 'reminder')
    || !detail.events.some((event) => event.type === 'background_task.progress')
  ) {
    throw new Error('background task detail smoke failed');
  }
  const missing = summarizeBackgroundTaskDetail(readEventLog(logPath), 'task_missing');
  if (missing.found || missing.events.length !== 0 || missing.timeline.length !== 0) {
    throw new Error('missing background task detail smoke failed');
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
  emitEvent('background_task.started', {
    backgroundTaskId: 'task_runtime_state_ambiguous',
    turnId: 'turn_runtime_state',
    taskType: 'cancel_reminder',
    model: 'fake',
  });
  emitEvent('background_task.completed', {
    backgroundTaskId: 'task_runtime_state_ambiguous',
    turnId: 'turn_runtime_state',
    result: { action: 'cancel_reminder_ambiguous' },
  });
  const summary = summarizeRuntimeState(readEventLog(logPath));
  if (
    summary.state !== 'idle'
    || summary.pendingClarificationCount !== 2
    || summary.lastTurnId !== 'turn_runtime_state'
    || !['ambiguous', 'needs_clarification'].includes(summary.lastBackgroundTask.status)
  ) {
    throw new Error('runtime state summary smoke failed');
  }
  configureEvents();
}

function testTimelineSummary() {
  const dir = createTempDir('heros-timeline-summary-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  emitEvent('state.changed', {
    previousState: 'idle',
    state: 'listening',
    reason: 'smoke_start',
  });
  emitEvent('transcript.completed', {
    text: '提醒我喝水',
    turnId: 'turn_timeline',
    contextVersion: 1,
  });
  emitEvent('background_task.started', {
    backgroundTaskId: 'task_timeline',
    turnId: 'turn_timeline',
    taskType: 'reminder',
    model: 'fake',
  });
  emitEvent('background_task.completed', {
    backgroundTaskId: 'task_timeline',
    turnId: 'turn_timeline',
    result: { action: 'create_reminder' },
  });
  emitEvent('announcement.queued', {
    backgroundTaskId: 'task_timeline',
    turnId: 'turn_timeline',
    source: 'background_task',
    text: '好的，已经创建提醒。',
  });
  const summary = summarizeTimeline(readEventLog(logPath));
  if (
    summary.total !== 5
    || summary.entries[0].kind !== 'state'
    || summary.entries[1].kind !== 'user_turn'
    || summary.entries[2].kind !== 'background_task'
    || summary.entries[3].taskType !== 'reminder'
    || summary.entries[4].kind !== 'announcement'
    || summary.entries[4].backgroundTaskId !== 'task_timeline'
    || summary.entries[4].taskType !== 'reminder'
  ) {
    throw new Error('timeline summary smoke failed');
  }
  configureEvents();
}

function testTurnSummary() {
  const dir = createTempDir('heros-turn-summary-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  emitEvent('transcript.completed', {
    text: '明天九点提醒我喝水',
    turnId: 'turn_user_summary',
    contextVersion: 1,
  });
  emitEvent('response.completed', {
    source: 'background_agent',
    sourceTurnId: 'turn_user_summary',
    backgroundTaskId: 'task_turn_summary',
    text: '好的，明天九点提醒你喝水。',
    turnId: 'turn_assistant_summary',
  });
  const summary = summarizeTurns(readEventLog(logPath));
  if (
    summary.total !== 2
    || summary.turns[0].role !== 'user'
    || summary.turns[1].role !== 'assistant'
    || summary.turns[1].backgroundTaskId !== 'task_turn_summary'
    || !summary.turns[1].text.includes('明天九点')
  ) {
    throw new Error('turn summary smoke failed');
  }
  configureEvents();
}

async function testCliInteractionTurns() {
  const dir = createTempDir('heros-cli-interaction-turns-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  const interaction = new CliInteractionModel({
    context: new SharedContext(),
    model: 'fake',
    taskRouter: {
      async maybeHandle() {
        return null;
      },
    },
    client: {
      async text() {
        return '你好，我在。';
      },
    },
  });
  await interaction.respond('你好');
  const summary = summarizeTurns(readEventLog(logPath));
  if (
    summary.total !== 2
    || summary.turns[0].role !== 'user'
    || summary.turns[0].text !== '你好'
    || summary.turns[1].role !== 'assistant'
    || summary.turns[1].sourceTurnId !== summary.turns[0].turnId
  ) {
    throw new Error('cli interaction turns smoke failed');
  }
  configureEvents();
}

function testErrorSummary() {
  const dir = createTempDir('heros-error-summary-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  emitEvent('tool_call.failed', {
    backgroundTaskId: 'task_error_summary',
    turnId: 'turn_error_summary',
    toolName: 'create_reminder',
    message: 'bad time',
  });
  emitEvent('announcement.failed', {
    source: 'background_task',
    message: 'realtime closed',
  });
  fs.appendFileSync(logPath, 'not-json\n');
  const summary = summarizeErrors(readEventLog(logPath));
  if (
    summary.total !== 3
    || summary.errors[0].toolName !== 'create_reminder'
    || summary.errors[1].message !== 'realtime closed'
    || summary.errors[2].type !== 'event_log.malformed'
  ) {
    throw new Error('error summary smoke failed');
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
  const logPath = path.join(dir, 'events.ndjson');
  const reminderStore = new ReminderStore(dir);
  const reminder = reminderStore.create({
    title: '喝水',
    remindAt: new Date(Date.now() + 60000).toISOString(),
    note: '',
  });
  const reviewDir = path.join(dir, 'reviews');
  fs.mkdirSync(reviewDir, { recursive: true });
  const reviewPath = path.join(reviewDir, 'phase-1-review-smoke.json');
  fs.writeFileSync(reviewPath, `${JSON.stringify({
    phase: 'phase_1_no_ui_cli',
    ready: true,
    createdAt: '2026-06-21T00:00:00.000Z',
  }, null, 2)}\n`);
  const sessionReportDir = path.join(dir, 'session-reports');
  fs.mkdirSync(sessionReportDir, { recursive: true });
  const sessionReportPath = path.join(sessionReportDir, 'session-report-smoke.json');
  fs.writeFileSync(sessionReportPath, `${JSON.stringify({
    phase: 'phase_1_no_ui_cli',
    createdAt: '2026-06-21T00:00:00.500Z',
    filters: { backgroundTaskId: 'task_status_clarify' },
    eventSummary: { total: 3 },
    turns: { total: 0 },
    backgroundTasks: { total: 1 },
    errors: { total: 0 },
  }, null, 2)}\n`);
  fs.writeFileSync(logPath, `${JSON.stringify({
    type: 'review.completed',
    phase: 'phase_1_no_ui_cli',
    ready: true,
    reportPath: reviewPath,
    createdAt: '2026-06-21T00:00:01.000Z',
  })}\n${JSON.stringify({
    type: 'session_report.created',
    reportPath: sessionReportPath,
    eventCount: 3,
    turnCount: 0,
    filters: { backgroundTaskId: 'task_status_clarify' },
    createdAt: '2026-06-21T00:00:01.500Z',
  })}\n${JSON.stringify({
    type: 'background_task.started',
    backgroundTaskId: 'task_status_clarify',
    turnId: 'turn_status_clarify',
    taskType: 'cancel_reminder',
    model: 'local_task_router',
    createdAt: '2026-06-21T00:00:02.000Z',
  })}\n${JSON.stringify({
    type: 'background_task.needs_clarification',
    backgroundTaskId: 'task_status_clarify',
    turnId: 'turn_status_clarify',
    question: '你想取消哪一个提醒？',
    reason: 'missing_cancel_reminder_query',
    createdAt: '2026-06-21T00:00:03.000Z',
  })}\n${JSON.stringify({
    type: 'background_task.completed',
    backgroundTaskId: 'task_status_clarify',
    turnId: 'turn_status_clarify',
    result: { action: 'cancel_reminder_needs_clarification' },
    createdAt: '2026-06-21T00:00:04.000Z',
  })}\n`);
  const result = spawnSync(process.execPath, ['src/cli.js', '--status'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: dir,
      HEROS_EVENT_LOG_PATH: logPath,
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
  if (status.backgroundTasks.total !== 1 || status.backgroundTasks.byStatus.needs_clarification !== 1) {
    throw new Error('cli status background task summary smoke failed');
  }
  if (
    !status.localTaskRouter.handledLocally.includes('cancel_reminder')
    || !status.localTaskRouter.handledLocally.includes('update_memory')
    || !status.localTaskRouter.handledLocally.includes('forget_memory')
  ) {
    throw new Error('cli status local task router summary smoke failed');
  }
  if (
    status.reminders.dueScheduled !== 0
    || status.reminders.nextScheduledAt !== reminder.remindAt
    || status.reminders.nextScheduled?.title !== '喝水'
  ) {
    throw new Error('cli status reminder due summary smoke failed');
  }
  if (status.review.latestReport?.path !== reviewPath || status.review.latestReport.ready !== true) {
    throw new Error('cli status review report smoke failed');
  }
  if (status.review.latestEvent?.reportPath !== reviewPath || status.review.latestEvent.ready !== true) {
    throw new Error('cli status review event smoke failed');
  }
  if (
    status.sessionReport.latestReport?.path !== sessionReportPath
    || status.sessionReport.latestReport.eventCount !== 3
    || status.sessionReport.latestReport.backgroundTaskCount !== 1
    || status.sessionReport.latestReport.filters.backgroundTaskId !== 'task_status_clarify'
  ) {
    throw new Error('cli status session report smoke failed');
  }
  if (
    status.sessionReport.latestEvent?.reportPath !== sessionReportPath
    || status.sessionReport.latestEvent.eventCount !== 3
    || status.sessionReport.latestEvent.filters.backgroundTaskId !== 'task_status_clarify'
  ) {
    throw new Error('cli status session report event smoke failed');
  }
  if (
    status.runtimeState.state !== 'idle'
    || status.runtimeState.pendingClarificationCount !== 1
    || status.runtimeState.pendingClarifications[0]?.question !== '你想取消哪一个提醒？'
    || status.runtimeState.lastEventType !== 'background_task.completed'
    || status.runtimeState.lastTurnId !== 'turn_status_clarify'
    || status.runtimeState.lastBackgroundTask?.backgroundTaskId !== 'task_status_clarify'
    || status.runtimeState.lastBackgroundTask?.taskType !== 'cancel_reminder'
  ) {
    throw new Error('cli status runtime state smoke failed');
  }
  if (status.turns.total !== 0 || status.errors.total !== 0) {
    throw new Error('cli status turn/error summary smoke failed');
  }
  if (typeof status.audio.recorderAvailable !== 'boolean' || typeof status.audio.playerAvailable !== 'boolean') {
    throw new Error('cli status audio summary smoke failed');
  }
}

function testCliHelpOutput() {
  const result = spawnSync(process.execPath, ['src/cli.js', '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: createTempDir('heros-cli-help-'),
    },
  });
  if (result.status !== 0) {
    throw new Error(`cli help smoke failed: ${result.stderr || result.stdout}`);
  }
  if (
    !result.stdout.includes('routing boundary')
    || !result.stdout.includes('qwen3.5-omni-plus-realtime')
    || !result.stdout.includes('qwen3.7-plus')
  ) {
    throw new Error('cli help output smoke failed');
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

function testCliTimelineCommand() {
  const dir = createTempDir('heros-cli-timeline-');
  const logPath = path.join(dir, 'events.ndjson');
  fs.writeFileSync(logPath, `${JSON.stringify({
    type: 'transcript.completed',
    text: '提醒我喝水',
    turnId: 'turn_cli_timeline',
    contextVersion: 1,
    createdAt: '2026-06-21T00:00:00.000Z',
  })}\n${JSON.stringify({
    type: 'background_task.started',
    backgroundTaskId: 'task_cli_timeline',
    turnId: 'turn_cli_timeline',
    taskType: 'reminder',
    model: 'fake',
    createdAt: '2026-06-21T00:00:01.000Z',
  })}\n${JSON.stringify({
    type: 'response.completed',
    source: 'realtime_text',
    text: '你好',
    turnId: 'turn_cli_timeline_other',
    createdAt: '2026-06-21T00:00:02.000Z',
  })}\n`);
  const result = spawnSync(process.execPath, ['src/cli.js', '--timeline'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: dir,
      HEROS_EVENT_LOG_PATH: logPath,
    },
  });
  if (result.status !== 0) {
    throw new Error(`cli timeline smoke failed: ${result.stderr || result.stdout}`);
  }
  const timeline = JSON.parse(result.stdout);
  if (
    timeline.total !== 3
    || timeline.entries[0].kind !== 'user_turn'
    || timeline.entries[1].backgroundTaskId !== 'task_cli_timeline'
  ) {
    throw new Error('cli timeline output smoke failed');
  }
  const filteredResult = spawnSync(process.execPath, ['src/cli.js', '--timeline', '--background-task-id', 'task_cli_timeline'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: dir,
      HEROS_EVENT_LOG_PATH: logPath,
    },
  });
  if (filteredResult.status !== 0) {
    throw new Error(`cli timeline filter smoke failed: ${filteredResult.stderr || filteredResult.stdout}`);
  }
  const filtered = JSON.parse(filteredResult.stdout);
  if (filtered.total !== 1 || filtered.entries[0].backgroundTaskId !== 'task_cli_timeline') {
    throw new Error('cli timeline filter output smoke failed');
  }
}

function testSharedContextSummary() {
  const events = [
    {
      type: 'transcript.completed',
      text: '记住我喜欢短回答',
      turnId: 'turn_context_summary',
      contextVersion: 3,
      createdAt: '2026-06-21T00:00:00.000Z',
    },
  ];
  const summary = summarizeSharedContext(events, {
    bootstrapFiles: ['/tmp/AGENTS.md'],
    localTaskRouter: { handledLocally: LOCAL_TASK_ROUTER_HANDLED_LOCALLY },
    memories: [{ id: 'memory_1', content: '用户喜欢短回答', updatedAt: '2026-06-21T00:00:00.000Z' }],
    reminders: [],
  });
  if (
    summary.contextVersion !== 3
    || summary.turns.total !== 1
    || !summary.localTaskRouter.handledLocally.includes('cancel_reminder')
    || summary.longTermMemory.total !== 1
    || summary.bootstrap.files[0] !== 'AGENTS.md'
  ) {
    throw new Error('shared context summary smoke failed');
  }
}

function testSharedContextHydration() {
  const context = new SharedContext();
  context.hydrate({
    turns: [{
      turnId: 'turn_hydrated',
      role: 'user',
      text: '你好 Bearer should-not-leak',
      createdAt: '2026-06-21T00:00:00.000Z',
      contextVersion: 7,
    }],
    backgroundTasks: [{
      backgroundTaskId: 'task_hydrated',
      taskType: 'reminder',
      turnId: 'turn_hydrated',
      status: 'completed',
      result: { token: 'should-not-leak' },
      updatedAt: '2026-06-21T00:00:01.000Z',
    }],
  });
  const snapshot = context.snapshot();
  if (
    snapshot.contextVersion !== 7
    || snapshot.turns[0].id !== 'turn_hydrated'
    || snapshot.turns[0].content.includes('should-not-leak')
    || snapshot.backgroundTasks[0].type !== 'reminder'
    || snapshot.backgroundTasks[0].result.token !== '[REDACTED]'
  ) {
    throw new Error('shared context hydration smoke failed');
  }
  const turn = context.addTurn('assistant', '你好');
  if (turn.contextVersion !== 8) {
    throw new Error('shared context hydration version smoke failed');
  }
}

function testRuntimeHydratesEventLog() {
  const dir = createTempDir('heros-runtime-hydration-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  emitEvent('transcript.completed', {
    text: '记住我喜欢短回答',
    turnId: 'turn_runtime_hydrated',
    contextVersion: 4,
  });
  emitEvent('background_task.requested', {
    backgroundTaskId: 'task_runtime_hydrated',
    turnId: 'turn_runtime_hydrated',
    taskType: 'memory',
    reason: 'explicit_memory_request',
  });
  emitEvent('background_task.completed', {
    backgroundTaskId: 'task_runtime_hydrated',
    turnId: 'turn_runtime_hydrated',
    result: { action: 'memory_created' },
  });
  configureEvents();

  const previousDataDir = process.env.HEROS_DATA_DIR;
  const previousEventLogPath = process.env.HEROS_EVENT_LOG_PATH;
  process.env.HEROS_DATA_DIR = dir;
  process.env.HEROS_EVENT_LOG_PATH = logPath;
  try {
    const runtime = createRuntime({ requireApiKey: false, printEvents: false });
    const snapshot = runtime.context.snapshot();
    if (
      snapshot.turns[0]?.id !== 'turn_runtime_hydrated'
      || snapshot.backgroundTasks[0]?.backgroundTaskId !== 'task_runtime_hydrated'
      || snapshot.backgroundTasks[0]?.type !== 'memory'
    ) {
      throw new Error('runtime event log hydration smoke failed');
    }
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.HEROS_DATA_DIR;
    } else {
      process.env.HEROS_DATA_DIR = previousDataDir;
    }
    if (previousEventLogPath === undefined) {
      delete process.env.HEROS_EVENT_LOG_PATH;
    } else {
      process.env.HEROS_EVENT_LOG_PATH = previousEventLogPath;
    }
  }
}

function testRuntimeHydratesPendingClarification() {
  const dir = createTempDir('heros-runtime-pending-hydration-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  emitEvent('transcript.completed', {
    text: '取消提醒',
    turnId: 'turn_runtime_pending_cancel',
    contextVersion: 1,
  });
  emitEvent('background_task.requested', {
    backgroundTaskId: 'task_runtime_pending_cancel',
    turnId: 'turn_runtime_pending_cancel',
    taskType: 'cancel_reminder',
    reason: 'explicit_cancel_reminder_request',
  });
  emitEvent('background_task.needs_clarification', {
    backgroundTaskId: 'task_runtime_pending_cancel',
    turnId: 'turn_runtime_pending_cancel',
    question: '你想取消哪一个提醒？',
    reason: 'missing_cancel_reminder_query',
  });
  emitEvent('background_task.completed', {
    backgroundTaskId: 'task_runtime_pending_cancel',
    turnId: 'turn_runtime_pending_cancel',
    result: { action: 'cancel_reminder_needs_clarification' },
  });
  emitEvent('background_task.started', {
    backgroundTaskId: 'task_runtime_list_memory',
    turnId: 'turn_runtime_list_memory',
    taskType: 'list_memory',
    model: 'local_task_router',
  });
  emitEvent('background_task.completed', {
    backgroundTaskId: 'task_runtime_list_memory',
    turnId: 'turn_runtime_list_memory',
    result: { action: 'list_memory', count: 0 },
  });
  configureEvents();

  const previousDataDir = process.env.HEROS_DATA_DIR;
  const previousEventLogPath = process.env.HEROS_EVENT_LOG_PATH;
  process.env.HEROS_DATA_DIR = dir;
  process.env.HEROS_EVENT_LOG_PATH = logPath;
  try {
    const runtime = createRuntime({ requireApiKey: false, printEvents: false });
    const decision = runtime.taskRouter.shouldDelegate('喝水');
    const contextPackage = runtime.taskRouter.buildContextPackage();
    if (
      decision?.type !== 'cancel_reminder'
      || decision.reason !== 'pending_clarification_response'
      || decision.pendingBackgroundTaskId !== 'task_runtime_pending_cancel'
      || contextPackage.pendingClarification?.backgroundTaskId !== 'task_runtime_pending_cancel'
    ) {
      throw new Error('runtime pending clarification hydration smoke failed');
    }
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.HEROS_DATA_DIR;
    } else {
      process.env.HEROS_DATA_DIR = previousDataDir;
    }
    if (previousEventLogPath === undefined) {
      delete process.env.HEROS_EVENT_LOG_PATH;
    } else {
      process.env.HEROS_EVENT_LOG_PATH = previousEventLogPath;
    }
  }
}

function testCliContextCommand() {
  const dir = createTempDir('heros-cli-context-');
  const logPath = path.join(dir, 'events.ndjson');
  const bootstrap = ensureAgentBootstrap(dir);
  const reminderStore = new ReminderStore(dir);
  const memoryStore = new MemoryStore(bootstrap.files.find((filePath) => filePath.endsWith('MEMORY.md')));
  const reminder = reminderStore.create({
    title: '喝水',
    remindAt: new Date(Date.now() + 60000).toISOString(),
    note: '',
  });
  const memory = memoryStore.create('用户喜欢短回答');
  configureEvents({ logPath });
  emitEvent('transcript.completed', {
    text: '明天九点提醒我喝水',
    turnId: 'turn_context_user',
    contextVersion: 7,
  });
  emitEvent('background_task.started', {
    backgroundTaskId: 'task_context',
    turnId: 'turn_context_user',
    taskType: 'reminder',
    model: 'fake',
  });
  configureEvents();

  const result = spawnSync(process.execPath, ['src/cli.js', '--context'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: dir,
      HEROS_EVENT_LOG_PATH: logPath,
    },
  });
  if (result.status !== 0) {
    throw new Error(`cli context smoke failed: ${result.stderr || result.stdout}`);
  }
  const context = JSON.parse(result.stdout);
  if (
    context.contextVersion !== 7
    || context.turns.total !== 1
    || context.backgroundTasks.active[0].backgroundTaskId !== 'task_context'
    || context.reminders.nextScheduled.id !== reminder.id
    || context.longTermMemory.items[0].id !== memory.id
    || !context.bootstrap.files.includes('AGENTS.md')
  ) {
    throw new Error('cli context output smoke failed');
  }
}

function testCliTurnsCommand() {
  const dir = createTempDir('heros-cli-turns-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  emitEvent('transcript.completed', {
    text: '记住我喜欢短回答',
    turnId: 'turn_cli_user',
  });
  emitEvent('response.completed', {
    source: 'background_agent',
    text: '我记住了。',
    turnId: 'turn_cli_assistant',
  });
  emitEvent('transcript.completed', {
    text: '这轮不应该出现在过滤结果里',
    turnId: 'turn_cli_other',
  });
  configureEvents();
  const result = spawnSync(process.execPath, ['src/cli.js', '--turns'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: dir,
      HEROS_EVENT_LOG_PATH: logPath,
    },
  });
  if (result.status !== 0) {
    throw new Error(`cli turns smoke failed: ${result.stderr || result.stdout}`);
  }
  const summary = JSON.parse(result.stdout);
  if (
    summary.total !== 3
    || !summary.turns.some((turn) => turn.turnId === 'turn_cli_user')
    || !summary.turns.some((turn) => turn.text === '我记住了。')
  ) {
    throw new Error('cli turns output smoke failed');
  }
  const filteredResult = spawnSync(process.execPath, ['src/cli.js', '--turns', '--turn-id', 'turn_cli_user'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: dir,
      HEROS_EVENT_LOG_PATH: logPath,
    },
  });
  if (filteredResult.status !== 0) {
    throw new Error(`cli filtered turns smoke failed: ${filteredResult.stderr || filteredResult.stdout}`);
  }
  const filteredSummary = JSON.parse(filteredResult.stdout);
  if (filteredSummary.total !== 1 || filteredSummary.turns[0].turnId !== 'turn_cli_user') {
    throw new Error('cli filtered turns output smoke failed');
  }
}

function testCliTranscriptCommand() {
  const dir = createTempDir('heros-cli-transcript-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  emitEvent('transcript.completed', {
    text: '你好',
    turnId: 'turn_transcript_user',
  });
  emitEvent('response.completed', {
    source: 'realtime_text',
    sourceTurnId: 'turn_transcript_user',
    text: '你好，我在。',
    turnId: 'turn_transcript_assistant',
  });
  emitEvent('response.completed', {
    source: 'realtime_text',
    text: '这轮不应该出现在过滤结果里',
    turnId: 'turn_transcript_other',
  });
  configureEvents();
  const result = spawnSync(process.execPath, ['src/cli.js', '--transcript', '--source-turn-id', 'turn_transcript_user'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: dir,
      HEROS_EVENT_LOG_PATH: logPath,
    },
  });
  if (result.status !== 0) {
    throw new Error(`cli transcript smoke failed: ${result.stderr || result.stdout}`);
  }
  if (
    !result.stdout.includes('User')
    || !result.stdout.includes('HerOS (realtime_text)')
    || !result.stdout.includes('你好，我在。')
    || result.stdout.includes('不应该出现')
  ) {
    throw new Error('cli transcript output smoke failed');
  }
}

function testCliErrorsCommand() {
  const dir = createTempDir('heros-cli-errors-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  emitEvent('tool_call.failed', {
    toolName: 'create_reminder',
    message: 'bad time',
  });
  configureEvents();
  const result = spawnSync(process.execPath, ['src/cli.js', '--errors'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: dir,
      HEROS_EVENT_LOG_PATH: logPath,
    },
  });
  if (result.status !== 0) {
    throw new Error(`cli errors smoke failed: ${result.stderr || result.stdout}`);
  }
  const summary = JSON.parse(result.stdout);
  if (summary.total !== 1 || summary.errors[0].message !== 'bad time') {
    throw new Error('cli errors output smoke failed');
  }
}

function testCliRouteCommand() {
  const dir = createTempDir('heros-cli-route-');
  const logPath = path.join(dir, 'events.ndjson');
  const env = {
    ...process.env,
    HEROS_DATA_DIR: dir,
    HEROS_EVENT_LOG_PATH: logPath,
  };
  const reminderResult = spawnSync(process.execPath, ['src/cli.js', '--route', '明天九点提醒我喝水'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (reminderResult.status !== 0) {
    throw new Error(`cli route reminder smoke failed: ${reminderResult.stderr || reminderResult.stdout}`);
  }
  const reminderRoute = JSON.parse(reminderResult.stdout);
  if (
    !reminderRoute.delegatesToBackground
    || reminderRoute.handledBy !== 'background_agent'
    || reminderRoute.taskType !== 'reminder'
    || reminderRoute.pendingBackgroundTaskId !== null
  ) {
    throw new Error('cli route reminder output smoke failed');
  }

  const updateResult = spawnSync(process.execPath, ['src/cli.js', '--route', '把喝水提醒改到明天十点'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (updateResult.status !== 0) {
    throw new Error(`cli route update reminder smoke failed: ${updateResult.stderr || updateResult.stdout}`);
  }
  const updateRoute = JSON.parse(updateResult.stdout);
  if (!updateRoute.delegatesToBackground || updateRoute.handledBy !== 'background_agent' || updateRoute.taskType !== 'update_reminder') {
    throw new Error('cli route update reminder output smoke failed');
  }

  const updateMemoryResult = spawnSync(process.execPath, ['src/cli.js', '--route', '把记忆里短回答改成用户喜欢详细回答'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (updateMemoryResult.status !== 0) {
    throw new Error(`cli route update memory smoke failed: ${updateMemoryResult.stderr || updateMemoryResult.stdout}`);
  }
  const updateMemoryRoute = JSON.parse(updateMemoryResult.stdout);
  if (!updateMemoryRoute.delegatesToBackground || updateMemoryRoute.handledBy !== 'local_task_router' || updateMemoryRoute.taskType !== 'update_memory') {
    throw new Error('cli route update memory output smoke failed');
  }

  const chatResult = spawnSync(process.execPath, ['src/cli.js', '--route', '你怎么看这个观点？'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (chatResult.status !== 0) {
    throw new Error(`cli route chat smoke failed: ${chatResult.stderr || chatResult.stdout}`);
  }
  const chatRoute = JSON.parse(chatResult.stdout);
  if (chatRoute.delegatesToBackground || chatRoute.handledBy !== 'realtime_interaction_model' || chatRoute.nextOnly !== false) {
    throw new Error('cli route chat output smoke failed');
  }

  configureEvents({ logPath });
  emitEvent('transcript.completed', {
    text: '提醒我喝水',
    turnId: 'turn_pending_route',
    contextVersion: 1,
  });
  emitEvent('background_task.requested', {
    backgroundTaskId: 'task_pending_route',
    turnId: 'turn_pending_route',
    taskType: 'reminder',
    reason: 'likely_reminder',
  });
  emitEvent('background_task.needs_clarification', {
    backgroundTaskId: 'task_pending_route',
    turnId: 'turn_pending_route',
    question: '什么时候提醒你喝水？',
    reason: 'missing_time',
  });
  configureEvents();

  const pendingResult = spawnSync(process.execPath, ['src/cli.js', '--route', '九点'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (pendingResult.status !== 0) {
    throw new Error(`cli route pending clarification smoke failed: ${pendingResult.stderr || pendingResult.stdout}`);
  }
  const pendingRoute = JSON.parse(pendingResult.stdout);
  if (
    !pendingRoute.delegatesToBackground
    || pendingRoute.handledBy !== 'background_agent'
    || pendingRoute.taskType !== 'reminder'
    || pendingRoute.reason !== 'pending_clarification_response'
    || pendingRoute.pendingBackgroundTaskId !== 'task_pending_route'
  ) {
    throw new Error('cli route pending clarification output smoke failed');
  }
}

function testCliTaskCommand() {
  const dir = createTempDir('heros-cli-task-');
  const logPath = path.join(dir, 'events.ndjson');
  const env = {
    ...process.env,
    HEROS_DATA_DIR: dir,
    HEROS_EVENT_LOG_PATH: logPath,
  };
  const memoryResult = spawnSync(process.execPath, ['src/cli.js', '--task', '记住用户喜欢安静的语音风格'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (memoryResult.status !== 0) {
    throw new Error(`cli task memory smoke failed: ${memoryResult.stderr || memoryResult.stdout}`);
  }
  const memoryTask = JSON.parse(memoryResult.stdout);
  if (
    !memoryTask.delegated
    || memoryTask.handledBy !== 'local_task_router'
    || memoryTask.taskType !== 'memory'
    || !memoryTask.responseTurnId
    || memoryTask.result.type !== 'memory_created'
  ) {
    throw new Error('cli task memory output smoke failed');
  }

  const updateMemoryResult = spawnSync(process.execPath, ['src/cli.js', '--task', '把记忆里安静的语音风格改成用户喜欢自然温暖的语音风格'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (updateMemoryResult.status !== 0) {
    throw new Error(`cli task update memory smoke failed: ${updateMemoryResult.stderr || updateMemoryResult.stdout}`);
  }
  const updateMemoryTask = JSON.parse(updateMemoryResult.stdout);
  if (
    !updateMemoryTask.delegated
    || updateMemoryTask.handledBy !== 'local_task_router'
    || updateMemoryTask.taskType !== 'update_memory'
    || updateMemoryTask.result?.type !== 'memory_updated'
  ) {
    throw new Error('cli task update memory output smoke failed');
  }
  const createdEvent = readEventLog(logPath).find((event) => event.type === 'memory.created');
  if (!createdEvent?.memory?.content.includes('安静')) {
    throw new Error('cli task memory event smoke failed');
  }
  const responseEvent = readEventLog(logPath).find((event) => event.type === 'response.completed');
  if (responseEvent?.sourceTurnId !== memoryTask.turnId || responseEvent.turnId !== memoryTask.responseTurnId) {
    throw new Error('cli task response event smoke failed');
  }

  const chatResult = spawnSync(process.execPath, ['src/cli.js', '--task', '你怎么看这个观点？'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (chatResult.status !== 0) {
    throw new Error(`cli task chat smoke failed: ${chatResult.stderr || chatResult.stdout}`);
  }
  const chatTask = JSON.parse(chatResult.stdout);
  if (chatTask.delegated || chatTask.handledBy !== 'realtime_interaction_model' || chatTask.result !== null) {
    throw new Error('cli task chat output smoke failed');
  }

  const reminderStore = new ReminderStore(dir);
  const reminder = reminderStore.create({
    title: '喝水',
    remindAt: new Date(Date.now() + 60000).toISOString(),
    note: '',
  });
  const pendingCancelResult = spawnSync(process.execPath, ['src/cli.js', '--task', '取消提醒'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (pendingCancelResult.status !== 0) {
    throw new Error(`cli task pending cancel smoke failed: ${pendingCancelResult.stderr || pendingCancelResult.stdout}`);
  }
  const pendingCancelTask = JSON.parse(pendingCancelResult.stdout);
  const resolvedCancelResult = spawnSync(process.execPath, ['src/cli.js', '--task', '喝水'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (resolvedCancelResult.status !== 0) {
    throw new Error(`cli task pending cancel answer smoke failed: ${resolvedCancelResult.stderr || resolvedCancelResult.stdout}`);
  }
  const resolvedCancelTask = JSON.parse(resolvedCancelResult.stdout);
  const routeAfterCancelResult = spawnSync(process.execPath, ['src/cli.js', '--route', '喝水'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (routeAfterCancelResult.status !== 0) {
    throw new Error(`cli task pending cancel cleared route smoke failed: ${routeAfterCancelResult.stderr || routeAfterCancelResult.stdout}`);
  }
  const routeAfterCancel = JSON.parse(routeAfterCancelResult.stdout);
  const statusAfterCancelResult = spawnSync(process.execPath, ['src/cli.js', '--status'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (statusAfterCancelResult.status !== 0) {
    throw new Error(`cli task pending cancel cleared status smoke failed: ${statusAfterCancelResult.stderr || statusAfterCancelResult.stdout}`);
  }
  const statusAfterCancel = JSON.parse(statusAfterCancelResult.stdout);
  const reminderAfterCancel = reminderStore.list().find((item) => item.id === reminder.id);
  if (
    pendingCancelTask.result?.type !== 'cancel_reminder_needs_clarification'
    || resolvedCancelTask.result?.type !== 'reminder_cancelled'
    || resolvedCancelTask.reason !== 'pending_clarification_response'
    || resolvedCancelTask.pendingBackgroundTaskId !== pendingCancelTask.result.backgroundTaskId
    || routeAfterCancel.delegatesToBackground !== false
    || statusAfterCancel.runtimeState.pendingClarificationCount !== 0
    || reminderAfterCancel?.status !== 'cancelled'
  ) {
    throw new Error('cli task pending cancel cross-process smoke failed');
  }
}

function testCliTaskDetailCommand() {
  const dir = createTempDir('heros-cli-task-detail-');
  const logPath = path.join(dir, 'events.ndjson');
  const env = {
    ...process.env,
    HEROS_DATA_DIR: dir,
    HEROS_EVENT_LOG_PATH: logPath,
  };
  const taskResult = spawnSync(process.execPath, ['src/cli.js', '--task', '记住用户喜欢自然的回答'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (taskResult.status !== 0) {
    throw new Error(`cli task detail setup smoke failed: ${taskResult.stderr || taskResult.stdout}`);
  }
  const task = JSON.parse(taskResult.stdout);
  const detailResult = spawnSync(process.execPath, ['src/cli.js', '--task-detail', task.result.backgroundTaskId], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (detailResult.status !== 0) {
    throw new Error(`cli task detail smoke failed: ${detailResult.stderr || detailResult.stdout}`);
  }
  const detail = JSON.parse(detailResult.stdout);
  if (
    !detail.found
    || detail.task.backgroundTaskId !== task.result.backgroundTaskId
    || !detail.turns.some((turn) => turn.turnId === task.turnId)
    || !detail.timeline.some((entry) => entry.kind === 'memory' && entry.taskType === 'memory')
    || !detail.events.some((event) => event.type === 'memory.created')
  ) {
    throw new Error('cli task detail output smoke failed');
  }
}

function testCliSessionReportCommand() {
  const dir = createTempDir('heros-cli-session-report-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  emitEvent('transcript.completed', {
    text: '下一个提醒是什么',
    turnId: 'turn_session_user',
  });
  emitEvent('background_task.started', {
    backgroundTaskId: 'task_session',
    taskType: 'list_reminders',
    turnId: 'turn_session_user',
  });
  emitEvent('background_task.completed', {
    backgroundTaskId: 'task_session',
    result: { action: 'list_reminders' },
    turnId: 'turn_session_user',
  });
  emitEvent('response.completed', {
    backgroundTaskId: 'task_session',
    source: 'local_task_router',
    sourceTurnId: 'turn_session_user',
    text: '下一个提醒是喝水。',
    turnId: 'turn_session_assistant',
  });
  configureEvents();
  const env = {
    ...process.env,
    HEROS_DATA_DIR: dir,
    HEROS_EVENT_LOG_PATH: logPath,
  };
  const result = spawnSync(process.execPath, ['src/cli.js', '--session-report', '--source-turn-id', 'turn_session_user'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) {
    throw new Error(`cli session report smoke failed: ${result.stderr || result.stdout}`);
  }
  const report = JSON.parse(result.stdout);
  if (
    report.phase !== 'phase_1_no_ui_cli'
    || report.filters.sourceTurnId !== 'turn_session_user'
    || report.turns.total !== 2
    || !report.timeline.items.some((entry) => entry.kind === 'response' && entry.taskType === 'list_reminders')
    || report.backgroundTasks.total !== 1
  ) {
    throw new Error('cli session report output smoke failed');
  }
  const writeResult = spawnSync(process.execPath, ['src/cli.js', '--session-report', '--write', '--background-task-id', 'task_session'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (writeResult.status !== 0) {
    throw new Error(`cli session report write smoke failed: ${writeResult.stderr || writeResult.stdout}`);
  }
  const writtenReport = JSON.parse(writeResult.stdout);
  if (!writtenReport.reportPath || !fs.existsSync(writtenReport.reportPath)) {
    throw new Error('cli session report artifact smoke failed');
  }
  const reportContent = JSON.parse(fs.readFileSync(writtenReport.reportPath, 'utf8'));
  const reportEvent = readEventLog(logPath).find((event) => event.type === 'session_report.created');
  if (
    reportContent.filters.backgroundTaskId !== 'task_session'
    || reportEvent?.reportPath !== writtenReport.reportPath
    || reportEvent.eventCount !== writtenReport.eventSummary.total
  ) {
    throw new Error('cli session report event smoke failed');
  }
}

function testCliAgentContextCommand() {
  const dir = createTempDir('heros-cli-agent-context-');
  const logPath = path.join(dir, 'events.ndjson');
  const reminderStore = new ReminderStore(dir);
  reminderStore.create({
    title: '喝水',
    remindAt: new Date(Date.now() + 60000).toISOString(),
    note: '保持状态',
  });
  const bootstrap = ensureAgentBootstrap(dir);
  const memoryStore = new MemoryStore(bootstrap.files.find((file) => file.endsWith('MEMORY.md')));
  memoryStore.create('用户喜欢自然温暖的语音风格');
  const result = spawnSync(process.execPath, ['src/cli.js', '--agent-context', '明天九点提醒我检查进度'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: dir,
      HEROS_EVENT_LOG_PATH: logPath,
      HEROS_TIME_ZONE: 'Asia/Shanghai',
    },
  });
  if (result.status !== 0) {
    throw new Error(`cli agent context smoke failed: ${result.stderr || result.stdout}`);
  }
  const preview = JSON.parse(result.stdout);
  if (
    preview.delegatesToBackground !== true
    || preview.handledBy !== 'background_agent'
    || preview.taskType !== 'reminder'
    || preview.context.runtime.timeZone !== 'Asia/Shanghai'
    || preview.context.reminders.totalScheduled !== 1
    || preview.context.longTermMemory.total !== 1
    || !preview.context.localTaskRouter.handledLocally.includes('cancel_reminder')
  ) {
    throw new Error('cli agent context output smoke failed');
  }
}

function testCliRealtimeContextCommand() {
  const dir = createTempDir('heros-cli-realtime-context-');
  const logPath = path.join(dir, 'events.ndjson');
  const bootstrap = ensureAgentBootstrap(dir);
  const memoryStore = new MemoryStore(bootstrap.files.find((file) => file.endsWith('MEMORY.md')));
  memoryStore.create('用户喜欢自然温暖的语音风格');
  configureEvents({ logPath });
  emitEvent('transcript.completed', {
    text: '你好',
    turnId: 'turn_realtime_context_user',
    contextVersion: 1,
  });
  configureEvents();
  const result = spawnSync(process.execPath, ['src/cli.js', '--realtime-context'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: dir,
      HEROS_EVENT_LOG_PATH: logPath,
      HEROS_REALTIME_MODEL: 'qwen3.5-omni-plus-realtime',
    },
  });
  if (result.status !== 0) {
    throw new Error(`cli realtime context smoke failed: ${result.stderr || result.stdout}`);
  }
  const preview = JSON.parse(result.stdout);
  if (
    preview.model !== 'qwen3.5-omni-plus-realtime'
    || preview.turnDetection.type !== 'semantic_vad'
    || !preview.instructions.includes('Shared Context JSON')
    || preview.sharedContext.longTermMemory.length !== 1
    || preview.sharedContext.turns[0]?.id !== 'turn_realtime_context_user'
  ) {
    throw new Error('cli realtime context output smoke failed');
  }
}

function testCliContextHealthCommand() {
  const dir = createTempDir('heros-cli-context-health-');
  const logPath = path.join(dir, 'events.ndjson');
  const bootstrap = ensureAgentBootstrap(dir);
  const memoryStore = new MemoryStore(bootstrap.files.find((file) => file.endsWith('MEMORY.md')));
  memoryStore.create('用户喜欢自然温暖的语音风格');
  configureEvents({ logPath });
  emitEvent('transcript.completed', {
    text: '你好',
    turnId: 'turn_context_health_user',
    contextVersion: 1,
  });
  configureEvents();
  const result = spawnSync(process.execPath, ['src/cli.js', '--context-health'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: dir,
      HEROS_EVENT_LOG_PATH: logPath,
    },
  });
  if (result.status !== 0) {
    throw new Error(`cli context health smoke failed: ${result.stderr || result.stdout}`);
  }
  const health = JSON.parse(result.stdout);
  if (
    health.ready !== true
    || health.realtime.contextVersion !== health.backgroundAgent.contextVersion
    || health.realtime.memoryCount !== 1
    || health.backgroundAgent.memoryCount !== 1
    || health.checks.localTaskRouterBoundaryExposed !== true
    || health.checks.realtimeInstructionsContainSharedContext !== true
  ) {
    throw new Error('cli context health output smoke failed');
  }
}

function testCliScenarioCommand() {
  const dir = createTempDir('heros-cli-scenario-');
  const logPath = path.join(dir, 'events.ndjson');
  const result = spawnSync(process.execPath, [
    'src/cli.js',
    '--scenario',
    '记住用户喜欢安静的语音风格',
    '我的记忆',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: dir,
      HEROS_EVENT_LOG_PATH: logPath,
    },
  });
  if (result.status !== 0) {
    throw new Error(`cli scenario smoke failed: ${result.stderr || result.stdout}`);
  }
  const scenario = JSON.parse(result.stdout);
  if (
    scenario.turns.length !== 2
    || scenario.turns[0].result?.type !== 'memory_created'
    || scenario.turns[1].result?.type !== 'memory_listed'
    || !scenario.turns[1].result.message.includes('安静')
  ) {
    throw new Error('cli scenario output smoke failed');
  }
  const events = readEventLog(logPath);
  const scenarioTranscripts = events.filter((event) => event.mode === 'cli_scenario' && event.type === 'transcript.completed');
  if (scenarioTranscripts.length !== 2 || scenario.backgroundTasks !== 2) {
    throw new Error('cli scenario event smoke failed');
  }

  const cancelDir = createTempDir('heros-cli-scenario-cancel-');
  const cancelLogPath = path.join(cancelDir, 'events.ndjson');
  const cancelStore = new ReminderStore(cancelDir);
  const reminder = cancelStore.create({
    title: '喝水',
    remindAt: new Date(Date.now() + 60000).toISOString(),
    note: '',
  });
  const cancelResult = spawnSync(process.execPath, [
    'src/cli.js',
    '--scenario',
    '取消提醒',
    '喝水',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: cancelDir,
      HEROS_EVENT_LOG_PATH: cancelLogPath,
    },
  });
  if (cancelResult.status !== 0) {
    throw new Error(`cli pending cancel scenario smoke failed: ${cancelResult.stderr || cancelResult.stdout}`);
  }
  const cancelScenario = JSON.parse(cancelResult.stdout);
  const cancelItems = cancelStore.list();
  if (
    cancelScenario.turns.length !== 2
    || cancelScenario.turns[0].result?.type !== 'cancel_reminder_needs_clarification'
    || cancelScenario.turns[1].result?.type !== 'reminder_cancelled'
    || cancelScenario.turns[1].reason !== 'pending_clarification_response'
    || cancelScenario.turns[1].pendingBackgroundTaskId !== cancelScenario.turns[0].result.backgroundTaskId
    || cancelItems.find((item) => item.id === reminder.id)?.status !== 'cancelled'
  ) {
    throw new Error('cli pending cancel scenario output smoke failed');
  }

  const forgetDir = createTempDir('heros-cli-scenario-forget-');
  const forgetLogPath = path.join(forgetDir, 'events.ndjson');
  const forgetResult = spawnSync(process.execPath, [
    'src/cli.js',
    '--scenario',
    '记住用户喜欢短回答',
    '忘记',
    '短回答',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: forgetDir,
      HEROS_EVENT_LOG_PATH: forgetLogPath,
    },
  });
  if (forgetResult.status !== 0) {
    throw new Error(`cli pending forget memory scenario smoke failed: ${forgetResult.stderr || forgetResult.stdout}`);
  }
  const forgetScenario = JSON.parse(forgetResult.stdout);
  if (
    forgetScenario.turns.length !== 3
    || forgetScenario.turns[0].result?.type !== 'memory_created'
    || forgetScenario.turns[1].result?.type !== 'forget_memory_needs_clarification'
    || forgetScenario.turns[2].result?.type !== 'memory_deleted'
    || forgetScenario.turns[2].reason !== 'pending_clarification_response'
    || forgetScenario.turns[2].pendingBackgroundTaskId !== forgetScenario.turns[1].result.backgroundTaskId
    || forgetScenario.backgroundTasks !== 3
  ) {
    throw new Error('cli pending forget memory scenario output smoke failed');
  }
  const forgetEvents = readEventLog(forgetLogPath);
  if (!forgetEvents.some((event) => event.type === 'memory.deleted')) {
    throw new Error('cli pending forget memory scenario event smoke failed');
  }
}

function testCliBootstrapCommand() {
  const dir = createTempDir('heros-cli-bootstrap-');
  const result = spawnSync(process.execPath, ['src/cli.js', '--bootstrap'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: dir,
      HEROS_EVENT_LOG_PATH: path.join(dir, 'events.ndjson'),
    },
  });
  if (result.status !== 0) {
    throw new Error(`cli bootstrap smoke failed: ${result.stderr || result.stdout}`);
  }
  const bootstrap = JSON.parse(result.stdout);
  const names = bootstrap.files.map((file) => file.name).sort();
  if (
    bootstrap.bootstrapDir !== path.join(dir, 'agent-bootstrap')
    || bootstrap.memoryCount !== 0
    || names.join(',') !== 'AGENTS.md,MEMORY.md,SOUL.md'
  ) {
    throw new Error('cli bootstrap output smoke failed');
  }
}

function testCliAudioCommand() {
  const result = spawnSync(process.execPath, ['src/cli.js', '--audio'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEROS_DATA_DIR: createTempDir('heros-cli-audio-'),
    },
  });
  if (result.status !== 0) {
    throw new Error(`cli audio smoke failed: ${result.stderr || result.stdout}`);
  }
  const audio = JSON.parse(result.stdout);
  if (audio.recorder.command !== 'rec' || typeof audio.recorder.available !== 'boolean' || audio.player.command !== 'play') {
    throw new Error('cli audio output smoke failed');
  }
}

function testCliPreflightCommand() {
  const dir = createTempDir('heros-cli-preflight-');
  const result = spawnSync(process.execPath, ['src/cli.js', '--preflight'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      DASHSCOPE_API_KEY: 'test-key',
      HEROS_DATA_DIR: dir,
      HEROS_EVENT_LOG_PATH: path.join(dir, 'events.ndjson'),
    },
  });
  if (result.status !== 0) {
    throw new Error(`cli preflight smoke failed: ${result.stderr || result.stdout}`);
  }
  const preflight = JSON.parse(result.stdout);
  if (
    typeof preflight.ready !== 'boolean'
    || preflight.checks.apiKey.ok !== true
    || typeof preflight.checks.audio.recorder.ok !== 'boolean'
    || preflight.checks.audio.capture.checked !== false
    || preflight.checks.runtimeData.dataDir.writable !== true
    || preflight.checks.runtimeData.eventLogDir.writable !== true
    || preflight.checks.bootstrap.ok !== true
  ) {
    throw new Error('cli preflight output smoke failed');
  }

  const probeDir = createTempDir('heros-cli-preflight-probe-');
  const fakeBin = path.join(probeDir, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeWhich = path.join(fakeBin, 'which');
  fs.writeFileSync(fakeWhich, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(fakeWhich, 0o755);
  const probeResult = spawnSync(process.execPath, ['src/cli.js', '--preflight', '--probe-audio', '--duration-ms', '100'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: fakeBin,
      DASHSCOPE_API_KEY: 'test-key',
      HEROS_DATA_DIR: probeDir,
      HEROS_EVENT_LOG_PATH: path.join(probeDir, 'events.ndjson'),
    },
  });
  if (probeResult.status !== 0) {
    throw new Error(`cli preflight audio probe smoke failed: ${probeResult.stderr || probeResult.stdout}`);
  }
  const probePreflight = JSON.parse(probeResult.stdout);
  if (
    probePreflight.ready !== false
    || probePreflight.checks.audio.capture.checked !== true
    || probePreflight.checks.audio.capture.ok !== false
    || !probePreflight.checks.audio.capture.error
  ) {
    throw new Error('cli preflight audio probe output smoke failed');
  }
}

function testCliReviewCommand() {
  const dir = createTempDir('heros-cli-review-');
  const env = {
    ...process.env,
    DASHSCOPE_API_KEY: 'test-key',
    HEROS_DATA_DIR: dir,
    HEROS_EVENT_LOG_PATH: path.join(dir, 'events.ndjson'),
  };
  const result = spawnSync(process.execPath, ['src/cli.js', '--review'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) {
    throw new Error(`cli review smoke failed: ${result.stderr || result.stdout}`);
  }
  const review = JSON.parse(result.stdout);
  if (
    review.phase !== 'phase_1_no_ui_cli'
    || typeof review.ready !== 'boolean'
    || review.checks.routing.createReminderDelegatesToBackground !== true
    || review.checks.routing.updateReminderDelegatesToBackground !== true
    || review.checks.routing.listRemindersHandledLocally !== true
    || review.checks.routing.nextReminderHandledLocally !== true
    || review.checks.routing.cancelReminderHandledLocally !== true
    || review.checks.routing.bareCancelReminderClarifiesLocally !== true
    || review.checks.routing.cancelNextReminderHandledLocally !== true
    || review.checks.routing.pendingCancelReminderHandledLocally !== true
    || review.checks.routing.updateMemoryHandledLocally !== true
    || review.checks.routing.pendingUpdateMemoryHandledLocally !== true
    || review.checks.routing.bareForgetMemoryClarifiesLocally !== true
    || review.checks.routing.pendingForgetMemoryHandledLocally !== true
    || review.checks.routing.chatStaysRealtime !== true
    || !review.checks.sharedContext.localTaskRouter.handledLocally.includes('cancel_reminder')
    || review.checks.sharedContext.localTaskRouter.coversReminderCancel !== true
    || review.checks.sharedContext.localTaskRouter.coversMemoryCrud !== true
    || review.checks.contextHealth.ready !== true
    || review.checks.contextHealth.checks.contextVersionMatches !== true
    || review.checks.contextHealth.checks.realtimeInstructionsContainSharedContext !== true
    || review.checks.singleAudioOutlet.systemDesignConstraint !== true
    || review.checks.singleAudioOutlet.backgroundAnnouncementsUseRealtimeOutlet !== true
    || review.checks.singleAudioOutlet.correlatesAnnouncementsToRealtimeResponses !== true
    || review.checks.interruption.systemDesignConstraint !== true
    || review.checks.interruption.cancelsBackgroundTasksOnSpeech !== true
    || review.checks.interruption.interruptsRealtimeResponse !== true
    || review.checks.interruption.skipsStaleAnnouncements !== true
    || review.checks.commandSurface.check !== true
    || review.checks.commandSurface.verify !== true
    || review.checks.commandSurface.doctor !== true
    || review.checks.commandSurface.status !== true
    || review.checks.commandSurface.events !== true
    || review.checks.commandSurface.eventSummary !== true
    || review.checks.commandSurface.runtimeState !== true
    || review.checks.commandSurface.context !== true
    || review.checks.commandSurface.route !== true
    || review.checks.commandSurface.task !== true
    || review.checks.commandSurface.scenario !== true
    || review.checks.commandSurface.bootstrap !== true
    || review.checks.commandSurface.preflight !== true
    || review.checks.commandSurface.review !== true
    || review.checks.commandSurface.reviewReport !== true
    || review.checks.commandSurface.reminders !== true
    || review.checks.commandSurface.cancelReminder !== true
    || review.checks.commandSurface.taskDetail !== true
    || review.checks.commandSurface.sessionReport !== true
    || review.checks.commandSurface.agentContext !== true
    || review.checks.commandSurface.realtimeContext !== true
    || review.checks.commandSurface.contextHealth !== true
    || review.checks.commandSurface.updateReminder !== true
    || review.checks.commandSurface.remember !== true
    || review.checks.commandSurface.updateMemory !== true
    || review.checks.commandSurface.forgetMemory !== true
    || review.checks.commandSurface.realtime !== true
    || review.checks.commandSurface.voice !== true
    || review.checks.docs.readme !== true
    || review.checks.docs.systemDesign !== true
    || review.checks.docs.productDefinition !== true
    || review.checks.docs.desktopFirst !== true
    || review.checks.docs.phaseOneNoUi !== true
    || review.checks.docs.realtimeInteractionModel !== true
    || review.checks.docs.backgroundModel !== true
    || review.checks.docs.sharedContext !== true
    || review.checks.docs.mvpReminderLoop !== true
    || review.checks.docs.phaseTwoUiAfterCli !== true
    || review.checks.docs.localTaskRouter !== true
  ) {
    throw new Error('cli review output smoke failed');
  }
  const reviewEvents = readEventLog(env.HEROS_EVENT_LOG_PATH).filter((event) => event.type === 'review.completed');
  if (reviewEvents.length !== 1 || reviewEvents[0].phase !== review.phase || reviewEvents[0].ready !== review.ready) {
    throw new Error('cli review event smoke failed');
  }

  const reportResult = spawnSync(process.execPath, ['src/cli.js', '--review-report'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (reportResult.status !== 0) {
    throw new Error(`cli review report smoke failed: ${reportResult.stderr || reportResult.stdout}`);
  }
  const reportReview = JSON.parse(reportResult.stdout);
  if (!reportReview.reportPath || !reportReview.reportPath.startsWith(path.join(dir, 'reviews'))) {
    throw new Error('cli review report path smoke failed');
  }
  const report = JSON.parse(fs.readFileSync(reportReview.reportPath, 'utf8'));
  if (report.phase !== reportReview.phase || report.ready !== reportReview.ready) {
    throw new Error('cli review report content smoke failed');
  }
  const reportEvent = readEventLog(env.HEROS_EVENT_LOG_PATH).filter((event) => event.type === 'review.completed').at(-1);
  if (reportEvent?.reportPath !== reportReview.reportPath || reportEvent.ready !== reportReview.ready) {
    throw new Error('cli review report event smoke failed');
  }
}

function testCliReminderCommands() {
  const dir = createTempDir('heros-cli-reminders-');
  const logPath = path.join(dir, 'events.ndjson');
  const store = new ReminderStore(dir);
  const reminder = store.create({
    title: '喝水',
    remindAt: new Date(Date.now() + 60000).toISOString(),
    note: '',
  });
  const env = {
    ...process.env,
    HEROS_DATA_DIR: dir,
    HEROS_EVENT_LOG_PATH: logPath,
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

  const updatedAt = new Date(Date.now() + 120000).toISOString();
  const updateResult = spawnSync(process.execPath, [
    'src/cli.js',
    '--update-reminder',
    reminder.id,
    '--time',
    updatedAt,
    '--title',
    '喝水休息',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (updateResult.status !== 0) {
    throw new Error(`cli update reminder smoke failed: ${updateResult.stderr || updateResult.stdout}`);
  }
  const updated = JSON.parse(updateResult.stdout);
  if (updated.remindAt !== updatedAt || updated.title !== '喝水休息' || store.list()[0].title !== '喝水休息') {
    throw new Error('cli update reminder output smoke failed');
  }
  const updateEvent = readEventLog(logPath).find((event) => event.type === 'reminder.updated');
  if (updateEvent?.reminder?.id !== reminder.id || updateEvent.patch.remindAt !== updatedAt) {
    throw new Error('cli update reminder event smoke failed');
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
  const cancelEvent = readEventLog(logPath).find((event) => event.type === 'reminder.cancelled');
  if (cancelEvent?.reminder?.id !== reminder.id) {
    throw new Error('cli cancel reminder event smoke failed');
  }

  const due = store.create({
    title: '站起来活动',
    remindAt: new Date(Date.now() - 1000).toISOString(),
    note: '',
  });
  const checkResult = spawnSync(process.execPath, ['src/cli.js', '--check-reminders'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (checkResult.status !== 0) {
    throw new Error(`cli check reminders smoke failed: ${checkResult.stderr || checkResult.stdout}`);
  }
  const checked = JSON.parse(checkResult.stdout);
  if (checked.length !== 1 || checked[0].id !== due.id || store.list().find((item) => item.id === due.id)?.status !== 'triggered') {
    throw new Error('cli check reminders output smoke failed');
  }
}

function testCliMemoryCommands() {
  const dir = createTempDir('heros-cli-memory-');
  const logPath = path.join(dir, 'events.ndjson');
  const env = {
    ...process.env,
    HEROS_DATA_DIR: dir,
    HEROS_EVENT_LOG_PATH: logPath,
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
  const createdEvent = readEventLog(logPath).find((event) => event.type === 'memory.created');
  if (createdEvent?.memory?.id !== memory.id) {
    throw new Error('cli remember event smoke failed');
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
  const updatedEvent = readEventLog(logPath).find((event) => event.type === 'memory.updated');
  if (updatedEvent?.memory?.id !== memory.id || !updatedEvent.memory.content.includes('温度')) {
    throw new Error('cli update memory event smoke failed');
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
  const deletedEvent = readEventLog(logPath).find((event) => event.type === 'memory.deleted');
  if (deletedEvent?.memoryId !== memory.id) {
    throw new Error('cli forget memory event smoke failed');
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

function testEnvExampleCoverage() {
  const text = fs.readFileSync('.env.example', 'utf8');
  const expected = [
    'DASHSCOPE_API_KEY',
    'DASHSCOPE_BASE_URL',
    'DASHSCOPE_REQUEST_TIMEOUT_MS',
    'HEROS_REALTIME_URL',
    'HEROS_REALTIME_MODEL',
    'HEROS_REALTIME_VOICE',
    'HEROS_REALTIME_INPUT_TRANSCRIPTION_MODEL',
    'HEROS_REALTIME_TURN_DETECTION',
    'HEROS_REALTIME_VAD_THRESHOLD',
    'HEROS_REALTIME_VAD_PREFIX_PADDING_MS',
    'HEROS_REALTIME_VAD_SILENCE_DURATION_MS',
    'HEROS_REALTIME_CONNECT_RETRIES',
    'HEROS_REALTIME_CONNECT_RETRY_DELAY_MS',
    'HEROS_BACKGROUND_MODEL',
    'HEROS_BACKGROUND_TASK_TIMEOUT_MS',
    'HEROS_TIME_ZONE',
    'HEROS_DATA_DIR',
    'HEROS_EVENT_LOG_PATH',
    'HEROS_REMINDER_POLL_MS',
  ];
  const missing = expected.filter((name) => !new RegExp(`^${name}=`, 'm').test(text));
  if (missing.length > 0) {
    throw new Error(`env example missing keys: ${missing.join(', ')}`);
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

async function testBackgroundAgentSystemPrompt() {
  const dir = createTempDir('heros-agent-prompt-');
  const reminderStore = new ReminderStore(dir);
  let systemPrompt = '';
  const agent = new BackgroundAgent({
    reminderStore,
    model: 'fake',
    timeZone: 'Asia/Shanghai',
    client: {
      async text({ messages }) {
        systemPrompt = messages[0].content;
        return JSON.stringify({
          action: 'none',
          reminderId: '',
          title: '',
          remindAt: '',
          note: '',
          clarifyingQuestion: '',
        });
      },
    },
  });
  await agent.handleTask({
    userText: '查询我的提醒',
    context: {},
    backgroundTaskId: 'task_agent_prompt',
    turnId: 'turn_agent_prompt',
  });
  if (!systemPrompt.includes('Local Task Router') || !systemPrompt.includes('long-term memory CRUD')) {
    throw new Error('background agent local task router prompt smoke failed');
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

async function testBackgroundAgentReminderCreatedEvent() {
  const dir = createTempDir('heros-agent-created-event-');
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
          action: 'create_reminder',
          title: '喝水',
          remindAt: new Date(Date.now() + 60000).toISOString(),
          note: '',
          clarifyingQuestion: '',
        });
      },
    },
  });
  const result = await agent.handleTask({
    backgroundTaskId: 'task_created_event',
    turnId: 'turn_created_event',
    userText: '提醒我喝水',
    context: {},
  });
  const createdEvent = readEventLog(logPath).find((event) => event.type === 'reminder.created');
  if (
    result.type !== 'reminder_created'
    || createdEvent?.backgroundTaskId !== 'task_created_event'
    || createdEvent.turnId !== 'turn_created_event'
    || createdEvent.reminder.id !== result.reminder.id
  ) {
    throw new Error('background agent reminder created event smoke failed');
  }
  configureEvents();
}

async function testBackgroundAgentReminderUpdatedEvent() {
  const dir = createTempDir('heros-agent-updated-event-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  const reminderStore = new ReminderStore(dir);
  const original = reminderStore.create({
    title: '喝水',
    remindAt: new Date(Date.now() + 60000).toISOString(),
    note: '',
  });
  const updatedAt = new Date(Date.now() + 120000).toISOString();
  const agent = new BackgroundAgent({
    reminderStore,
    model: 'fake',
    timeZone: 'Asia/Shanghai',
    client: {
      async text() {
        return JSON.stringify({
          action: 'update_reminder',
          reminderId: original.id,
          title: '',
          remindAt: updatedAt,
          note: '',
          clarifyingQuestion: '',
        });
      },
    },
  });
  const result = await agent.handleTask({
    backgroundTaskId: 'task_updated_event',
    turnId: 'turn_updated_event',
    userText: '把喝水提醒改到两分钟后',
    context: {
      reminders: {
        scheduled: [original],
      },
    },
  });
  const events = readEventLog(logPath);
  const updatedEvent = events.find((event) => event.type === 'reminder.updated');
  const toolEvent = events.find((event) => event.type === 'tool_call.completed');
  if (
    result.type !== 'reminder_updated'
    || result.reminder.id !== original.id
    || result.reminder.remindAt !== updatedAt
    || updatedEvent?.backgroundTaskId !== 'task_updated_event'
    || updatedEvent.turnId !== 'turn_updated_event'
    || toolEvent?.toolName !== 'update_reminder'
  ) {
    throw new Error('background agent reminder updated event smoke failed');
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
  const dir = createTempDir('heros-router-background-failure-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
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
  const errors = summarizeErrors(readEventLog(logPath));
  if (errors.total !== 1 || errors.errors[0].type !== 'background_task.failed') {
    throw new Error('task router background failure error event smoke failed');
  }
  configureEvents();
}

async function testTaskRouterBackgroundClarification() {
  const context = new SharedContext();
  let calls = 0;
  let continuation = null;
  const router = new TaskRouter({
    context,
    memoryStore: null,
    reminderStore: null,
    backgroundAgent: {
      async handleTask({ userText, context: contextPackage }) {
        calls += 1;
        if (calls === 2) {
          continuation = { userText, contextPackage };
          return {
            type: 'none',
            message: '',
          };
        }
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
  const decision = router.shouldDelegate('九点');
  if (decision?.type !== 'reminder' || decision.reason !== 'pending_clarification_response') {
    throw new Error('task router pending clarification route smoke failed');
  }
  await router.maybeHandle('九点', { turnId: 'turn_clarify_answer' });
  if (
    continuation?.userText !== '九点'
    || continuation.contextPackage.pendingClarification?.backgroundTaskId !== result.backgroundTaskId
    || context.snapshot().backgroundTasks.at(-1).status !== 'none'
  ) {
    throw new Error('task router pending clarification context package smoke failed');
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

async function testTaskRouterBackgroundContextPackage() {
  const dir = createTempDir('heros-router-context-package-');
  const context = new SharedContext();
  const reminderStore = new ReminderStore(dir);
  const memoryStore = new MemoryStore(path.join(dir, 'MEMORY.md'));
  reminderStore.create({
    title: '喝水',
    remindAt: new Date(Date.now() + 60000).toISOString(),
    note: 'DASHSCOPE_API_KEY=should-not-leak',
  });
  memoryStore.create('用户喜欢安静的语音风格');
  let receivedContext = null;
  const router = new TaskRouter({
    context,
    memoryStore,
    reminderStore,
    timeZone: 'Asia/Shanghai',
    backgroundAgent: {
      async handleTask({ context: contextPackage }) {
        receivedContext = contextPackage;
        return { type: 'none', message: '' };
      },
    },
  });
  await router.maybeHandle('明天九点提醒我喝水', { turnId: 'turn_context_package' });
  if (
    receivedContext?.runtime?.timeZone !== 'Asia/Shanghai'
    || receivedContext.reminders.totalScheduled !== 1
    || receivedContext.reminders.scheduled[0].title !== '喝水'
    || receivedContext.longTermMemory.total !== 1
    || !receivedContext.localTaskRouter.handledLocally.includes('cancel_reminder')
    || !receivedContext.localTaskRouter.handledLocally.includes('update_memory')
    || !receivedContext.sharedContext
  ) {
    throw new Error('task router background context package smoke failed');
  }
  if (JSON.stringify(receivedContext).includes('should-not-leak')) {
    throw new Error('task router background context package redaction smoke failed');
  }
}

async function testTaskRouterForgetMemory() {
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
  const clarify = router.handleForgetMemory('忘记');
  if (clarify.type !== 'forget_memory_needs_clarification' || memoryStore.list().length !== 1) {
    throw new Error('empty forget memory query did not clarify');
  }
  const result = router.handleForgetMemory('忘记安静的语音风格');
  if (result.type !== 'memory_deleted' || memoryStore.list().length !== 0) {
    throw new Error('task router forget memory smoke failed');
  }
  if (context.snapshot().longTermMemory.length !== 0) {
    throw new Error('task router forget memory context smoke failed');
  }

  const pendingDir = createTempDir('heros-router-pending-forget-memory-');
  const pendingMemoryStore = new MemoryStore(path.join(pendingDir, 'MEMORY.md'));
  pendingMemoryStore.create('用户喜欢短回答');
  const pendingContext = new SharedContext();
  pendingContext.setLongTermMemory(pendingMemoryStore.list());
  const pendingRouter = new TaskRouter({
    context: pendingContext,
    memoryStore: pendingMemoryStore,
    reminderStore: null,
    backgroundAgent: null,
  });
  const pendingClarify = await pendingRouter.maybeHandle('忘记', { turnId: 'turn_forget_memory_pending' });
  const pendingDecision = pendingRouter.shouldDelegate('短回答');
  const pendingResult = await pendingRouter.maybeHandle('短回答', { turnId: 'turn_forget_memory_answer' });
  if (
    pendingClarify.type !== 'forget_memory_needs_clarification'
    || pendingDecision?.type !== 'forget_memory'
    || pendingDecision.reason !== 'pending_clarification_response'
    || pendingDecision.pendingBackgroundTaskId !== pendingClarify.backgroundTaskId
    || pendingResult.type !== 'memory_deleted'
    || pendingMemoryStore.list().length !== 0
    || pendingContext.snapshot().longTermMemory.length !== 0
  ) {
    throw new Error('task router pending forget memory smoke failed');
  }
}

async function testTaskRouterUpdateMemory() {
  const dir = createTempDir('heros-router-update-memory-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  const memoryStore = new MemoryStore(path.join(dir, 'MEMORY.md'));
  memoryStore.create('用户喜欢安静的语音风格');
  const context = new SharedContext();
  const router = new TaskRouter({
    context,
    memoryStore,
    reminderStore: null,
    backgroundAgent: null,
  });
  const result = router.handleUpdateMemory('把记忆里安静的语音风格改成用户喜欢自然温暖的语音风格');
  if (result.type !== 'memory_updated' || !result.memory.content.includes('自然温暖')) {
    throw new Error('task router update memory smoke failed');
  }
  if (context.snapshot().longTermMemory[0]?.content !== result.memory.content) {
    throw new Error('task router update memory context smoke failed');
  }
  const updatedEvent = readEventLog(logPath).find((event) => event.type === 'memory.updated');
  if (updatedEvent?.backgroundTaskId !== result.backgroundTaskId || updatedEvent.memory.id !== result.memory.id) {
    throw new Error('task router update memory event smoke failed');
  }
  configureEvents();

  const pendingDir = createTempDir('heros-router-pending-update-memory-');
  const pendingMemoryStore = new MemoryStore(path.join(pendingDir, 'MEMORY.md'));
  const pendingMemory = pendingMemoryStore.create('用户喜欢短回答');
  const pendingContext = new SharedContext();
  pendingContext.setLongTermMemory(pendingMemoryStore.list());
  const pendingRouter = new TaskRouter({
    context: pendingContext,
    memoryStore: pendingMemoryStore,
    reminderStore: null,
    backgroundAgent: null,
  });
  const pendingClarify = await pendingRouter.maybeHandle('修改记忆', { turnId: 'turn_update_memory_pending' });
  const pendingDecision = pendingRouter.shouldDelegate('短回答改成用户喜欢详细回答');
  const pendingUpdate = await pendingRouter.maybeHandle('短回答改成用户喜欢详细回答', { turnId: 'turn_update_memory_answer' });
  const updatedMemory = pendingMemoryStore.list().find((memory) => memory.id === pendingMemory.id);
  if (
    pendingClarify.type !== 'update_memory_needs_clarification'
    || pendingDecision?.type !== 'update_memory'
    || pendingDecision.reason !== 'pending_clarification_response'
    || pendingDecision.pendingBackgroundTaskId !== pendingClarify.backgroundTaskId
    || pendingUpdate.type !== 'memory_updated'
    || !updatedMemory?.content.includes('详细回答')
  ) {
    throw new Error('task router pending update memory smoke failed');
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
  if (likelyReminder('明天九点')) {
    throw new Error('bare time was misclassified as reminder without pending clarification');
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
  if (!likelyListReminders('查询一下提醒') || !likelyListReminders('下一个提醒是什么？')) {
    throw new Error('natural list reminders intent smoke failed');
  }
  if (!likelyNextReminder('下一个提醒是什么？')) {
    throw new Error('next reminder intent smoke failed');
  }
  if (!likelyUpdateReminder('把喝水提醒改到明天十点')) {
    throw new Error('update reminder intent smoke failed');
  }
  if (!likelyListMemory('你记得什么？')) {
    throw new Error('list memory intent smoke failed');
  }
  if (!likelyListMemory('查询长期记忆')) {
    throw new Error('natural list memory intent smoke failed');
  }
  if (!likelyUpdateMemory('把记忆里短回答改成用户喜欢详细回答')) {
    throw new Error('update memory intent smoke failed');
  }
  if (!likelyUpdateMemory('修改记忆')) {
    throw new Error('bare update memory intent smoke failed');
  }
  if (!likelyForgetMemory('忘记用户喜欢安静的语音风格')) {
    throw new Error('forget memory intent smoke failed');
  }
  if (!likelyForgetMemory('删除记忆用户喜欢安静的语音风格')) {
    throw new Error('delete memory intent smoke failed');
  }
  if (!likelyForgetMemory('忘记')) {
    throw new Error('bare forget memory intent smoke failed');
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
    reminderId: 'reminder_announcement',
    source: 'background_task',
    turnId: 'turn_user_source',
  };
  loop.currentAssistantTurnId = 'turn_announcement';
  realtime.emit('event', { type: 'response.done' });
  const completed = readEventLog(logPath).find((event) => event.type === 'response.completed');
  const responseDoneState = readEventLog(logPath).find((event) => event.type === 'state.changed' && event.reason === 'response_done');
  if (
    completed?.backgroundTaskId !== 'task_announcement'
    || completed.reminderId !== 'reminder_announcement'
    || completed.source !== 'background_task'
    || completed.sourceTurnId !== 'turn_user_source'
    || responseDoneState?.turnId !== 'turn_announcement'
  ) {
    throw new Error('voice loop announcement response correlation smoke failed');
  }
  configureEvents();
}

async function testVoiceLoopReminderAnnouncementCorrelation() {
  const dir = createTempDir('heros-reminder-announcement-correlation-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  const reminderScheduler = new ReminderScheduler({
    reminderStore: new ReminderStore(dir),
    pollMs: 1000,
  });
  const loop = new VoiceLoop({
    config: {},
    realtime: {
      createUserTextMessage() {},
      createResponse() {},
      async waitFor() {},
    },
    taskRouter: null,
    context: new SharedContext(),
    reminderScheduler,
    playAudio: false,
  });
  reminderScheduler.onTriggered((reminder) => {
    loop.enqueueAnnouncement(`提醒时间到了：${reminder.title}`, {
      reminderId: reminder.id,
      source: 'reminder_due',
    });
  });
  const reminder = reminderScheduler.reminderStore.create({
    title: '喝水',
    remindAt: new Date(Date.now() - 1000).toISOString(),
    note: '',
  });
  reminderScheduler.check({ print: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const events = readEventLog(logPath);
  const queued = events.find((event) => event.type === 'announcement.queued');
  const completed = events.find((event) => event.type === 'announcement.completed');
  if (
    queued?.reminderId !== reminder.id
    || queued.source !== 'reminder_due'
    || completed?.reminderId !== reminder.id
  ) {
    throw new Error('voice loop reminder announcement correlation smoke failed');
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

async function testVoiceLoopStartupFailureEvents() {
  const dir = createTempDir('heros-voice-startup-failure-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  let closed = false;
  const realtime = new EventEmitter();
  realtime.connect = async () => {
    throw new Error('connect boom');
  };
  realtime.close = () => {
    closed = true;
  };
  const loop = new VoiceLoop({
    config: {
      realtimeConnectRetries: 0,
      realtimeConnectRetryDelayMs: 0,
    },
    realtime,
    taskRouter: null,
    context: new SharedContext(),
    reminderScheduler: null,
    playAudio: false,
  });
  let failed = false;
  try {
    await loop.start({ durationMs: 1 });
  } catch (error) {
    failed = error.message === 'connect boom';
  }
  const events = readEventLog(logPath);
  const failure = events.find((event) => event.type === 'voice_loop.failed');
  const errorState = events.find((event) => event.type === 'state.changed' && event.state === 'error');
  if (!failed || !closed || failure?.message !== 'connect boom' || errorState?.reason !== 'voice_loop_failed') {
    throw new Error('voice loop startup failure event smoke failed');
  }
  configureEvents();
}

async function testVoiceLoopBackgroundState() {
  const dir = createTempDir('heros-voice-background-state-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
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
  loop.delegateTask('明天九点提醒我喝水', { turnEpoch: 2, turnId: 'turn_background_state' });
  if (loop.state !== 'background_running') {
    throw new Error('voice loop did not enter background_running');
  }
  await Promise.allSettled([...loop.backgroundTasks]);
  if (loop.state !== 'listening') {
    throw new Error('voice loop did not leave background_running');
  }
  const states = readEventLog(logPath).filter((event) => event.type === 'state.changed');
  const started = states.find((event) => event.reason === 'background_task_started');
  const finished = states.find((event) => event.reason === 'background_task_finished');
  if (
    started?.turnId !== 'turn_background_state'
    || started.turnEpoch !== 2
    || finished?.turnId !== 'turn_background_state'
    || finished.turnEpoch !== 2
  ) {
    throw new Error('voice loop background state metadata smoke failed');
  }
  configureEvents();
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

async function testTaskRouterCancelReminder() {
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

  const pendingDir = createTempDir('heros-router-pending-cancel-reminder-');
  const pendingStore = new ReminderStore(pendingDir);
  const pendingReminder = pendingStore.create({
    title: '喝水',
    remindAt: new Date(Date.now() + 60000).toISOString(),
    note: '',
  });
  const pendingContext = new SharedContext();
  const pendingRouter = new TaskRouter({
    context: pendingContext,
    reminderStore: pendingStore,
    memoryStore: null,
    backgroundAgent: null,
  });
  const pendingClarify = await pendingRouter.maybeHandle('取消提醒', { turnId: 'turn_cancel_pending' });
  const pendingDecision = pendingRouter.shouldDelegate('喝水');
  const pendingResult = await pendingRouter.maybeHandle('喝水', { turnId: 'turn_cancel_answer' });
  if (
    pendingClarify.type !== 'cancel_reminder_needs_clarification'
    || pendingDecision?.type !== 'cancel_reminder'
    || pendingDecision.reason !== 'pending_clarification_response'
    || pendingDecision.pendingBackgroundTaskId !== pendingClarify.backgroundTaskId
    || pendingResult.type !== 'reminder_cancelled'
    || pendingStore.list().find((item) => item.id === pendingReminder.id)?.status !== 'cancelled'
  ) {
    throw new Error('task router pending cancel reminder smoke failed');
  }

  const ambiguousDir = createTempDir('heros-router-ambiguous-cancel-reminder-');
  const ambiguousStore = new ReminderStore(ambiguousDir);
  const earlyReminder = ambiguousStore.create({
    title: '早喝水',
    remindAt: new Date(Date.now() + 60000).toISOString(),
    note: '',
  });
  const lateReminder = ambiguousStore.create({
    title: '晚喝水',
    remindAt: new Date(Date.now() + 120000).toISOString(),
    note: '',
  });
  const ambiguousContext = new SharedContext();
  const ambiguousRouter = new TaskRouter({
    context: ambiguousContext,
    reminderStore: ambiguousStore,
    memoryStore: null,
    backgroundAgent: null,
  });
  const ambiguousResult = await ambiguousRouter.maybeHandle('取消喝水提醒', { turnId: 'turn_cancel_ambiguous' });
  const ambiguousDecision = ambiguousRouter.shouldDelegate('早');
  const resolvedAmbiguous = await ambiguousRouter.maybeHandle('早', { turnId: 'turn_cancel_ambiguous_answer' });
  const ambiguousItems = ambiguousStore.list();
  if (
    ambiguousResult.type !== 'cancel_reminder_ambiguous'
    || ambiguousDecision?.type !== 'cancel_reminder'
    || ambiguousDecision.reason !== 'pending_clarification_response'
    || resolvedAmbiguous.type !== 'reminder_cancelled'
    || resolvedAmbiguous.reminder.id !== earlyReminder.id
    || ambiguousItems.find((item) => item.id === earlyReminder.id)?.status !== 'cancelled'
    || ambiguousItems.find((item) => item.id === lateReminder.id)?.status !== 'scheduled'
  ) {
    throw new Error('task router ambiguous cancel reminder follow-up smoke failed');
  }

  const nextDir = createTempDir('heros-router-next-reminder-');
  const nextStore = new ReminderStore(nextDir);
  const earlier = nextStore.create({
    title: '早提醒',
    remindAt: new Date(Date.now() + 60000).toISOString(),
    note: '',
  });
  const later = nextStore.create({
    title: '晚提醒',
    remindAt: new Date(Date.now() + 120000).toISOString(),
    note: '',
  });
  const nextRouter = new TaskRouter({
    context: new SharedContext(),
    reminderStore: nextStore,
    memoryStore: null,
    backgroundAgent: null,
  });
  const nextResult = nextRouter.handleCancelReminder('取消下一个提醒');
  const nextItems = nextStore.list();
  if (
    nextResult.type !== 'reminder_cancelled'
    || nextResult.reminder.id !== earlier.id
    || nextItems.find((item) => item.id === earlier.id)?.status !== 'cancelled'
    || nextItems.find((item) => item.id === later.id)?.status !== 'scheduled'
  ) {
    throw new Error('task router cancel next reminder smoke failed');
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
  const next = router.handleListReminders({ nextOnly: true });
  if (next.type !== 'next_reminder_listed' || next.reminders.length !== 1 || !next.message.includes('下一个提醒')) {
    throw new Error('task router next reminder smoke failed');
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
await testCommandExistsMissingWhich();
testReminderScheduler();
testMemoryStore();
testBackgroundTaskSummary();
testRuntimeStateSummary();
testTimelineSummary();
testTurnSummary();
await testCliInteractionTurns();
testErrorSummary();
testAgentBootstrap();
testCliStatusOutput();
testCliHelpOutput();
testCliRuntimeStateCommand();
testCliTimelineCommand();
testSharedContextSummary();
testSharedContextHydration();
testRuntimeHydratesEventLog();
testRuntimeHydratesPendingClarification();
testCliContextCommand();
testCliTurnsCommand();
testCliTranscriptCommand();
testCliErrorsCommand();
testCliRouteCommand();
testCliTaskCommand();
testCliTaskDetailCommand();
testCliSessionReportCommand();
testCliAgentContextCommand();
testCliRealtimeContextCommand();
testCliContextHealthCommand();
testCliScenarioCommand();
testCliBootstrapCommand();
testCliAudioCommand();
testCliPreflightCommand();
testCliReviewCommand();
testCliReminderCommands();
testCliMemoryCommands();
testConfigNumberFallback();
testEnvExampleCoverage();
testSharedContextRedaction();
await testCliBackgroundResponseCorrelation();
testIntentBoundaries();
testStaleAnnouncementSkip();
testVoiceLoopRealtimeInstructions();
testVoiceLoopAssistantTurnId();
testVoiceLoopAnnouncementResponseCorrelation();
await testVoiceLoopReminderAnnouncementCorrelation();
await testRealtimeConnectRetry();
await testRealtimeWaitForClose();
await testVoiceLoopStartupFailureEvents();
await testVoiceLoopBackgroundState();
await testVoiceLoopBackgroundCancellation();
await testVoiceLoopShutdownCancelsBackgroundTasks();
testTaskRouterMemory();
await testTaskRouterTurnLink();
await testTaskRouterBackgroundFailure();
await testTaskRouterBackgroundClarification();
await testTaskRouterBackgroundTimeout();
await testTaskRouterBackgroundCancellation();
await testTaskRouterBackgroundContextPackage();
await testTaskRouterForgetMemory();
await testTaskRouterUpdateMemory();
await testTaskRouterCancelReminder();
testTaskRouterListReminders();
testTaskRouterListMemory();
await testBackgroundAgentSystemPrompt();
await testBackgroundAgentInvalidReminder();
await testBackgroundAgentPastReminder();
await testBackgroundAgentLifecycleEvents();
await testBackgroundAgentReminderCreatedEvent();
await testBackgroundAgentReminderUpdatedEvent();
await testBackgroundAgentAbortBeforeToolCall();
await testDashScopeExternalAbortReason();
console.log('smoke ok');
