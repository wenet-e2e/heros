import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class ReminderStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'reminders.json');
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '[]\n');
    }
  }

  list() {
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
  }

  create({ title, remindAt, note }) {
    const remindAtMs = Date.parse(remindAt);
    if (!Number.isFinite(remindAtMs)) {
      throw new Error(`Invalid reminder time: ${remindAt}`);
    }
    const reminders = this.list();
    const reminder = {
      id: crypto.randomUUID(),
      title,
      remindAt,
      note: note || '',
      status: 'scheduled',
      createdAt: new Date().toISOString(),
    };
    reminders.push(reminder);
    fs.writeFileSync(this.filePath, `${JSON.stringify(reminders, null, 2)}\n`);
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
    reminders[index] = {
      ...reminders[index],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.filePath, `${JSON.stringify(reminders, null, 2)}\n`);
    return reminders[index];
  }

  markTriggered(id) {
    return this.update(id, {
      status: 'triggered',
      triggeredAt: new Date().toISOString(),
    });
  }

  cancel(id) {
    return this.update(id, {
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
    });
  }
}
