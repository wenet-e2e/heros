import { emitEvent } from './events.js';

function extractJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return JSON.parse(trimmed);
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Model did not return JSON: ${text}`);
  }
  return JSON.parse(match[0]);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason || 'cancelled';
  if (reason instanceof Error) {
    throw reason;
  }
  const error = new Error(`Background task cancelled: ${reason}`);
  error.name = 'BackgroundTaskCancelledError';
  error.reason = reason;
  throw error;
}

function formatLocalTime(isoString, timeZone) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function getScheduledReminders(context, reminderStore) {
  const contextReminders = context?.reminders?.scheduled;
  const reminders = Array.isArray(contextReminders)
    ? contextReminders
    : reminderStore.list().filter((reminder) => reminder.status === 'scheduled');
  return reminders.filter((reminder) => reminder.status === 'scheduled');
}

export class BackgroundAgent {
  constructor({ agentBootstrap = {}, client, model, reminderStore, timeZone }) {
    this.agentBootstrap = agentBootstrap;
    this.client = client;
    this.model = model;
    this.reminderStore = reminderStore;
    this.timeZone = timeZone;
  }

  async handleTask({ userText, context, backgroundTaskId, turnId, signal }) {
    emitEvent('background_task.started', { backgroundTaskId, turnId, model: this.model });
    emitEvent('agent.started', { backgroundTaskId, turnId, model: this.model });

    const now = new Date();
    const localNow = new Intl.DateTimeFormat('zh-CN', {
      timeZone: this.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(now);
    const system = [
      'You are HerOS Background LLM/Agent.',
      'Your job is to handle complex tasks asynchronously for a realtime interaction model.',
      'You receive a rich context package with sharedContext, reminders, longTermMemory, and runtime metadata.',
      'For this MVP, executable tools are create_reminder and update_reminder.',
      'Decide whether the user asks to create or update a reminder.',
      'Return strict JSON only, with this schema:',
      '{"action":"create_reminder"|"update_reminder"|"none"|"clarify","reminderId":"string","title":"string","remindAt":"ISO-8601 string or empty","note":"string","clarifyingQuestion":"string"}',
      `Current local time is ${localNow}, time zone ${this.timeZone}.`,
      'Resolve relative dates such as 今天, 明天, 后天, 上午, 下午 in this local time zone.',
      'Return remindAt as ISO-8601 with an explicit local timezone offset, for example 2026-06-22T09:00:00+08:00. Do not return UTC Z unless the user explicitly asks for UTC.',
      'If context.pendingClarification is present, treat userText as the answer to that pending clarification and combine it with the previous task and turns in sharedContext.',
      'For update_reminder, choose a single scheduled reminder from context.reminders.scheduled and return its reminderId. If no single target is clear, use action "clarify".',
      'For update_reminder, include only the fields that should change. If the user changes time, return remindAt. If the user changes title or note, return title or note.',
      'If time is missing or ambiguous, use action "clarify".',
      'If the request is not a reminder task, use action "none".',
    ].join('\n');
    const bootstrap = [
      this.agentBootstrap['AGENTS.md'],
      this.agentBootstrap['SOUL.md'],
      this.agentBootstrap['MEMORY.md'],
    ].filter(Boolean).join('\n\n');

    const content = await this.client.text({
      model: this.model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: system },
        { role: 'system', content: `Agent Bootstrap:\n${bootstrap}` },
        { role: 'user', content: JSON.stringify({ userText, context }, null, 2) },
      ],
      responseFormat: { type: 'json_object' },
      signal,
    });

    throwIfAborted(signal);
    const decision = extractJson(content);
    throwIfAborted(signal);
    emitEvent('agent.completed', { backgroundTaskId, turnId, model: this.model, action: decision.action });
    emitEvent('background_task.progress', {
      backgroundTaskId,
      turnId,
      stage: 'agent_decision',
      action: decision.action,
    });

    if (decision.action === 'create_reminder') {
      let reminder;
      try {
        const remindAtMs = Date.parse(decision.remindAt);
        if (Number.isFinite(remindAtMs) && remindAtMs <= Date.now()) {
          throw new Error(`Reminder time is in the past: ${decision.remindAt}`);
        }
        reminder = this.reminderStore.create({
          title: decision.title || userText,
          remindAt: decision.remindAt,
          note: decision.note || '',
        });
      } catch (error) {
        emitEvent('tool_call.failed', { backgroundTaskId, turnId, toolName: 'create_reminder', message: error.message });
        emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'failed', error: error.message } });
        return {
          backgroundTaskId,
          type: 'reminder_failed',
          message: error.message.includes('past')
            ? '这个提醒时间已经过去了，可以换一个未来的时间。'
            : '提醒时间解析失败了，可以换一种更具体的说法再试一次。',
        };
      }
      emitEvent('tool_call.completed', { backgroundTaskId, turnId, toolName: 'create_reminder', result: reminder });
      emitEvent('reminder.created', { backgroundTaskId, turnId, reminder });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: reminder });
      return {
        backgroundTaskId,
        type: 'reminder_created',
        reminder,
        message: `已创建提醒：${reminder.title}，时间：${formatLocalTime(reminder.remindAt, this.timeZone)}`,
      };
    }

    if (decision.action === 'update_reminder') {
      const scheduled = getScheduledReminders(context, this.reminderStore);
      const existing = this.reminderStore.list().find((reminder) => (
        reminder.id === decision.reminderId && reminder.status === 'scheduled'
      ));
      if (!existing) {
        emitEvent('background_task.needs_clarification', {
          backgroundTaskId,
          turnId,
          question: decision.clarifyingQuestion || '你想修改哪一个提醒？可以说一下提醒内容。',
          reason: 'missing_update_reminder_target',
          candidates: scheduled.slice(0, 5).map((reminder) => ({
            id: reminder.id,
            title: reminder.title,
            remindAt: reminder.remindAt,
          })),
        });
        emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'update_reminder_needs_clarification' } });
        return {
          backgroundTaskId,
          type: 'clarify',
          message: decision.clarifyingQuestion || '你想修改哪一个提醒？可以说一下提醒内容。',
        };
      }

      const patch = {};
      if (typeof decision.title === 'string' && decision.title.trim()) {
        patch.title = decision.title.trim();
      }
      if (typeof decision.note === 'string' && decision.note.trim()) {
        patch.note = decision.note.trim();
      }
      if (typeof decision.remindAt === 'string' && decision.remindAt.trim()) {
        const remindAtMs = Date.parse(decision.remindAt);
        if (!Number.isFinite(remindAtMs)) {
          emitEvent('tool_call.failed', { backgroundTaskId, turnId, toolName: 'update_reminder', message: `Invalid reminder time: ${decision.remindAt}` });
          emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'failed', error: `Invalid reminder time: ${decision.remindAt}` } });
          return {
            backgroundTaskId,
            type: 'reminder_failed',
            message: '提醒时间解析失败了，可以换一种更具体的说法再试一次。',
          };
        }
        if (remindAtMs <= Date.now()) {
          emitEvent('tool_call.failed', { backgroundTaskId, turnId, toolName: 'update_reminder', message: `Reminder time is in the past: ${decision.remindAt}` });
          emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'failed', error: `Reminder time is in the past: ${decision.remindAt}` } });
          return {
            backgroundTaskId,
            type: 'reminder_failed',
            message: '这个提醒时间已经过去了，可以换一个未来的时间。',
          };
        }
        patch.remindAt = decision.remindAt;
      }
      if (Object.keys(patch).length === 0) {
        emitEvent('background_task.needs_clarification', {
          backgroundTaskId,
          turnId,
          question: decision.clarifyingQuestion || '你想把这个提醒改成什么？',
          reason: 'missing_update_reminder_patch',
        });
        emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'update_reminder_needs_clarification' } });
        return {
          backgroundTaskId,
          type: 'clarify',
          message: decision.clarifyingQuestion || '你想把这个提醒改成什么？',
        };
      }

      const reminder = this.reminderStore.update(existing.id, patch);
      emitEvent('tool_call.completed', { backgroundTaskId, turnId, toolName: 'update_reminder', result: reminder });
      emitEvent('reminder.updated', { backgroundTaskId, turnId, reminder, patch });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'update_reminder', reminderId: reminder.id } });
      return {
        backgroundTaskId,
        type: 'reminder_updated',
        reminder,
        message: `已更新提醒：${reminder.title}，时间：${formatLocalTime(reminder.remindAt, this.timeZone)}`,
      };
    }

    if (decision.action === 'clarify') {
      emitEvent('background_task.needs_clarification', { backgroundTaskId, turnId, question: decision.clarifyingQuestion });
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'clarify' } });
      return {
        backgroundTaskId,
        type: 'clarify',
        message: decision.clarifyingQuestion || '这个提醒的时间还不够明确，可以再说一下具体时间吗？',
      };
    }

    emitEvent('background_task.completed', { backgroundTaskId, turnId, result: { action: 'none' } });
    return {
      backgroundTaskId,
      type: 'none',
      message: '',
    };
  }
}
