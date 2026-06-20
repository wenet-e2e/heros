import { emitEvent } from './events.js';
import { extractCancelReminderQuery, extractMemoryContent, likelyCancelReminder, likelyMemory, likelyReminder } from './intents.js';

export class TaskRouter {
  constructor({ backgroundAgent, context, memoryStore, reminderStore }) {
    this.backgroundAgent = backgroundAgent;
    this.context = context;
    this.memoryStore = memoryStore;
    this.reminderStore = reminderStore;
  }

  shouldDelegate(text) {
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

    emitEvent('background_task.requested', {
      taskType: decision.type,
      reason: decision.reason,
    });
    if (decision.type === 'memory') {
      return this.handleMemory(text);
    }
    if (decision.type === 'cancel_reminder') {
      return this.handleCancelReminder(text);
    }
    const result = await this.backgroundAgent.handleTask({
      userText: text,
      context: this.context.snapshot(),
    });
    this.context.addBackgroundTask({
      type: decision.type,
      status: result.type,
      result,
    });
    emitEvent('interaction.context_updated', { contextVersion: this.context.version });
    return result;
  }

  handleCancelReminder(text) {
    emitEvent('background_task.started', { model: 'local_task_router', taskType: 'cancel_reminder' });
    const query = extractCancelReminderQuery(text);
    if (!query) {
      this.context.addBackgroundTask({
        type: 'cancel_reminder',
        status: 'needs_clarification',
        result: { query },
      });
      emitEvent('background_task.completed', { result: { action: 'cancel_reminder_needs_clarification' } });
      emitEvent('interaction.context_updated', { contextVersion: this.context.version });
      return {
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
        type: 'cancel_reminder',
        status: 'not_found',
        result: { query },
      });
      emitEvent('background_task.completed', { result: { action: 'cancel_reminder_not_found', query } });
      emitEvent('interaction.context_updated', { contextVersion: this.context.version });
      return {
        type: 'cancel_reminder_not_found',
        message: `没有找到可取消的提醒：${query}`,
      };
    }
    if (matches.length > 1) {
      this.context.addBackgroundTask({
        type: 'cancel_reminder',
        status: 'ambiguous',
        result: { query, count: matches.length },
      });
      emitEvent('background_task.completed', { result: { action: 'cancel_reminder_ambiguous', query, count: matches.length } });
      emitEvent('interaction.context_updated', { contextVersion: this.context.version });
      return {
        type: 'cancel_reminder_ambiguous',
        message: `找到 ${matches.length} 个相关提醒，需要你说得更具体一点。`,
      };
    }
    const reminder = this.reminderStore.cancel(matches[0].id);
    this.context.addBackgroundTask({
      type: 'cancel_reminder',
      status: 'cancelled',
      result: reminder,
    });
    emitEvent('reminder.cancelled', { reminder });
    emitEvent('background_task.completed', { result: { action: 'cancel_reminder', reminderId: reminder.id } });
    emitEvent('interaction.context_updated', { contextVersion: this.context.version });
    return {
      type: 'reminder_cancelled',
      reminder,
      message: `已取消提醒：${reminder.title}`,
    };
  }

  handleMemory(text) {
    emitEvent('background_task.started', { model: 'local_task_router', taskType: 'memory' });
    const content = extractMemoryContent(text);
    try {
      const memory = this.memoryStore.create(content);
      const memories = this.memoryStore.list();
      this.context.addBackgroundTask({
        type: 'memory',
        status: 'created',
        result: memory,
      });
      this.context.setLongTermMemory(memories);
      emitEvent('memory.created', { memory });
      emitEvent('background_task.completed', { result: { action: 'memory_created', memoryId: memory.id } });
      emitEvent('interaction.context_updated', { contextVersion: this.context.version });
      return {
        type: 'memory_created',
        memory,
        message: `我记住了：${memory.content}`,
      };
    } catch (error) {
      this.context.addBackgroundTask({
        type: 'memory',
        status: 'failed',
        result: { error: error.message },
      });
      emitEvent('memory.failed', { message: error.message });
      emitEvent('background_task.completed', { result: { action: 'memory_failed', error: error.message } });
      emitEvent('interaction.context_updated', { contextVersion: this.context.version });
      return {
        type: 'memory_failed',
        message: '这条内容我不能安全地写入长期记忆。',
      };
    }
  }
}
