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
    this.isAnnouncing = false;
    this.announcementQueue = [];
    this.currentAssistantText = '';
    this.backgroundTasks = new Set();
    this.unsubscribeReminderTrigger = null;
    this.state = 'idle';
    this.turnEpoch = 0;
  }

  setState(state, reason) {
    if (this.state === state) {
      return;
    }
    const previousState = this.state;
    this.state = state;
    emitEvent('state.changed', { previousState, state, reason });
  }

  async start({ durationMs } = {}) {
    this.attachRealtimeEvents();
    await this.realtime.connect();
    this.realtime.updateSession({
      modalities: ['text', 'audio'],
      voice: this.config.realtimeVoice,
      instructions: this.config.realtimeInstructions,
      turnDetection: {
        type: this.config.realtimeTurnDetection,
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
    this.recorder.on('data', (chunk) => {
      try {
        this.realtime.appendAudio(chunk);
      } catch (error) {
        emitEvent('error', { source: 'input_audio_buffer.append', message: error.message });
      }
    });
    await this.recorder.start();

    emitEvent('voice_loop.started', {
      realtimeModel: this.config.realtimeModel,
      backgroundModel: this.config.backgroundModel,
      turnDetection: this.config.realtimeTurnDetection,
    });
    this.setState('listening', 'voice_loop_started');
    console.log('HerOS voice loop is running. Speak naturally; press Ctrl+C to exit.');

    if (this.reminderScheduler) {
      this.unsubscribeReminderTrigger = this.reminderScheduler.onTriggered((reminder) => {
        this.enqueueAnnouncement(`提醒时间到了：${reminder.title}${reminder.note ? `。${reminder.note}` : ''}`, {
          source: 'reminder_due',
        });
      });
      this.reminderScheduler.start();
    }

    await this.waitForShutdown({ durationMs });
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
        this.setState('speaking', 'response_created');
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
        this.setState('listening', 'response_done');
        this.drainAnnouncements();
      } else if (event.type === 'error') {
        emitEvent('error', { source: 'realtime', error: event.error || event });
      }
    });
  }

  async handleSpeechStarted() {
    this.turnEpoch += 1;
    emitEvent('conversation.epoch_changed', { turnEpoch: this.turnEpoch, reason: 'user_speech_started' });
    emitEvent('input_audio.started');
    if (!this.isResponding) {
      this.setState('listening', 'user_speech_started');
      return;
    }
    this.setState('interrupted', 'user_speech_started');
    emitEvent('response.interrupted', { reason: 'user_speech_started' });
    try {
      this.realtime.cancelResponse();
    } catch (error) {
      emitEvent('error', { source: 'response.cancel', message: error.message });
    }
    await this.player.interrupt();
    this.isResponding = false;
    this.setState('listening', 'response_interrupted');
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
      turnEpoch: this.turnEpoch,
    });
    if (this.taskRouter.shouldDelegate(transcript)) {
      this.delegateTask(transcript, { turnEpoch: this.turnEpoch });
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

  delegateTask(transcript, { turnEpoch }) {
    const task = this.taskRouter.maybeHandle(transcript).then((result) => {
      if (result.message) {
        console.log(`\nBackground: ${result.message}`);
        this.enqueueAnnouncement(result.message, {
          backgroundTaskId: result.backgroundTaskId,
          source: 'background_task',
          turnEpoch,
        });
      }
    }).catch((error) => {
      emitEvent('tool_call.failed', { toolName: 'create_reminder', message: error.message });
    }).finally(() => {
      this.backgroundTasks.delete(task);
    });
    this.backgroundTasks.add(task);
  }

  enqueueAnnouncement(message, { backgroundTaskId, source = 'background_task', turnEpoch = this.turnEpoch } = {}) {
    if (turnEpoch < this.turnEpoch) {
      emitEvent('announcement.skipped', {
        backgroundTaskId,
        source,
        reason: 'stale_turn',
        turnEpoch,
        currentTurnEpoch: this.turnEpoch,
      });
      return;
    }
    this.announcementQueue.push({ message, backgroundTaskId, source, turnEpoch });
    emitEvent('announcement.queued', { backgroundTaskId, source, text: message, turnEpoch });
    this.drainAnnouncements();
  }

  async drainAnnouncements() {
    if (this.isResponding || this.isAnnouncing || this.announcementQueue.length === 0) {
      return;
    }
    const announcement = this.announcementQueue.shift();
    if (announcement.turnEpoch < this.turnEpoch) {
      emitEvent('announcement.skipped', {
        backgroundTaskId: announcement.backgroundTaskId,
        source: announcement.source,
        reason: 'stale_turn',
        turnEpoch: announcement.turnEpoch,
        currentTurnEpoch: this.turnEpoch,
      });
      this.drainAnnouncements();
      return;
    }
    this.isAnnouncing = true;
    emitEvent('announcement.started', {
      backgroundTaskId: announcement.backgroundTaskId,
      source: announcement.source,
      text: announcement.message,
      outlet: 'realtime',
      turnEpoch: announcement.turnEpoch,
    });
    try {
      this.realtime.createUserTextMessage([
        '后台任务结果如下。',
        announcement.message,
        '请用一句自然、简短、适合语音播报的话告诉用户。',
      ].join('\n'));
      this.realtime.createResponse();
      await this.realtime.waitFor('response.done', 120000);
      emitEvent('announcement.completed', {
        backgroundTaskId: announcement.backgroundTaskId,
        source: announcement.source,
        outlet: 'realtime',
        turnEpoch: announcement.turnEpoch,
      });
    } catch (error) {
      emitEvent('announcement.failed', {
        backgroundTaskId: announcement.backgroundTaskId,
        source: announcement.source,
        outlet: 'realtime',
        message: error.message,
        turnEpoch: announcement.turnEpoch,
      });
    } finally {
      this.isAnnouncing = false;
      this.drainAnnouncements();
    }
  }

  waitForShutdown({ durationMs } = {}) {
    return new Promise((resolve) => {
      let timer = null;
      const shutdown = async () => {
        process.off('SIGINT', shutdown);
        if (timer) {
          clearTimeout(timer);
        }
        this.setState('stopping', 'shutdown');
        emitEvent('voice_loop.stopping');
        this.recorder.stop();
        this.player.stop();
        this.realtime.close();
        this.unsubscribeReminderTrigger?.();
        this.unsubscribeReminderTrigger = null;
        this.reminderScheduler?.stop();
        if (this.backgroundTasks.size > 0) {
          await Promise.allSettled([...this.backgroundTasks]);
        }
        emitEvent('voice_loop.stopped');
        this.setState('stopped', 'shutdown_complete');
        resolve();
      };
      process.on('SIGINT', shutdown);
      if (durationMs) {
        timer = setTimeout(shutdown, durationMs);
      }
    });
  }
}
