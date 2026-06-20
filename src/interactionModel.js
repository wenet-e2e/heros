import { emitEvent } from './events.js';
import { likelyReminder } from './intents.js';

export class CliInteractionModel {
  constructor({ client, model, backgroundAgent, context }) {
    this.client = client;
    this.model = model;
    this.backgroundAgent = backgroundAgent;
    this.context = context;
  }

  async respond(userText) {
    emitEvent('input_audio.completed', { mode: 'cli_text' });
    this.context.addTurn('user', userText);
    emitEvent('interaction.context_updated', { contextVersion: this.context.version });

    if (likelyReminder(userText)) {
      emitEvent('background_task.requested', { reason: 'likely_reminder' });
      const result = await this.backgroundAgent.handleTask({
        userText,
        context: this.context.snapshot(),
      });
      if (result.message) {
        this.context.addTurn('assistant', result.message);
        emitEvent('response.completed', { source: 'background_agent' });
        return result.message;
      }
    }

    const system = [
      'You are HerOS typed CLI fallback while the realtime voice loop is being validated.',
      'You are inspired by the movie HER: warm, emotionally intelligent, concise, and useful.',
      'Stay present in a natural spoken conversation.',
      'For complex tasks, the runtime delegates to a background agent; for this response, answer directly and briefly.',
      'Use Chinese unless the user clearly uses another language.',
    ].join('\n');

    const content = await this.client.text({
      model: this.model,
      temperature: 0.7,
      messages: [
        { role: 'system', content: system },
        ...this.context.snapshot().turns.map((turn) => ({ role: turn.role, content: turn.content })),
      ],
    });

    this.context.addTurn('assistant', content);
    emitEvent('response.completed', { source: 'cli_fallback', model: this.model });
    return content;
  }
}
