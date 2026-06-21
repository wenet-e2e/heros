import crypto from 'node:crypto';
import { emitEvent } from './events.js';
import {
  extractForgetMemoryQuery,
  extractMemoryContent,
  extractUpdateMemoryPatch,
} from './intents.js';

function createBackgroundTaskId() {
  return `task_${crypto.randomUUID()}`;
}

function emitNeedsClarification({ backgroundTaskId, turnId, question, reason, candidates }) {
  emitEvent('background_task.needs_clarification', {
    backgroundTaskId,
    turnId,
    question,
    reason,
    candidates,
  });
}

export class BackgroundMemoryModule {
  constructor({ context, memoryStore }) {
    this.context = context;
    this.memoryStore = memoryStore;
  }

  syncMemory() {
    const memories = this.memoryStore.list();
    this.context.setLongTermMemory(memories);
    return memories;
  }

  updateContext({ backgroundTaskId, result, status, turnId, type }) {
    this.context.addBackgroundTask({
      backgroundTaskId,
      turnId,
      type,
      status,
      result,
    });
    emitEvent('interaction.context_updated', {
      backgroundTaskId,
      turnId,
      contextVersion: this.context.version,
    });
  }

  list({ backgroundTaskId = createBackgroundTaskId(), turnId } = {}) {
    emitEvent('background_task.started', { backgroundTaskId, turnId, model: 'background_memory_module', taskType: 'list_memory' });
    const memories = this.syncMemory();
    this.context.addBackgroundTask({
      backgroundTaskId,
      turnId,
      type: 'list_memory',
      status: 'completed',
      result: { count: memories.length },
    });
    emitEvent('background_task.completed', {
      backgroundTaskId,
      turnId,
      result: { action: 'list_memory', count: memories.length },
    });
    emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });

    if (memories.length === 0) {
      return {
        backgroundTaskId,
        type: 'memory_listed',
        memories,
        message: '我现在没有长期记忆。',
      };
    }
    const summary = memories.slice(0, 5).map((memory) => memory.content).join('；');
    const suffix = memories.length > 5 ? `；另外还有 ${memories.length - 5} 条记忆` : '';
    return {
      backgroundTaskId,
      type: 'memory_listed',
      memories,
      message: `我现在记得 ${memories.length} 条：${summary}${suffix}`,
    };
  }

  create(text, { backgroundTaskId = createBackgroundTaskId(), turnId } = {}) {
    emitEvent('background_task.started', { backgroundTaskId, turnId, model: 'background_memory_module', taskType: 'memory' });
    const content = extractMemoryContent(text);
    try {
      const memory = this.memoryStore.create(content);
      const memories = this.syncMemory();
      this.context.addBackgroundTask({
        backgroundTaskId,
        turnId,
        type: 'memory',
        status: 'created',
        result: memory,
      });
      this.context.setLongTermMemory(memories);
      emitEvent('memory.created', { backgroundTaskId, turnId, memory });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'memory_created', memoryId: memory.id } });
      emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'memory_created',
        memory,
        message: `我记住了：${memory.content}`,
      };
    } catch (error) {
      this.updateContext({
        backgroundTaskId,
        turnId,
        type: 'memory',
        status: 'failed',
        result: { error: error.message },
      });
      emitEvent('memory.failed', { backgroundTaskId, turnId, message: error.message });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'memory_failed', error: error.message } });
      return {
        backgroundTaskId,
        type: 'memory_failed',
        message: '这条内容我不能安全地写入长期记忆。',
      };
    }
  }

  forget(text, { backgroundTaskId = createBackgroundTaskId(), pendingBackgroundTaskId, turnId } = {}) {
    emitEvent('background_task.started', { backgroundTaskId, turnId, model: 'background_memory_module', taskType: 'forget_memory' });
    const query = extractForgetMemoryQuery(text) || (pendingBackgroundTaskId ? text.trim() : '');
    if (!query) {
      this.updateContext({ backgroundTaskId, turnId, type: 'forget_memory', status: 'needs_clarification', result: { query } });
      emitNeedsClarification({
        backgroundTaskId,
        turnId,
        question: '你想忘记哪条长期记忆？',
        reason: 'missing_forget_memory_query',
      });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'forget_memory_needs_clarification' } });
      return {
        backgroundTaskId,
        type: 'forget_memory_needs_clarification',
        message: '你想忘记哪条长期记忆？',
      };
    }
    const matches = this.memoryStore.list().filter((memory) => memory.content.includes(query));
    if (matches.length === 0) {
      this.updateContext({ backgroundTaskId, turnId, type: 'forget_memory', status: 'not_found', result: { query } });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'forget_memory_not_found', query } });
      return {
        backgroundTaskId,
        type: 'forget_memory_not_found',
        message: `我没有找到这条长期记忆：${query}`,
      };
    }
    if (matches.length > 1) {
      this.updateContext({ backgroundTaskId, turnId, type: 'forget_memory', status: 'ambiguous', result: { query, count: matches.length } });
      emitNeedsClarification({
        backgroundTaskId,
        turnId,
        question: '找到多条相关记忆，需要你说得更具体一点。',
        reason: 'ambiguous_forget_memory_query',
        candidates: matches.slice(0, 5).map((memory) => ({
          id: memory.id,
          content: memory.content,
        })),
      });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'forget_memory_ambiguous', query, count: matches.length } });
      return {
        backgroundTaskId,
        type: 'forget_memory_ambiguous',
        message: `找到 ${matches.length} 条相关记忆，需要你说得更具体一点。`,
      };
    }
    const [memory] = matches;
    this.memoryStore.delete(memory.id);
    this.syncMemory();
    this.updateContext({
      backgroundTaskId,
      turnId,
      type: 'forget_memory',
      status: 'deleted',
      result: { memoryId: memory.id },
    });
    emitEvent('memory.deleted', { backgroundTaskId, turnId, memoryId: memory.id });
    emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'forget_memory', memoryId: memory.id } });
    return {
      backgroundTaskId,
      type: 'memory_deleted',
      memory,
      message: `我忘记了：${memory.content}`,
    };
  }

  update(text, { backgroundTaskId = createBackgroundTaskId(), pendingBackgroundTaskId, turnId } = {}) {
    emitEvent('background_task.started', { backgroundTaskId, turnId, model: 'background_memory_module', taskType: 'update_memory' });
    let { query, content } = extractUpdateMemoryPatch(text);
    if (pendingBackgroundTaskId && (!query || !content)) {
      const pendingPatch = text.trim().match(/^(.+?)(?:改成|改为|更新为|改到)[：:，,\s]*(.+)$/);
      if (pendingPatch) {
        query = pendingPatch[1].replace(/这条|记忆/g, '').trim();
        content = pendingPatch[2].trim();
      }
    }
    if (!query || !content) {
      this.updateContext({ backgroundTaskId, turnId, type: 'update_memory', status: 'needs_clarification', result: { query } });
      emitNeedsClarification({
        backgroundTaskId,
        turnId,
        question: '你想修改哪条记忆？也请说一下新的内容。',
        reason: 'missing_update_memory_patch',
      });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'update_memory_needs_clarification' } });
      return {
        backgroundTaskId,
        type: 'update_memory_needs_clarification',
        message: '你想修改哪条记忆？也请说一下新的内容。',
      };
    }

    const matches = this.memoryStore.list().filter((memory) => memory.content.includes(query) || query.includes(memory.content));
    if (matches.length === 0) {
      this.updateContext({ backgroundTaskId, turnId, type: 'update_memory', status: 'not_found', result: { query } });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'update_memory_not_found', query } });
      return {
        backgroundTaskId,
        type: 'update_memory_not_found',
        message: `我没有找到这条长期记忆：${query}`,
      };
    }
    if (matches.length > 1) {
      this.updateContext({ backgroundTaskId, turnId, type: 'update_memory', status: 'ambiguous', result: { query, count: matches.length } });
      emitNeedsClarification({
        backgroundTaskId,
        turnId,
        question: '找到多条相关记忆，需要你说得更具体一点。',
        reason: 'ambiguous_update_memory_query',
        candidates: matches.slice(0, 5).map((memory) => ({
          id: memory.id,
          content: memory.content,
        })),
      });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'update_memory_ambiguous', query, count: matches.length } });
      return {
        backgroundTaskId,
        type: 'update_memory_ambiguous',
        message: `找到 ${matches.length} 条相关记忆，需要你说得更具体一点。`,
      };
    }

    try {
      const [memory] = matches;
      const updated = this.memoryStore.update(memory.id, content);
      this.syncMemory();
      this.updateContext({
        backgroundTaskId,
        turnId,
        type: 'update_memory',
        status: 'updated',
        result: updated,
      });
      emitEvent('memory.updated', { backgroundTaskId, turnId, memory: updated });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'update_memory', memoryId: updated.id } });
      return {
        backgroundTaskId,
        type: 'memory_updated',
        memory: updated,
        message: `我更新了记忆：${updated.content}`,
      };
    } catch (error) {
      this.updateContext({
        backgroundTaskId,
        turnId,
        type: 'update_memory',
        status: 'failed',
        result: { error: error.message },
      });
      emitEvent('memory.failed', { backgroundTaskId, turnId, message: error.message });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'update_memory_failed', error: error.message } });
      return {
        backgroundTaskId,
        type: 'memory_update_failed',
        message: '这条内容我不能安全地写入长期记忆。',
      };
    }
  }
}
