import crypto from 'node:crypto';
import { emitEvent, redactSecrets } from './events.js';
import {
  extractCancelReminderQuery,
  extractForgetMemoryQuery,
  extractMemoryContent,
  extractUpdateMemoryPatch,
  likelyCancelReminder,
  likelyForgetMemory,
  likelyListMemory,
  likelyListReminders,
  likelyNextReminder,
  likelyUpdateMemory,
  likelyUpdateReminder,
  likelyMemory,
  likelyReminder,
} from './intents.js';

function createBackgroundTaskId() {
  return `task_${crypto.randomUUID()}`;
}

class BackgroundTaskTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Background task timed out after ${timeoutMs}ms`);
    this.name = 'BackgroundTaskTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

class BackgroundTaskCancelledError extends Error {
  constructor(reason = 'cancelled') {
    super(`Background task cancelled: ${reason}`);
    this.name = 'BackgroundTaskCancelledError';
    this.reason = reason;
  }
}

function cancellationErrorFromSignal(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new BackgroundTaskCancelledError(reason || 'cancelled');
}

async function withTimeout(promiseFactory, timeoutMs, externalSignal) {
  const controller = new AbortController();
  let timeout;
  let removeExternalAbort = () => {};
  try {
    if (externalSignal?.aborted) {
      throw cancellationErrorFromSignal(externalSignal);
    }
    let cancellation = new Promise(() => {});
    if (externalSignal) {
      cancellation = new Promise((_, reject) => {
        const onAbort = () => {
          const error = cancellationErrorFromSignal(externalSignal);
          controller.abort(error);
          reject(error);
        };
        externalSignal.addEventListener('abort', onAbort, { once: true });
        removeExternalAbort = () => externalSignal.removeEventListener('abort', onAbort);
      });
    }
    return await Promise.race([
      promiseFactory({ signal: controller.signal }),
      cancellation,
      new Promise((_, reject) => {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          return;
        }
        timeout = setTimeout(() => {
          const error = new BackgroundTaskTimeoutError(timeoutMs);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    removeExternalAbort();
  }
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

function backgroundTaskStatus(result) {
  if (result.type === 'clarify') {
    return 'needs_clarification';
  }
  return result.type;
}

function scheduledReminders(reminderStore) {
  return reminderStore.list()
    .filter((reminder) => reminder.status === 'scheduled')
    .sort((a, b) => Date.parse(a.remindAt) - Date.parse(b.remindAt));
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

const PENDING_CLARIFICATION_TASK_TYPES = new Set([
  'cancel_reminder',
  'forget_memory',
  'reminder',
  'update_memory',
  'update_reminder',
]);

function latestPendingClarification(context) {
  const task = context?.snapshot?.().backgroundTasks?.at(-1) || null;
  if (!task || task.status !== 'needs_clarification') {
    return null;
  }
  if (!PENDING_CLARIFICATION_TASK_TYPES.has(task.type)) {
    return null;
  }
  return {
    backgroundTaskId: task.backgroundTaskId,
    turnId: task.turnId,
    type: task.type,
    result: task.result || null,
  };
}

export class TaskRouter {
  constructor({ backgroundAgent, context, memoryStore, reminderStore, taskTimeoutMs = 60000, timeZone }) {
    this.backgroundAgent = backgroundAgent;
    this.context = context;
    this.memoryStore = memoryStore;
    this.reminderStore = reminderStore;
    this.taskTimeoutMs = taskTimeoutMs;
    this.timeZone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  shouldDelegate(text) {
    if (likelyCancelReminder(text)) {
      return { type: 'cancel_reminder', reason: 'explicit_cancel_reminder_request' };
    }
    if (likelyNextReminder(text)) {
      return { type: 'list_reminders', reason: 'explicit_next_reminder_request', nextOnly: true };
    }
    if (likelyUpdateReminder(text)) {
      return { type: 'update_reminder', reason: 'explicit_update_reminder_request' };
    }
    if (likelyListReminders(text)) {
      return { type: 'list_reminders', reason: 'explicit_list_reminders_request' };
    }
    if (likelyUpdateMemory(text)) {
      return { type: 'update_memory', reason: 'explicit_update_memory_request' };
    }
    if (likelyListMemory(text)) {
      return { type: 'list_memory', reason: 'explicit_list_memory_request' };
    }
    if (likelyMemory(text)) {
      return { type: 'memory', reason: 'explicit_memory_request' };
    }
    if (likelyForgetMemory(text)) {
      return { type: 'forget_memory', reason: 'explicit_forget_memory_request' };
    }
    const pendingClarification = latestPendingClarification(this.context);
    if (pendingClarification && text.trim()) {
      return {
        type: pendingClarification.type,
        reason: 'pending_clarification_response',
        pendingBackgroundTaskId: pendingClarification.backgroundTaskId,
      };
    }
    if (likelyReminder(text)) {
      return { type: 'reminder', reason: 'likely_reminder' };
    }
    return null;
  }

  buildContextPackage() {
    const sharedContext = this.context.snapshot();
    const pendingClarification = latestPendingClarification(this.context);
    const reminders = this.reminderStore?.list?.() || [];
    const scheduledReminders = reminders
      .filter((reminder) => reminder.status === 'scheduled')
      .sort((a, b) => Date.parse(a.remindAt) - Date.parse(b.remindAt))
      .map((reminder) => ({
        id: reminder.id,
        title: reminder.title,
        remindAt: reminder.remindAt,
        note: reminder.note || '',
        status: reminder.status,
      }));
    const longTermMemory = this.memoryStore?.list?.()
      .map((memory) => ({
        id: memory.id,
        content: memory.content,
        updatedAt: memory.updatedAt,
      }))
      || sharedContext.longTermMemory;
    return redactSecrets({
      runtime: {
        timeZone: this.timeZone,
      },
      sharedContext,
      pendingClarification,
      reminders: {
        totalScheduled: scheduledReminders.length,
        nextScheduledAt: scheduledReminders[0]?.remindAt || null,
        scheduled: scheduledReminders.slice(0, 10),
      },
      longTermMemory: {
        total: longTermMemory.length,
        items: longTermMemory.slice(0, 20),
      },
    });
  }

  async maybeHandle(text, { turnId, signal } = {}) {
    const decision = this.shouldDelegate(text);
    if (!decision) {
      return null;
    }
    const backgroundTaskId = createBackgroundTaskId();

    emitEvent('background_task.requested', {
      backgroundTaskId,
      turnId,
      taskType: decision.type,
      reason: decision.reason,
    });
    if (decision.type === 'memory') {
      return { ...this.handleMemory(text, { backgroundTaskId, turnId }), source: 'local_task_router' };
    }
    if (decision.type === 'forget_memory') {
      return { ...this.handleForgetMemory(text, {
        backgroundTaskId,
        pendingBackgroundTaskId: decision.pendingBackgroundTaskId,
        turnId,
      }), source: 'local_task_router' };
    }
    if (decision.type === 'update_memory') {
      return { ...this.handleUpdateMemory(text, {
        backgroundTaskId,
        pendingBackgroundTaskId: decision.pendingBackgroundTaskId,
        turnId,
      }), source: 'local_task_router' };
    }
    if (decision.type === 'cancel_reminder') {
      return { ...this.handleCancelReminder(text, {
        backgroundTaskId,
        pendingBackgroundTaskId: decision.pendingBackgroundTaskId,
        turnId,
      }), source: 'local_task_router' };
    }
    if (decision.type === 'list_reminders') {
      return { ...this.handleListReminders({ backgroundTaskId, nextOnly: decision.nextOnly, turnId }), source: 'local_task_router' };
    }
    if (decision.type === 'list_memory') {
      return { ...this.handleListMemory({ backgroundTaskId, turnId }), source: 'local_task_router' };
    }
    let result;
    try {
      result = await withTimeout(({ signal: taskSignal }) => this.backgroundAgent.handleTask({
        backgroundTaskId,
        turnId,
        userText: text,
        context: this.buildContextPackage(),
        signal: taskSignal,
      }), this.taskTimeoutMs, signal);
    } catch (error) {
      if (error instanceof BackgroundTaskTimeoutError || error.name === 'BackgroundTaskTimeoutError') {
        result = {
          backgroundTaskId,
          turnId,
          type: 'background_timeout',
          message: '后台任务执行超时了，我先停下这次任务，可以稍后重试。',
          error: error.message,
        };
        emitEvent('background_task.cancelled', {
          backgroundTaskId,
          turnId,
          reason: 'timeout',
          timeoutMs: this.taskTimeoutMs,
        });
      } else if (error instanceof BackgroundTaskCancelledError || error.name === 'BackgroundTaskCancelledError') {
        result = {
          backgroundTaskId,
          turnId,
          type: 'background_cancelled',
          message: '',
          error: error.message,
        };
        emitEvent('background_task.cancelled', {
          backgroundTaskId,
          turnId,
          reason: error.reason || 'cancelled',
        });
      } else {
        result = {
          backgroundTaskId,
          turnId,
          type: 'background_failed',
          message: '后台任务执行失败了，可以稍后再试一次。',
          error: error.message,
        };
        emitEvent('background_task.failed', {
          backgroundTaskId,
          turnId,
          message: error.message,
        });
      }
      emitEvent('background_task.completed', {
        backgroundTaskId,
        turnId,
        result: {
          action: result.type === 'background_timeout'
            ? 'timeout'
            : result.type === 'background_cancelled'
              ? 'cancelled'
              : 'failed',
          error: error.message,
        },
      });
    }
    this.context.addBackgroundTask({
      backgroundTaskId,
      turnId,
      type: decision.type,
      status: backgroundTaskStatus(result),
      result,
    });
    emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });
    return { backgroundTaskId, ...result, source: 'background_agent' };
  }

  handleListReminders({ backgroundTaskId = createBackgroundTaskId(), nextOnly = false, turnId } = {}) {
    emitEvent('background_task.started', { backgroundTaskId, turnId, model: 'local_task_router', taskType: 'list_reminders' });
    const scheduled = scheduledReminders(this.reminderStore);
    this.context.addBackgroundTask({
      backgroundTaskId,
      turnId,
      type: 'list_reminders',
      status: 'completed',
      result: { count: scheduled.length, nextOnly },
    });
    emitEvent('background_task.completed', {
      backgroundTaskId,
      turnId,
      result: { action: 'list_reminders', count: scheduled.length, nextOnly },
    });
    emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });

    if (scheduled.length === 0) {
      return {
        backgroundTaskId,
        type: 'reminders_listed',
        reminders: scheduled,
        message: '现在没有待触发的提醒。',
      };
    }
    if (nextOnly) {
      const next = scheduled[0];
      return {
        backgroundTaskId,
        type: 'next_reminder_listed',
        reminders: [next],
        message: `下一个提醒是：${next.title}，${formatReminderTime(next.remindAt, this.timeZone)}`,
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

  handleListMemory({ backgroundTaskId = createBackgroundTaskId(), turnId } = {}) {
    emitEvent('background_task.started', { backgroundTaskId, turnId, model: 'local_task_router', taskType: 'list_memory' });
    const memories = this.memoryStore.list();
    this.context.addBackgroundTask({
      backgroundTaskId,
      turnId,
      type: 'list_memory',
      status: 'completed',
      result: { count: memories.length },
    });
    this.context.setLongTermMemory(memories);
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

  handleCancelReminder(text, { backgroundTaskId = createBackgroundTaskId(), pendingBackgroundTaskId, turnId } = {}) {
    emitEvent('background_task.started', { backgroundTaskId, turnId, model: 'local_task_router', taskType: 'cancel_reminder' });
    const query = extractCancelReminderQuery(text) || (pendingBackgroundTaskId ? text.trim() : '');
    if (!query) {
      this.context.addBackgroundTask({
        backgroundTaskId,
        turnId,
        type: 'cancel_reminder',
        status: 'needs_clarification',
        result: { query },
      });
      emitNeedsClarification({
        backgroundTaskId,
        turnId,
        question: '你想取消哪一个提醒？可以说一下提醒内容。',
        reason: 'missing_cancel_reminder_query',
      });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'cancel_reminder_needs_clarification' } });
      emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'cancel_reminder_needs_clarification',
        message: '你想取消哪一个提醒？可以说一下提醒内容。',
      };
    }
    const scheduled = scheduledReminders(this.reminderStore);
    const matches = /^(下一个|最近|最近的|下条)$/.test(query)
      ? scheduled.slice(0, 1)
      : scheduled.filter((reminder) => {
        if (reminder.status !== 'scheduled') {
          return false;
        }
        return reminder.title.includes(query) || reminder.note?.includes(query);
      });
    if (matches.length === 0) {
      this.context.addBackgroundTask({
        backgroundTaskId,
        turnId,
        type: 'cancel_reminder',
        status: 'not_found',
        result: { query },
      });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'cancel_reminder_not_found', query } });
      emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'cancel_reminder_not_found',
        message: `没有找到可取消的提醒：${query}`,
      };
    }
    if (matches.length > 1) {
      this.context.addBackgroundTask({
        backgroundTaskId,
        turnId,
        type: 'cancel_reminder',
        status: 'ambiguous',
        result: { query, count: matches.length },
      });
      emitNeedsClarification({
        backgroundTaskId,
        turnId,
        question: '找到多个相关提醒，需要你说得更具体一点。',
        reason: 'ambiguous_cancel_reminder_query',
        candidates: matches.slice(0, 5).map((reminder) => ({
          id: reminder.id,
          title: reminder.title,
          remindAt: reminder.remindAt,
        })),
      });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'cancel_reminder_ambiguous', query, count: matches.length } });
      emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'cancel_reminder_ambiguous',
        message: `找到 ${matches.length} 个相关提醒，需要你说得更具体一点。`,
      };
    }
    const reminder = this.reminderStore.cancel(matches[0].id);
    this.context.addBackgroundTask({
      backgroundTaskId,
      turnId,
      type: 'cancel_reminder',
      status: 'cancelled',
      result: reminder,
    });
    emitEvent('reminder.cancelled', { backgroundTaskId, turnId, reminder });
    emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'cancel_reminder', reminderId: reminder.id } });
    emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });
    return {
      backgroundTaskId,
      type: 'reminder_cancelled',
      reminder,
      message: `已取消提醒：${reminder.title}`,
    };
  }

  handleMemory(text, { backgroundTaskId = createBackgroundTaskId(), turnId } = {}) {
    emitEvent('background_task.started', { backgroundTaskId, turnId, model: 'local_task_router', taskType: 'memory' });
    const content = extractMemoryContent(text);
    try {
      const memory = this.memoryStore.create(content);
      const memories = this.memoryStore.list();
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
      this.context.addBackgroundTask({
        backgroundTaskId,
        turnId,
        type: 'memory',
        status: 'failed',
        result: { error: error.message },
      });
      emitEvent('memory.failed', { backgroundTaskId, turnId, message: error.message });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'memory_failed', error: error.message } });
      emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'memory_failed',
        message: '这条内容我不能安全地写入长期记忆。',
      };
    }
  }

  handleForgetMemory(text, { backgroundTaskId = createBackgroundTaskId(), pendingBackgroundTaskId, turnId } = {}) {
    emitEvent('background_task.started', { backgroundTaskId, turnId, model: 'local_task_router', taskType: 'forget_memory' });
    const query = extractForgetMemoryQuery(text) || (pendingBackgroundTaskId ? text.trim() : '');
    if (!query) {
      this.context.addBackgroundTask({
        backgroundTaskId,
        turnId,
        type: 'forget_memory',
        status: 'needs_clarification',
        result: { query },
      });
      emitNeedsClarification({
        backgroundTaskId,
        turnId,
        question: '你想忘记哪条长期记忆？',
        reason: 'missing_forget_memory_query',
      });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'forget_memory_needs_clarification' } });
      emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'forget_memory_needs_clarification',
        message: '你想忘记哪条长期记忆？',
      };
    }
    const matches = this.memoryStore.list().filter((memory) => memory.content.includes(query));
    if (matches.length === 0) {
      this.context.addBackgroundTask({
        backgroundTaskId,
        turnId,
        type: 'forget_memory',
        status: 'not_found',
        result: { query },
      });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'forget_memory_not_found', query } });
      emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'forget_memory_not_found',
        message: `我没有找到这条长期记忆：${query}`,
      };
    }
    if (matches.length > 1) {
      this.context.addBackgroundTask({
        backgroundTaskId,
        turnId,
        type: 'forget_memory',
        status: 'ambiguous',
        result: { query, count: matches.length },
      });
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
      emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'forget_memory_ambiguous',
        message: `找到 ${matches.length} 条相关记忆，需要你说得更具体一点。`,
      };
    }
    const [memory] = matches;
    this.memoryStore.delete(memory.id);
    const memories = this.memoryStore.list();
    this.context.addBackgroundTask({
      backgroundTaskId,
      turnId,
      type: 'forget_memory',
      status: 'deleted',
      result: { memoryId: memory.id },
    });
    this.context.setLongTermMemory(memories);
    emitEvent('memory.deleted', { backgroundTaskId, turnId, memoryId: memory.id });
    emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'forget_memory', memoryId: memory.id } });
    emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });
    return {
      backgroundTaskId,
      type: 'memory_deleted',
      memory,
      message: `我忘记了：${memory.content}`,
    };
  }

  handleUpdateMemory(text, { backgroundTaskId = createBackgroundTaskId(), pendingBackgroundTaskId, turnId } = {}) {
    emitEvent('background_task.started', { backgroundTaskId, turnId, model: 'local_task_router', taskType: 'update_memory' });
    let { query, content } = extractUpdateMemoryPatch(text);
    if (pendingBackgroundTaskId && (!query || !content)) {
      const pendingPatch = text.trim().match(/^(.+?)(?:改成|改为|更新为|改到)[：:，,\s]*(.+)$/);
      if (pendingPatch) {
        query = pendingPatch[1].replace(/这条|记忆/g, '').trim();
        content = pendingPatch[2].trim();
      }
    }
    if (!query || !content) {
      this.context.addBackgroundTask({
        backgroundTaskId,
        turnId,
        type: 'update_memory',
        status: 'needs_clarification',
        result: { query },
      });
      emitNeedsClarification({
        backgroundTaskId,
        turnId,
        question: '你想修改哪条记忆？也请说一下新的内容。',
        reason: 'missing_update_memory_patch',
      });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'update_memory_needs_clarification' } });
      emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'update_memory_needs_clarification',
        message: '你想修改哪条记忆？也请说一下新的内容。',
      };
    }

    const matches = this.memoryStore.list().filter((memory) => memory.content.includes(query) || query.includes(memory.content));
    if (matches.length === 0) {
      this.context.addBackgroundTask({
        backgroundTaskId,
        turnId,
        type: 'update_memory',
        status: 'not_found',
        result: { query },
      });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'update_memory_not_found', query } });
      emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'update_memory_not_found',
        message: `我没有找到这条长期记忆：${query}`,
      };
    }
    if (matches.length > 1) {
      this.context.addBackgroundTask({
        backgroundTaskId,
        turnId,
        type: 'update_memory',
        status: 'ambiguous',
        result: { query, count: matches.length },
      });
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
      emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'update_memory_ambiguous',
        message: `找到 ${matches.length} 条相关记忆，需要你说得更具体一点。`,
      };
    }

    try {
      const [memory] = matches;
      const updated = this.memoryStore.update(memory.id, content);
      const memories = this.memoryStore.list();
      this.context.addBackgroundTask({
        backgroundTaskId,
        turnId,
        type: 'update_memory',
        status: 'updated',
        result: updated,
      });
      this.context.setLongTermMemory(memories);
      emitEvent('memory.updated', { backgroundTaskId, turnId, memory: updated });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'update_memory', memoryId: updated.id } });
      emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'memory_updated',
        memory: updated,
        message: `我更新了记忆：${updated.content}`,
      };
    } catch (error) {
      this.context.addBackgroundTask({
        backgroundTaskId,
        turnId,
        type: 'update_memory',
        status: 'failed',
        result: { error: error.message },
      });
      emitEvent('memory.failed', { backgroundTaskId, turnId, message: error.message });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'update_memory_failed', error: error.message } });
      emitEvent('interaction.context_updated', { backgroundTaskId, turnId, contextVersion: this.context.version });
      return {
        backgroundTaskId,
        type: 'memory_update_failed',
        message: '这条内容我不能安全地写入长期记忆。',
      };
    }
  }
}
