import { emitEvent } from './events.js';
import { extractMemoryContent, likelyMemory, likelyReminder } from './intents.js';

export class TaskRouter {
  constructor({ backgroundAgent, context, memoryStore }) {
    this.backgroundAgent = backgroundAgent;
    this.context = context;
    this.memoryStore = memoryStore;
  }

  shouldDelegate(text) {
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

  handleMemory(text) {
    const content = extractMemoryContent(text);
    try {
      const memory = this.memoryStore.create(content);
      const memories = this.memoryStore.list();
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
      emitEvent('memory.failed', { message: error.message });
      emitEvent('background_task.completed', { result: { action: 'memory_failed', error: error.message } });
      return {
        type: 'memory_failed',
        message: '这条内容我不能安全地写入长期记忆。',
      };
    }
  }
}
