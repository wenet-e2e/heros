import { emitEvent } from './events.js';

export class ReminderScheduler {
  constructor({ reminderStore, pollMs = 30000 }) {
    this.reminderStore = reminderStore;
    this.pollMs = pollMs;
    this.timer = null;
  }

  start() {
    if (this.timer) {
      return;
    }
    emitEvent('reminder_scheduler.started', { pollMs: this.pollMs });
    this.check();
    this.timer = setInterval(() => this.check(), this.pollMs);
  }

  stop() {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
    emitEvent('reminder_scheduler.stopped');
  }

  check() {
    const due = this.reminderStore.due();
    for (const reminder of due) {
      const triggered = this.reminderStore.markTriggered(reminder.id);
      emitEvent('reminder.triggered', { reminder: triggered });
      console.log(`\nReminder: ${triggered.title} (${triggered.remindAt})`);
      if (triggered.note) {
        console.log(`Note: ${triggered.note}`);
      }
    }
  }
}
