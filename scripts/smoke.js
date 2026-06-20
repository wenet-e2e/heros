#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureEvents, emitEvent } from '../src/events.js';
import { BackgroundAgent } from '../src/backgroundAgent.js';
import { MemoryStore } from '../src/memoryStore.js';
import { ReminderStore } from '../src/reminders.js';
import { ReminderScheduler } from '../src/reminderScheduler.js';

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function testEventLog() {
  const dir = createTempDir('heros-events-');
  const logPath = path.join(dir, 'events.ndjson');
  configureEvents({ logPath });
  emitEvent('smoke.event_log', { ok: true, type: 'payload_must_not_override_event_type' });
  const event = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
  if (event.type !== 'smoke.event_log' || event.ok !== true) {
    throw new Error('event log smoke failed');
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
    store.create('api_key=abc');
  } catch {
    refused = true;
  }
  if (!refused) {
    throw new Error('memory secret refusal smoke failed');
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

testEventLog();
testReminderScheduler();
testMemoryStore();
await testBackgroundAgentInvalidReminder();
console.log('smoke ok');
