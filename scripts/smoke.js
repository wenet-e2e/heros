#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureEvents, emitEvent } from '../src/events.js';
import { BackgroundAgent } from '../src/backgroundAgent.js';
import { MemoryStore } from '../src/memoryStore.js';
import { ReminderStore } from '../src/reminders.js';
import { ReminderScheduler } from '../src/reminderScheduler.js';
import { SharedContext } from '../src/context.js';
import { TaskRouter } from '../src/taskRouter.js';
import { likelyReminder } from '../src/intents.js';
import { filterEvents, readEventLog, summarizeEvents } from '../src/eventLog.js';
import { VoiceLoop } from '../src/voiceLoop.js';
import { ensureAgentBootstrap, readAgentBootstrap } from '../src/bootstrap.js';
import { connectRealtimeWithRetry } from '../src/realtimeRetry.js';

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function testEventLog() {
  const dir = createTempDir('heros-events-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  emitEvent('smoke.event_log', { ok: true, type: 'payload_must_not_override_event_type' });
  emitEvent('smoke.secret_redaction', { text: 'DASHSCOPE_API_KEY=abc123 Bearer secret-token' });
  const events = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
  const event = events[0];
  if (event.type !== 'smoke.event_log' || event.ok !== true) {
    throw new Error('event log smoke failed');
  }
  const redacted = events[1];
  if (redacted.text.includes('abc123') || redacted.text.includes('secret-token')) {
    throw new Error('event secret redaction smoke failed');
  }
  const summary = summarizeEvents(readEventLog(logPath));
  if (summary.total !== 2 || summary.byType['smoke.event_log'] !== 1) {
    throw new Error('event summary smoke failed');
  }
  const filtered = filterEvents(readEventLog(logPath), { type: 'smoke.secret_redaction' });
  if (filtered.length !== 1 || filtered[0].type !== 'smoke.secret_redaction') {
    throw new Error('event filter smoke failed');
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

  let refused = false;
  try {
    store.create({ title: 'bad', remindAt: 'not-a-date', note: '' });
  } catch {
    refused = true;
  }
  if (!refused) {
    throw new Error('invalid reminder time was not refused');
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

function testAgentBootstrap() {
  const dir = createTempDir('heros-bootstrap-');
  const bootstrap = ensureAgentBootstrap(dir);
  const content = readAgentBootstrap(bootstrap.files);
  if (!content['AGENTS.md']?.includes('Mission') || !content['SOUL.md']?.includes('Voice')) {
    throw new Error('agent bootstrap read smoke failed');
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

function testSharedContextRedaction() {
  const context = new SharedContext();
  context.addTurn('user', 'Bearer secret-token');
  if (context.snapshot().turns[0].content.includes('secret-token')) {
    throw new Error('shared context redaction smoke failed');
  }
}

function testIntentBoundaries() {
  if (likelyReminder('你记得我喜欢什么语音风格吗？')) {
    throw new Error('memory question was misclassified as reminder');
  }
  if (!likelyReminder('明天上午九点提醒我喝水')) {
    throw new Error('reminder intent smoke failed');
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
  });
  const events = readEventLog(logPath);
  const skipped = events.find((event) => event.type === 'announcement.skipped');
  if (!skipped || skipped.reason !== 'stale_turn' || skipped.backgroundTaskId !== 'task_old') {
    throw new Error('stale announcement skip smoke failed');
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

function testTaskRouterCancelReminder() {
  const dir = createTempDir('heros-router-reminder-');
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
}

testEventLog();
testReminderScheduler();
testMemoryStore();
testAgentBootstrap();
testSharedContextRedaction();
testIntentBoundaries();
testStaleAnnouncementSkip();
await testRealtimeConnectRetry();
testTaskRouterMemory();
testTaskRouterCancelReminder();
await testBackgroundAgentInvalidReminder();
console.log('smoke ok');
