import { emitEvent } from './events.js';
import { likelyReminder } from './intents.js';

export class TaskRouter {
  constructor({ backgroundAgent, context }) {
    this.backgroundAgent = backgroundAgent;
    this.context = context;
  }

  shouldDelegate(text) {
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
}
