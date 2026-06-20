import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeTextFileAtomic } from './storage.js';

export class ReminderStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'reminders.json');
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      writeTextFileAtomic(this.filePath, '[]\n');
    }
  }

  list() {
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
  }

  create({ title, remindAt, note }) {
    const reminderTitle = String(title || '').trim();
    if (!reminderTitle) {
      throw new Error('Reminder title is empty');
    }
    const remindAtMs = Date.parse(remindAt);
    if (!Number.isFinite(remindAtMs)) {
      throw new Error(`Invalid reminder time: ${remindAt}`);
    }
    const reminders = this.list();
    const now = new Date().toISOString();
    const reminder = {
      id: crypto.randomUUID(),
      title: reminderTitle,
      remindAt,
      note: String(note || '').trim(),
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
    };
    reminders.push(reminder);
    writeTextFileAtomic(this.filePath, `${JSON.stringify(reminders, null, 2)}\n`);
    return reminder;
  }

  due(now = new Date()) {
    const nowMs = now.getTime();
    return this.list().filter((reminder) => {
      if (reminder.status !== 'scheduled') {
        return false;
      }
      const remindAtMs = Date.parse(reminder.remindAt);
      return Number.isFinite(remindAtMs) && remindAtMs <= nowMs;
    });
  }

  update(id, patch) {
    const reminders = this.list();
    const index = reminders.findIndex((reminder) => reminder.id === id);
    if (index === -1) {
      return null;
    }
    const sanitizedPatch = { ...patch };
    if (Object.hasOwn(sanitizedPatch, 'title')) {
      const title = String(sanitizedPatch.title || '').trim();
      if (!title) {
        throw new Error('Reminder title is empty');
      }
      sanitizedPatch.title = title;
    }
    if (Object.hasOwn(sanitizedPatch, 'remindAt')) {
      const remindAtMs = Date.parse(sanitizedPatch.remindAt);
      if (!Number.isFinite(remindAtMs)) {
        throw new Error(`Invalid reminder time: ${sanitizedPatch.remindAt}`);
      }
    }
    if (Object.hasOwn(sanitizedPatch, 'note')) {
      sanitizedPatch.note = String(sanitizedPatch.note || '').trim();
    }
    reminders[index] = {
      ...reminders[index],
      ...sanitizedPatch,
      updatedAt: new Date().toISOString(),
    };
    writeTextFileAtomic(this.filePath, `${JSON.stringify(reminders, null, 2)}\n`);
    return reminders[index];
  }

  markTriggered(id) {
    return this.update(id, {
      status: 'triggered',
      triggeredAt: new Date().toISOString(),
    });
  }

  cancel(id) {
    const reminder = this.list().find((item) => item.id === id);
    if (!reminder || reminder.status !== 'scheduled') {
      return null;
    }
    return this.update(id, {
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
    });
  }
}
