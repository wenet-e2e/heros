import { emitEvent } from './events.js';

export class ReminderScheduler {
  constructor({ reminderStore, pollMs = 30000 }) {
    this.reminderStore = reminderStore;
    this.pollMs = pollMs;
    this.timer = null;
    this.triggerListeners = new Set();
  }

  onTriggered(listener) {
    this.triggerListeners.add(listener);
    return () => this.triggerListeners.delete(listener);
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

  check({ print = true } = {}) {
    const due = this.reminderStore.due();
    const triggeredReminders = [];
    for (const reminder of due) {
      const triggered = this.reminderStore.markTriggered(reminder.id);
      triggeredReminders.push(triggered);
      emitEvent('reminder.triggered', { reminder: triggered });
      if (print) {
        console.log(`\nReminder: ${triggered.title} (${triggered.remindAt})`);
        if (triggered.note) {
          console.log(`Note: ${triggered.note}`);
        }
      }
      for (const listener of this.triggerListeners) {
        try {
          listener(triggered);
        } catch (error) {
          emitEvent('error', { source: 'reminder.trigger.listener', message: error.message });
        }
      }
    }
    return triggeredReminders;
  }
}
