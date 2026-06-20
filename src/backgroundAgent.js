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
      'For this MVP, the only executable tool is create_reminder.',
      'Decide whether the user asks to create a reminder.',
      'Return strict JSON only, with this schema:',
      '{"action":"create_reminder"|"none"|"clarify","title":"string","remindAt":"ISO-8601 string or empty","note":"string","clarifyingQuestion":"string"}',
      `Current local time is ${localNow}, time zone ${this.timeZone}.`,
      'Resolve relative dates such as 今天, 明天, 后天, 上午, 下午 in this local time zone.',
      'Return remindAt as ISO-8601 with an explicit local timezone offset, for example 2026-06-22T09:00:00+08:00. Do not return UTC Z unless the user explicitly asks for UTC.',
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

    const decision = extractJson(content);

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
      emitEvent('background_task.completed', { backgroundTaskId, turnId, result: reminder });
      return {
        backgroundTaskId,
        type: 'reminder_created',
        reminder,
        message: `已创建提醒：${reminder.title}，时间：${formatLocalTime(reminder.remindAt, this.timeZone)}`,
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
