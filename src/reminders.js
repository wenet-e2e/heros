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
}
