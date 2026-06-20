#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heros-background-smoke-'));
process.env.HEROS_DATA_DIR = dataDir;
process.env.HEROS_EVENT_LOG_PATH = path.join(dataDir, 'events.ndjson');

const { readEventLog } = await import('../src/eventLog.js');
const { createRuntime } = await import('../src/runtime.js');

let passed = false;
try {
  const runtime = createRuntime();
  const reply = await runtime.interactionModel.respond('明天上午九点提醒我喝水');
  const reminders = runtime.reminderStore.list();
  const reminder = reminders[0];

  if (!reply || reminders.length !== 1 || reminder.status !== 'scheduled') {
    throw new Error(`Background reminder smoke failed: ${reply}`);
  }
  if (!reminder.title.includes('喝水') || Date.parse(reminder.remindAt) <= Date.now()) {
    throw new Error(`Background reminder smoke produced invalid reminder: ${JSON.stringify(reminder)}`);
  }

  const events = readEventLog(runtime.config.eventLogPath);
  if (!events.some((event) => event.type === 'background_task.requested')) {
    throw new Error('Background reminder smoke did not emit background_task.requested');
  }
  if (!events.some((event) => event.type === 'tool_call.completed')) {
    throw new Error('Background reminder smoke did not emit tool_call.completed');
  }

  passed = true;
  console.log(`Background reminder smoke OK: ${reply}`);
} finally {
  if (passed) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } else {
    console.error(`Background reminder smoke data kept for debugging: ${dataDir}`);
  }
}
