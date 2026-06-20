import { emitEvent } from './events.js';

export class CliInteractionModel {
  constructor({ agentBootstrap = {}, client, model, taskRouter, context }) {
    this.agentBootstrap = agentBootstrap;
    this.client = client;
    this.model = model;
    this.taskRouter = taskRouter;
    this.context = context;
  }

  async respond(userText) {
    emitEvent('input_audio.completed', { mode: 'cli_text' });
    const userTurn = this.context.addTurn('user', userText);
    emitEvent('interaction.context_updated', { contextVersion: this.context.version, turnId: userTurn.id });
    emitEvent('transcript.completed', {
      mode: 'cli_text',
      text: userText,
      contextVersion: this.context.version,
      turnId: userTurn.id,
    });

    const result = await this.taskRouter.maybeHandle(userText, { turnId: userTurn.id });
    if (result) {
      if (result.message) {
        const assistantTurn = this.context.addTurn('assistant', result.message);
        emitEvent('response.completed', {
          backgroundTaskId: result.backgroundTaskId,
          source: result.source || 'background_agent',
          sourceTurnId: userTurn.id,
          text: result.message,
          turnId: assistantTurn.id,
        });
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
    const bootstrap = [
      this.agentBootstrap['AGENTS.md'],
      this.agentBootstrap['SOUL.md'],
      this.agentBootstrap['MEMORY.md'],
    ].filter(Boolean).join('\n\n');

    const contextSnapshot = this.context.snapshot();
    const sharedContext = {
      contextVersion: contextSnapshot.contextVersion,
      longTermMemory: contextSnapshot.longTermMemory,
      backgroundTasks: contextSnapshot.backgroundTasks.slice(-5),
    };

    const content = await this.client.text({
      model: this.model,
      temperature: 0.7,
      messages: [
        { role: 'system', content: system },
        { role: 'system', content: `Agent Bootstrap:\n${bootstrap}` },
        { role: 'system', content: `Shared Context JSON:\n${JSON.stringify(sharedContext, null, 2)}` },
        ...contextSnapshot.turns.map((turn) => ({ role: turn.role, content: turn.content })),
      ],
    });

    const assistantTurn = this.context.addTurn('assistant', content);
    emitEvent('response.completed', {
      source: 'cli_fallback',
      model: this.model,
      sourceTurnId: userTurn.id,
      text: content,
      turnId: assistantTurn.id,
    });
    return content;
  }
}
