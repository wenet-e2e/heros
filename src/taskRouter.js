import crypto from 'node:crypto';
import { emitEvent } from './events.js';
import {
  extractCancelReminderQuery,
  extractMemoryContent,
  likelyCancelReminder,
  likelyListReminders,
  likelyMemory,
  likelyReminder,
} from './intents.js';

function createBackgroundTaskId() {
  return `task_${crypto.randomUUID()}`;
}

function formatReminderTime(isoString, timeZone) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export class TaskRouter {
  constructor({ backgroundAgent, context, memoryStore, reminderStore, timeZone }) {
    this.backgroundAgent = backgroundAgent;
    this.context = context;
    this.memoryStore = memoryStore;
    this.reminderStore = reminderStore;
    this.timeZone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  shouldDelegate(text) {
    if (likelyListReminders(text)) {
      return { type: 'list_reminders', reason: 'explicit_list_reminders_request' };
    }
    if (likelyCancelReminder(text)) {
      return { type: 'cancel_reminder', reason: 'explicit_cancel_reminder_request' };
    }
    if (likelyMemory(text)) {
      return { type: 'memory', reason: 'explicit_memory_request' };
    }
    if (likelyReminder(text)) {
      return { type: 'reminder', reason: 'likely_reminder' };
    }
    return null;
  }

  async maybeHandle(text) {
    const decision = this.shouldDelegate(text);
    if (!decision) {
      return null;
    }
    const backgroundTaskId = createBackgroundTaskId();

    emitEvent('background_task.requested', {
      backgroundTaskId,
      taskType: decision.type,
      reason: decision.reason,
    });
    if (decision.type === 'memory') {
      return this.handleMemory(text, { backgroundTaskId });
    }
    if (decision.type === 'cancel_reminder') {
      return this.handleCancelReminder(text, { backgroundTaskId });
    }
    if (decision.type === 'list_reminders') {
      return this.handleListReminders({ backgroundTaskId });
    }
    const result = await this.backgroundAgent.handleTask({
      backgroundTaskId,
      userText: text,
      context: this.context.snapshot(),
    });
    this.context.addBackgroundTask({
      backgroundTaskId,
      type: decision.type,
      status: result.type,
      result,
    });
    emitEvent('interaction.context_updated', { contextVersion: this.context.version });
    return result;
  }

  handleListReminders({ backgroundTaskId = createBackgroundTaskId() } = {}) {
    emitEvent('background_task.started', { backgroundTaskId, model: 'local_task_router', taskType: 'list_reminders' });
    const scheduled = this.reminderStore.list()
      .filter((reminder) => reminder.status === 'scheduled')
      .sort((a, b) => Date.parse(a.remindAt) - Date.parse(b.remindAt));
    this.context.addBackgroundTask({
      backgroundTaskId,
      type: 'list_reminders',
      status: 'completed',
      result: { count: scheduled.length },
    });
    emitEvent('background_task.completed', {
      backgroundTaskId,
      result: { action: 'list_reminders', count: scheduled.length },
    });
    emitEvent('interaction.context_updated', { contextVersion: this.context.version });

    if (scheduled.length === 0) {
      return {
        backgroundTaskId,
        type: 'reminders_listed',
        reminders: scheduled,
        message: '现在没有待触发的提醒。',
      };
    }
    const summary = scheduled.slice(0, 5)
      .map((reminder) => `${reminder.title}，${formatReminderTime(reminder.remindAt, this.timeZone)}`)
      .join('；');
    const suffix = scheduled.length > 5 ? `；另外还有 ${scheduled.length - 5} 个提醒` : '';
    return {
      backgroundTaskId,
      type: 'reminders_listed',
      reminders: scheduled,
      message: `你现在有 ${scheduled.length} 个提醒：${summary}${suffix}`,
    };
  }

  handleCancelReminder(text, { backgroundTaskId = createBackgroundTaskId() } = {}) {
    emitEvent('background_task.started', { backgroundTaskId, model: 'local_task_router', taskType: 'cancel_reminder' });
    const query = extractCancelReminderQuery(text);
    if (!query) {
      this.context.addBackgroundTask({
        backgroundTaskId,
        type: 'cancel_reminder',
        status: 'needs_clarification',
        result: { query },
      });
      emitEvent('background_task.completed', { backgroundTaskId, result: { action: 'cancel_reminder_needs_clarification' } });
      emitEvent('interaction.context_updated', { contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'cancel_reminder_needs_clarification',
        message: '你想取消哪一个提醒？可以说一下提醒内容。',
      };
    }
    const matches = this.reminderStore.list().filter((reminder) => {
      if (reminder.status !== 'scheduled') {
        return false;
      }
      return reminder.title.includes(query) || reminder.note?.includes(query);
    });
    if (matches.length === 0) {
      this.context.addBackgroundTask({
        backgroundTaskId,
        type: 'cancel_reminder',
        status: 'not_found',
        result: { query },
      });
      emitEvent('background_task.completed', { backgroundTaskId, result: { action: 'cancel_reminder_not_found', query } });
      emitEvent('interaction.context_updated', { contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'cancel_reminder_not_found',
        message: `没有找到可取消的提醒：${query}`,
      };
    }
    if (matches.length > 1) {
      this.context.addBackgroundTask({
        backgroundTaskId,
        type: 'cancel_reminder',
        status: 'ambiguous',
        result: { query, count: matches.length },
      });
      emitEvent('background_task.completed', { backgroundTaskId, result: { action: 'cancel_reminder_ambiguous', query, count: matches.length } });
      emitEvent('interaction.context_updated', { contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'cancel_reminder_ambiguous',
        message: `找到 ${matches.length} 个相关提醒，需要你说得更具体一点。`,
      };
    }
    const reminder = this.reminderStore.cancel(matches[0].id);
    this.context.addBackgroundTask({
      backgroundTaskId,
      type: 'cancel_reminder',
      status: 'cancelled',
      result: reminder,
    });
    emitEvent('reminder.cancelled', { backgroundTaskId, reminder });
    emitEvent('background_task.completed', { backgroundTaskId, result: { action: 'cancel_reminder', reminderId: reminder.id } });
    emitEvent('interaction.context_updated', { contextVersion: this.context.version });
    return {
      backgroundTaskId,
      type: 'reminder_cancelled',
      reminder,
      message: `已取消提醒：${reminder.title}`,
    };
  }

  handleMemory(text, { backgroundTaskId = createBackgroundTaskId() } = {}) {
    emitEvent('background_task.started', { backgroundTaskId, model: 'local_task_router', taskType: 'memory' });
    const content = extractMemoryContent(text);
    try {
      const memory = this.memoryStore.create(content);
      const memories = this.memoryStore.list();
      this.context.addBackgroundTask({
        backgroundTaskId,
        type: 'memory',
        status: 'created',
        result: memory,
      });
      this.context.setLongTermMemory(memories);
      emitEvent('memory.created', { backgroundTaskId, memory });
      emitEvent('background_task.completed', { backgroundTaskId, result: { action: 'memory_created', memoryId: memory.id } });
      emitEvent('interaction.context_updated', { contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'memory_created',
        memory,
        message: `我记住了：${memory.content}`,
      };
    } catch (error) {
      this.context.addBackgroundTask({
        backgroundTaskId,
        type: 'memory',
        status: 'failed',
        result: { error: error.message },
      });
      emitEvent('memory.failed', { backgroundTaskId, message: error.message });
      emitEvent('background_task.completed', { backgroundTaskId, result: { action: 'memory_failed', error: error.message } });
      emitEvent('interaction.context_updated', { contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'memory_failed',
        message: '这条内容我不能安全地写入长期记忆。',
      };
    }
  }
}
