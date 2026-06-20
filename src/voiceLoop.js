import process from 'node:process';
import { PcmPlayer, PcmRecorder } from './audio.js';
import { emitEvent } from './events.js';

export class VoiceLoop {
  constructor({ config, realtime, taskRouter, context, reminderScheduler, playAudio = true }) {
    this.config = config;
    this.realtime = realtime;
    this.taskRouter = taskRouter;
    this.context = context;
    this.reminderScheduler = reminderScheduler;
    this.playAudio = playAudio;
    this.player = new PcmPlayer({ sampleRate: 24000, enabled: playAudio });
    this.recorder = new PcmRecorder({ sampleRate: 16000 });
    this.isResponding = false;
    this.currentAssistantText = '';
    this.backgroundTasks = new Set();
  }

  async start() {
    this.attachRealtimeEvents();
    await this.realtime.connect();
    this.realtime.updateSession({
      modalities: ['text', 'audio'],
      voice: this.config.realtimeVoice,
      instructions: this.config.realtimeInstructions,
      turnDetection: {
        type: 'server_vad',
        threshold: Number(this.config.realtimeVadThreshold),
        prefix_padding_ms: Number(this.config.realtimeVadPrefixPaddingMs),
        silence_duration_ms: Number(this.config.realtimeVadSilenceDurationMs),
      },
      inputAudioTranscription: {
        model: this.config.realtimeInputTranscriptionModel,
      },
    });
    await this.realtime.waitFor('session.updated', 15000);

    await this.player.start();
    this.recorder.on('data', (chunk) => this.realtime.appendAudio(chunk));
    await this.recorder.start();

    emitEvent('voice_loop.started', {
      realtimeModel: this.config.realtimeModel,
      backgroundModel: this.config.backgroundModel,
      turnDetection: 'server_vad',
    });
    console.log('HerOS voice loop is running. Speak naturally; press Ctrl+C to exit.');

    await this.waitForShutdown();
  }

  attachRealtimeEvents() {
    this.realtime.on('event', (event) => {
      if (event.type === 'session.created' || event.type === 'session.updated') {
        emitEvent(event.type, { model: this.config.realtimeModel });
      } else if (event.type === 'input_audio_buffer.speech_started') {
        this.handleSpeechStarted();
      } else if (event.type === 'input_audio_buffer.speech_stopped') {
        emitEvent('input_audio.completed');
      } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
        this.handleUserTranscript(event.transcript || '');
      } else if (event.type === 'response.created') {
        this.isResponding = true;
        this.currentAssistantText = '';
        emitEvent('response.started', { source: 'realtime' });
      } else if (event.type === 'response.audio_transcript.delta' || event.type === 'response.text.delta') {
        this.handleAssistantDelta(event.delta || '');
      } else if (event.type === 'response.audio_transcript.done' || event.type === 'response.text.done') {
        this.handleAssistantDone(event.transcript || event.text || this.currentAssistantText);
      } else if (event.type === 'response.audio.delta') {
        this.player.write(Buffer.from(event.delta || '', 'base64'));
      } else if (event.type === 'response.done') {
        this.isResponding = false;
        emitEvent('response.completed', { source: 'realtime' });
      } else if (event.type === 'error') {
        emitEvent('error', { source: 'realtime', error: event.error || event });
      }
    });
  }

  async handleSpeechStarted() {
    emitEvent('input_audio.started');
    if (!this.isResponding) {
      return;
    }
    emitEvent('response.interrupted', { reason: 'user_speech_started' });
    try {
      this.realtime.cancelResponse();
    } catch (error) {
      emitEvent('error', { source: 'response.cancel', message: error.message });
    }
    await this.player.interrupt();
    this.isResponding = false;
  }

  handleUserTranscript(transcript) {
    if (!transcript.trim()) {
      return;
    }
    console.log(`\nYou: ${transcript}`);
    this.context.addTurn('user', transcript);
    emitEvent('transcript.completed', {
      text: transcript,
      contextVersion: this.context.version,
    });
    if (this.taskRouter.shouldDelegate(transcript)) {
      this.delegateTask(transcript);
    }
  }

  handleAssistantDelta(delta) {
    if (!delta) {
      return;
    }
    this.currentAssistantText += delta;
    process.stdout.write(delta);
  }

  handleAssistantDone(text) {
    const content = text || this.currentAssistantText;
    if (content.trim()) {
      this.context.addTurn('assistant', content);
      emitEvent('interaction.context_updated', { contextVersion: this.context.version });
    }
    process.stdout.write('\n');
  }

  delegateTask(transcript) {
    const task = this.taskRouter.maybeHandle(transcript).then((result) => {
      if (result.message) {
        console.log(`\nBackground: ${result.message}`);
      }
    }).catch((error) => {
      emitEvent('tool_call.failed', { toolName: 'create_reminder', message: error.message });
    }).finally(() => {
      this.backgroundTasks.delete(task);
    });
    this.backgroundTasks.add(task);
  }

  waitForShutdown() {
    return new Promise((resolve) => {
      const shutdown = async () => {
        process.off('SIGINT', shutdown);
        emitEvent('voice_loop.stopping');
        this.recorder.stop();
        this.player.stop();
        this.realtime.close();
        if (this.backgroundTasks.size > 0) {
          await Promise.allSettled([...this.backgroundTasks]);
        }
        emitEvent('voice_loop.stopped');
        resolve();
      };
      process.on('SIGINT', shutdown);
    });
  }
}
