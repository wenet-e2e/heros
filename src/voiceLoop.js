import process from 'node:process';
import { PcmPlayer, PcmRecorder } from './audio.js';
import { emitEvent } from './events.js';
import { connectRealtimeWithRetry } from './realtimeRetry.js';

const BACKGROUND_HANDOFF_TOOL = Object.freeze({
  type: 'function',
  name: 'handoff_to_background',
  description: 'Hand off task, tool, memory, skill, reminder, schedule, or other action requests to the HerOS background model.',
  parameters: {
    type: 'object',
    properties: {
      user_intent: {
        type: 'string',
        description: 'The user request that needs background handling, preserving important details.',
      },
      reason: {
        type: 'string',
        description: 'Why this request should be handled by the background model instead of direct chat.',
      },
      expected_response_style: {
        type: 'string',
        description: 'How the final spoken answer should sound to the user.',
      },
    },
    required: ['user_intent'],
  },
});

function parseFunctionArguments(value) {
  if (!value) {
    return {};
  }
  if (typeof value === 'object') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return { user_intent: String(value) };
  }
}

function extractFunctionCall(event) {
  if (event.type === 'response.function_call_arguments.done') {
    return {
      arguments: event.arguments,
      callId: event.call_id || event.callId,
      name: event.name,
    };
  }
  const item = event.item || event.output_item;
  if (item?.type === 'function_call') {
    return {
      arguments: item.arguments,
      callId: item.call_id || item.callId,
      name: item.name,
    };
  }
  return null;
}

export class VoiceLoop {
  constructor({ agentBootstrap = {}, config, realtime, taskRouter, context, reminderScheduler, playAudio = true }) {
    this.agentBootstrap = agentBootstrap;
    this.config = config;
    this.realtime = realtime;
    this.taskRouter = taskRouter;
    this.context = context;
    this.reminderScheduler = reminderScheduler;
    this.playAudio = playAudio;
    this.player = new PcmPlayer({ sampleRate: 24000, enabled: playAudio });
    this.recorder = new PcmRecorder({ sampleRate: 16000 });
    this.voiceInputMode = config.voiceInputMode || 'half_duplex';
    this.voiceOutputTailMs = Number.isFinite(Number(config.voiceOutputTailMs)) ? Number(config.voiceOutputTailMs) : 800;
    this.handoffPostFillerPauseMs = Number.isFinite(Number(config.handoffPostFillerPauseMs)) ? Number(config.handoffPostFillerPauseMs) : 250;
    this.suppressInputUntil = 0;
    this.suppressedInputChunks = 0;
    this.lastSuppressionReason = null;
    this.ignoredSpeechActive = false;
    this.ignoredSpeechCount = 0;
    this.isPlaybackDraining = false;
    this.responsePlaybackEpoch = 0;
    this.responsePlaybackDoneTimer = null;
    this.responsePlaybackWaiters = [];
    this.currentResponseAudioBytes = 0;
    this.lastResponseAudioBytes = 0;
    this.isResponding = false;
    this.isAnnouncing = false;
    this.announcementQueue = [];
    this.activeAnnouncement = null;
    this.activeFunctionCall = null;
    this.currentAssistantText = '';
    this.currentAssistantTurnId = null;
    this.forceToolChoice = null;
    this.handledFunctionCallIds = new Set();
    this.lastUserTranscript = '';
    this.lastUserTurnId = null;
    this.backgroundTasks = new Set();
    this.backgroundTaskControllers = new Set();
    this.unsubscribeReminderTrigger = null;
    this.state = 'idle';
    this.turnEpoch = 0;
  }

  buildRealtimeInstructions() {
    const contextSnapshot = this.context.snapshot();
    const sharedContext = {
      contextVersion: contextSnapshot.contextVersion,
      longTermMemory: contextSnapshot.longTermMemory,
      backgroundTasks: contextSnapshot.backgroundTasks.slice(-5),
      skills: contextSnapshot.skills,
    };
    const bootstrap = [
      this.agentBootstrap['AGENTS.md'],
      this.agentBootstrap['SOUL.md'],
      this.agentBootstrap['MEMORY.md'],
    ].filter(Boolean).join('\n\n');
    const handoffStageInstruction = this.forceToolChoice === 'required'
      ? '当前系统已经单独播报过 filler。现在不要再说 filler，不要闲聊，立即调用 handoff_to_background。'
      : '';
    return [
      this.config.realtimeInstructions,
      [
        '工具边界：你只能直接聊天和自然播报。',
        '当用户请求提醒、日程、任务、工具、记忆、skill 或任何需要执行/查询/修改状态的能力时，先说一句极短中文 filler，例如“我看看”“我查查”“我看一下”“我查一下”这类短句，然后调用 handoff_to_background。',
        '当用户表达稳定偏好或事实时，也必须调用 handoff_to_background 写入记忆，例如“我喜欢吃苹果”“我不喜欢咖啡”“我习惯晚上工作”“我的名字是...”。',
        '不要只口头说“我记住了/我记下了”；只有收到 handoff_to_background 的 function result 后才能确认已经记住。',
        '不要自己编造后台任务结果；收到 handoff_to_background 的 function result 后，再用自然、简短、适合语音的中文告诉用户结果。',
      ].join('\n'),
      handoffStageInstruction,
      bootstrap ? `Agent Bootstrap:\n${bootstrap}` : '',
      `Shared Context JSON:\n${JSON.stringify(sharedContext, null, 2)}`,
    ].filter(Boolean).join('\n\n');
  }

  realtimeSessionConfig() {
    const toolChoice = this.forceToolChoice || 'auto';
    return {
      modalities: ['text', 'audio'],
      voice: this.config.realtimeVoice,
      instructions: this.buildRealtimeInstructions(),
      turnDetection: {
        type: this.config.realtimeTurnDetection,
        threshold: Number(this.config.realtimeVadThreshold),
        prefix_padding_ms: Number(this.config.realtimeVadPrefixPaddingMs),
        silence_duration_ms: Number(this.config.realtimeVadSilenceDurationMs),
        create_response: false,
      },
      inputAudioTranscription: {
        model: this.config.realtimeInputTranscriptionModel,
      },
      toolChoice,
      tools: [BACKGROUND_HANDOFF_TOOL],
    };
  }

  syncRealtimeContext(reason) {
    if (typeof this.realtime.updateSession !== 'function') {
      return;
    }
    this.realtime.updateSession(this.realtimeSessionConfig());
    emitEvent('realtime.context_sync_requested', {
      reason,
      contextVersion: this.context.version,
    });
  }

  setState(state, reason, metadata = {}) {
    if (this.state === state) {
      return;
    }
    const previousState = this.state;
    this.state = state;
    emitEvent('state.changed', { ...metadata, previousState, state, reason });
  }

  async start({ durationMs } = {}) {
    try {
      this.attachRealtimeEvents();
      await connectRealtimeWithRetry(this.realtime, {
        retries: this.config.realtimeConnectRetries,
        delayMs: this.config.realtimeConnectRetryDelayMs,
      });
      this.realtime.updateSession(this.realtimeSessionConfig());
      await this.realtime.waitFor('session.updated', 15000);

      await this.player.start();
      this.recorder.on('data', (chunk) => {
        try {
          this.appendMicrophoneAudio(chunk);
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
            reminderId: reminder.id,
            source: 'reminder_due',
          });
        });
        this.reminderScheduler.start();
      }

      await this.waitForShutdown({ durationMs });
    } catch (error) {
      emitEvent('voice_loop.failed', { message: error.message });
      this.setState('error', 'voice_loop_failed');
      this.recorder.stop();
      this.player.stop();
      this.realtime.close();
      this.unsubscribeReminderTrigger?.();
      this.unsubscribeReminderTrigger = null;
      this.reminderScheduler?.stop();
      throw error;
    }
  }

  attachRealtimeEvents() {
    this.realtime.on('event', (event) => {
      const functionCall = extractFunctionCall(event);
      if (functionCall) {
        this.handleFunctionCall(functionCall).catch((error) => {
          emitEvent('tool_call.failed', {
            toolName: functionCall.name || 'unknown_function',
            message: error.message,
          });
        });
        return;
      }
      if (event.type === 'session.created' || event.type === 'session.updated') {
        emitEvent(event.type, { model: this.config.realtimeModel });
      } else if (event.type === 'input_audio_buffer.speech_started') {
        this.handleSpeechStarted();
      } else if (event.type === 'input_audio_buffer.speech_stopped') {
        if (this.ignoredSpeechActive) {
          this.ignoredSpeechActive = false;
          emitEvent('input_audio.ignored_completed', {
            mode: this.voiceInputMode,
            ignoredSpeechCount: this.ignoredSpeechCount,
          });
          return;
        }
        emitEvent('input_audio.completed', { turnEpoch: this.turnEpoch });
      } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
        if (this.shouldIgnoreTranscript()) {
          emitEvent('transcript.ignored', {
            mode: this.voiceInputMode,
            reason: this.inputSuppressionReason() || 'recent_assistant_output',
            text: event.transcript || '',
          });
          return;
        }
        this.handleUserTranscript(event.transcript || '');
      } else if (event.type === 'response.created') {
        this.clearResponsePlaybackDoneTimer();
        this.isPlaybackDraining = false;
        this.responsePlaybackEpoch += 1;
        this.isResponding = true;
        this.currentAssistantText = '';
        this.currentAssistantTurnId = null;
        this.currentResponseAudioBytes = 0;
        this.player.begin();
        this.setState('speaking', 'response_created');
        emitEvent('response.started', { source: 'realtime' });
      } else if (event.type === 'response.audio_transcript.delta' || event.type === 'response.text.delta') {
        this.handleAssistantDelta(event.delta || '');
      } else if (event.type === 'response.audio_transcript.done' || event.type === 'response.text.done') {
        this.handleAssistantDone(event.transcript || event.text || this.currentAssistantText);
      } else if (event.type === 'response.audio.delta') {
        const audio = Buffer.from(event.delta || '', 'base64');
        this.currentResponseAudioBytes += audio.length;
        this.extendInputSuppressionForOutput(audio.length, 'response_audio_delta');
        this.player.write(audio);
      } else if (event.type === 'response.done') {
        this.isResponding = false;
        this.lastResponseAudioBytes = this.currentResponseAudioBytes;
        this.player.end();
        this.startInputSuppressionTail('response_done');
        this.isPlaybackDraining = true;
        const activeOutput = this.activeAnnouncement || this.activeFunctionCall;
        emitEvent('response.completed', {
          backgroundTaskId: activeOutput?.backgroundTaskId,
          reminderId: activeOutput?.reminderId,
          sourceTurnId: activeOutput?.turnId,
          source: activeOutput?.source || 'realtime',
          text: this.currentAssistantText,
          turnId: this.currentAssistantTurnId,
        });
        this.activeFunctionCall = null;
        this.scheduleResponsePlaybackDone(this.responsePlaybackEpoch);
      } else if (event.type === 'error') {
        emitEvent('error', { source: 'realtime', error: event.error || event });
      }
    });
  }

  inputSuppressionReason() {
    if (this.voiceInputMode === 'full_duplex' || !this.playAudio) {
      return null;
    }
    if (this.isResponding || this.isAnnouncing || this.isPlaybackDraining) {
      return 'assistant_output_active';
    }
    if (Date.now() < this.suppressInputUntil) {
      return 'assistant_output_tail';
    }
    return null;
  }

  appendMicrophoneAudio(chunk) {
    const suppressionReason = this.inputSuppressionReason();
    if (suppressionReason) {
      this.suppressedInputChunks += 1;
      if (this.lastSuppressionReason !== suppressionReason) {
        emitEvent('input_audio.suppressed', {
          mode: this.voiceInputMode,
          reason: suppressionReason,
          suppressedChunks: this.suppressedInputChunks,
          tailMs: this.voiceOutputTailMs,
        });
        this.lastSuppressionReason = suppressionReason;
      }
      return false;
    }
    if (this.suppressedInputChunks > 0) {
      emitEvent('input_audio.resumed', {
        mode: this.voiceInputMode,
        suppressedChunks: this.suppressedInputChunks,
      });
      this.suppressedInputChunks = 0;
      this.lastSuppressionReason = null;
    }
    this.realtime.appendAudio(chunk);
    return true;
  }

  extendInputSuppressionForOutput(byteLength, reason) {
    if (this.voiceInputMode === 'full_duplex' || !this.playAudio || byteLength <= 0) {
      return;
    }
    const bytesPerSecond = 24000 * 2;
    const audioDurationMs = Math.ceil((byteLength / bytesPerSecond) * 1000);
    const now = Date.now();
    const startAt = Math.max(now, this.suppressInputUntil);
    this.suppressInputUntil = startAt + audioDurationMs;
    emitEvent('input_audio.suppression_extended', {
      mode: this.voiceInputMode,
      reason,
      audioBytes: byteLength,
      audioDurationMs,
      suppressForMs: Math.max(0, this.suppressInputUntil - now),
    });
  }

  startInputSuppressionTail(reason) {
    if (this.voiceInputMode === 'full_duplex' || !this.playAudio || this.voiceOutputTailMs <= 0) {
      return;
    }
    const now = Date.now();
    this.suppressInputUntil = Math.max(this.suppressInputUntil, now) + this.voiceOutputTailMs;
    emitEvent('input_audio.suppression_tail_started', {
      mode: this.voiceInputMode,
      reason,
      tailMs: this.voiceOutputTailMs,
      suppressForMs: Math.max(0, this.suppressInputUntil - now),
    });
  }

  clearResponsePlaybackDoneTimer() {
    if (this.responsePlaybackDoneTimer) {
      clearTimeout(this.responsePlaybackDoneTimer);
      this.responsePlaybackDoneTimer = null;
    }
  }

  resolveResponsePlaybackWaiters() {
    const waiters = this.responsePlaybackWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }

  scheduleResponsePlaybackDone(epoch) {
    this.clearResponsePlaybackDoneTimer();
    const suppressionWaitMs = Math.max(0, this.suppressInputUntil - Date.now());
    const playerWaitMs = typeof this.player.pendingPlaybackMs === 'function' ? this.player.pendingPlaybackMs() : 0;
    const waitMs = Math.max(suppressionWaitMs, playerWaitMs);
    emitEvent('response.playback_draining', {
      turnId: this.currentAssistantTurnId,
      waitMs,
      playerWaitMs,
    });
    this.responsePlaybackDoneTimer = setTimeout(() => {
      this.finishResponsePlayback(epoch);
    }, waitMs);
  }

  finishResponsePlayback(epoch) {
    if (epoch !== this.responsePlaybackEpoch || this.isResponding) {
      return;
    }
    this.clearResponsePlaybackDoneTimer();
    this.isPlaybackDraining = false;
    emitEvent('response.playback_completed', {
      turnId: this.currentAssistantTurnId,
    });
    this.resolveResponsePlaybackWaiters();
    this.setState('listening', 'response_playback_done', { turnId: this.currentAssistantTurnId });
    this.drainAnnouncements();
  }

  shouldIgnoreRemoteSpeech() {
    return Boolean(this.inputSuppressionReason());
  }

  shouldIgnoreTranscript() {
    return this.ignoredSpeechActive || this.shouldIgnoreRemoteSpeech();
  }

  async handleSpeechStarted() {
    const suppressionReason = this.inputSuppressionReason();
    if (suppressionReason) {
      this.ignoredSpeechActive = true;
      this.ignoredSpeechCount += 1;
      emitEvent('input_audio.ignored', {
        mode: this.voiceInputMode,
        reason: suppressionReason,
        ignoredSpeechCount: this.ignoredSpeechCount,
        turnEpoch: this.turnEpoch,
      });
      return;
    }
    this.turnEpoch += 1;
    emitEvent('conversation.epoch_changed', { turnEpoch: this.turnEpoch, reason: 'user_speech_started' });
    this.forceToolChoice = null;
    this.cancelBackgroundTasks('user_speech_started');
    emitEvent('input_audio.started', { turnEpoch: this.turnEpoch });
    if (!this.isResponding) {
      this.setState('listening', 'user_speech_started', { turnEpoch: this.turnEpoch });
      return;
    }
    this.setState('interrupted', 'user_speech_started', { turnEpoch: this.turnEpoch });
    emitEvent('response.interrupted', { reason: 'user_speech_started', turnEpoch: this.turnEpoch });
    try {
      this.realtime.cancelResponse();
    } catch (error) {
      emitEvent('error', { source: 'response.cancel', message: error.message });
    }
    await this.player.interrupt();
    this.isResponding = false;
    this.setState('listening', 'response_interrupted', { turnEpoch: this.turnEpoch });
  }

  handleUserTranscript(transcript) {
    if (!transcript.trim()) {
      return;
    }
    console.log(`\nYou: ${transcript}`);
    const userTurn = this.context.addTurn('user', transcript);
    emitEvent('interaction.context_updated', {
      contextVersion: this.context.version,
      reason: 'user_transcript',
      turnId: userTurn.id,
    });
    emitEvent('transcript.completed', {
      text: transcript,
      contextVersion: this.context.version,
      turnEpoch: this.turnEpoch,
      turnId: userTurn.id,
    });
    this.lastUserTranscript = transcript;
    this.lastUserTurnId = userTurn.id;
    this.respondToUserTranscript(transcript, {
      turnEpoch: this.turnEpoch,
      turnId: userTurn.id,
    }).catch((error) => {
      emitEvent('error', { source: 'voice_loop.respond_to_transcript', message: error.message });
    });
  }

  shouldDelegateTranscript(transcript) {
    try {
      return Boolean(this.taskRouter?.shouldDelegate?.(transcript));
    } catch (error) {
      emitEvent('error', { source: 'handoff.intent_detection', message: error.message });
      return false;
    }
  }

  fillerTextForTranscript(transcript) {
    if (/(查|查询|搜索|找|提醒|日程|天气|新闻|价格|列表|有哪些)/.test(transcript)) {
      return Math.random() < 0.5 ? '我查查' : '我看一下';
    }
    return Math.random() < 0.5 ? '我看看' : '稍等哦';
  }

  async respondToUserTranscript(transcript, { turnEpoch, turnId } = {}) {
    if (turnEpoch < this.turnEpoch) {
      emitEvent('realtime.response_skipped', {
        reason: 'stale_turn',
        turnEpoch,
        currentTurnEpoch: this.turnEpoch,
        turnId,
      });
      return;
    }
    if (!this.shouldDelegateTranscript(transcript)) {
      this.forceToolChoice = null;
      this.syncRealtimeContext('direct_chat_response');
      this.realtime.createResponse();
      return;
    }

    await this.speakControlledFiller(this.fillerTextForTranscript(transcript), { turnEpoch, turnId });
    if (turnEpoch < this.turnEpoch) {
      emitEvent('realtime.tool_request_skipped', {
        reason: 'stale_turn_after_filler',
        turnEpoch,
        currentTurnEpoch: this.turnEpoch,
        turnId,
      });
      return;
    }
    this.forceToolChoice = 'required';
    this.syncRealtimeContext('controlled_filler_completed_require_tool');
    this.realtime.createResponse();
    emitEvent('realtime.tool_response_requested', {
      toolName: 'handoff_to_background',
      turnEpoch,
      turnId,
    });
  }

  async speakControlledFiller(text, { turnEpoch, turnId } = {}) {
    const filler = String(text || '').trim();
    if (!filler || typeof this.realtime.createSpeechResponse !== 'function') {
      return;
    }
    emitEvent('realtime.controlled_filler_started', { text: filler, turnEpoch, turnId });
    this.realtime.createSpeechResponse(filler);
    if (typeof this.realtime.waitFor === 'function') {
      try {
        await this.realtime.waitFor('response.done', 10000);
      } catch (error) {
        emitEvent('error', { source: 'controlled_filler.wait_for_response_done', message: error.message });
      }
    }
    await this.waitForCurrentPlaybackDone({ timeoutMs: 5000 });
    await this.waitForPostFillerPause();
    emitEvent('realtime.controlled_filler_completed', { text: filler, turnEpoch, turnId });
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
      const assistantTurn = this.context.addTurn('assistant', content);
      this.currentAssistantTurnId = assistantTurn.id;
      emitEvent('interaction.context_updated', { contextVersion: this.context.version, turnId: assistantTurn.id });
    }
    process.stdout.write('\n');
  }

  delegateTask(transcript, { turnEpoch, turnId }) {
    if (!this.isResponding && !this.isAnnouncing) {
      this.setState('background_running', 'background_task_started', { turnEpoch, turnId });
    }
    const controller = new AbortController();
    this.backgroundTaskControllers.add(controller);
    const task = this.taskRouter.maybeHandle(transcript, { turnId, signal: controller.signal }).then((result) => {
      this.syncRealtimeContext('background_task_finished');
      if (result.message) {
        console.log(`\nBackground: ${result.message}`);
        this.enqueueAnnouncement(result.message, {
          backgroundTaskId: result.backgroundTaskId,
          source: 'background_task',
          turnEpoch,
          turnId,
        });
      }
    }).catch((error) => {
      emitEvent('tool_call.failed', { toolName: 'create_reminder', message: error.message });
    }).finally(() => {
      this.backgroundTasks.delete(task);
      this.backgroundTaskControllers.delete(controller);
      if (this.state === 'background_running') {
        this.setState('listening', 'background_task_finished', { turnEpoch, turnId });
      }
    });
    this.backgroundTasks.add(task);
  }

  async waitForCurrentResponseDone({ timeoutMs = 10000 } = {}) {
    if (!this.isResponding || typeof this.realtime.waitFor !== 'function') {
      return;
    }
    try {
      await this.realtime.waitFor('response.done', timeoutMs);
    } catch (error) {
      emitEvent('error', { source: 'handoff.wait_for_response_done', message: error.message });
    }
  }

  async waitForCurrentPlaybackDone({ timeoutMs = 3000 } = {}) {
    if (!this.playAudio) {
      return;
    }
    const playerWaitMs = typeof this.player.pendingPlaybackMs === 'function' ? this.player.pendingPlaybackMs() : 0;
    const hasKnownPlayback = this.isPlaybackDraining
      || this.currentResponseAudioBytes > 0
      || this.lastResponseAudioBytes > 0
      || playerWaitMs > 0;
    if (!hasKnownPlayback) {
      return;
    }
    const estimatedWaitMs = Math.max(0, this.suppressInputUntil - Date.now(), playerWaitMs);
    emitEvent('handoff.waiting_for_playback', {
      estimatedWaitMs,
      playerWaitMs,
      timeoutMs,
    });
    if (typeof this.player.waitForIdle === 'function') {
      const idle = await this.player.waitForIdle({ timeoutMs });
      emitEvent(idle ? 'handoff.playback_idle' : 'handoff.playback_idle_timeout', {
        estimatedWaitMs,
        timeoutMs,
      });
      return;
    }
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        emitEvent('handoff.playback_wait_timeout', {
          estimatedWaitMs,
          timeoutMs,
        });
        resolve();
      }, timeoutMs);
      const done = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timeout);
        const index = this.responsePlaybackWaiters.indexOf(done);
        if (index !== -1) {
          this.responsePlaybackWaiters.splice(index, 1);
        }
      };
      this.responsePlaybackWaiters.push(done);
    });
  }

  async waitForPostFillerPause() {
    if (!this.playAudio || this.lastResponseAudioBytes <= 0 || this.handoffPostFillerPauseMs <= 0) {
      return;
    }
    emitEvent('handoff.post_filler_pause', {
      pauseMs: this.handoffPostFillerPauseMs,
    });
    await new Promise((resolve) => setTimeout(resolve, this.handoffPostFillerPauseMs));
  }

  async handleFunctionCall(functionCall) {
    if (functionCall.name !== 'handoff_to_background') {
      return;
    }
    if (!functionCall.callId) {
      emitEvent('tool_call.failed', {
        toolName: functionCall.name,
        message: 'Missing realtime function call id.',
      });
      return;
    }
    if (this.handledFunctionCallIds.has(functionCall.callId)) {
      return;
    }
    this.handledFunctionCallIds.add(functionCall.callId);

    const args = parseFunctionArguments(functionCall.arguments);
    const userIntent = String(args.user_intent || args.query || args.text || this.lastUserTranscript || '').trim();
    const turnId = this.lastUserTurnId;
    const turnEpoch = this.turnEpoch;
    emitEvent('tool_call.started', {
      toolName: functionCall.name,
      callId: functionCall.callId,
      turnEpoch,
      turnId,
    });

    const controller = new AbortController();
    this.backgroundTaskControllers.add(controller);
    const task = this.runBackgroundHandoff(userIntent, {
      args,
      callId: functionCall.callId,
      signal: controller.signal,
      turnEpoch,
      turnId,
    }).finally(() => {
      this.backgroundTasks.delete(task);
      this.backgroundTaskControllers.delete(controller);
    });
    this.backgroundTasks.add(task);
    const output = await task;

    await this.waitForCurrentResponseDone();
    await this.waitForCurrentPlaybackDone();
    await this.waitForPostFillerPause();
    this.realtime.createFunctionCallOutput(functionCall.callId, output);
    this.activeFunctionCall = {
      backgroundTaskId: output.backgroundTaskId,
      source: 'background_task',
      turnId,
    };
    this.forceToolChoice = null;
    this.syncRealtimeContext('background_function_call_completed');
    this.createResultSpeechResponse(output.message || '处理完成。');
    emitEvent('tool_call.completed', {
      toolName: functionCall.name,
      callId: functionCall.callId,
      backgroundTaskId: output.backgroundTaskId,
      turnId,
    });
  }

  createResultSpeechResponse(message) {
    const text = String(message || '').trim();
    if (!text) {
      return;
    }
    if (typeof this.realtime.createSpeechResponse === 'function') {
      this.realtime.createSpeechResponse(text);
      return;
    }
    this.realtime.createUserTextMessage([
      '后台任务结果如下。',
      text,
      '请只用一句自然、简短、适合语音播报的话告诉用户，不要调用工具。',
    ].join('\n'));
    this.realtime.createResponse();
  }

  async runBackgroundHandoff(userIntent, { args, callId, signal, turnEpoch, turnId }) {
    if (!userIntent) {
      return {
        ok: false,
        callId,
        message: '我没有拿到需要后台处理的具体请求，请让用户再说一次。',
      };
    }
    this.setState('background_running', 'background_function_call_started', { turnEpoch, turnId });
    let result = null;
    try {
      result = await this.taskRouter.maybeHandle(userIntent, { turnId, signal });
      if (!result) {
        result = {
          type: 'none',
          message: '这个请求不需要后台能力处理，可以直接继续和用户聊天。',
          source: 'background_agent',
        };
      }
      return {
        ok: true,
        callId,
        backgroundTaskId: result.backgroundTaskId,
        type: result.type,
        source: result.source,
        message: result.message || '',
        userIntent,
        reason: args.reason || '',
        expectedResponseStyle: args.expected_response_style || '自然、简短、适合语音播报',
      };
    } catch (error) {
      emitEvent('tool_call.failed', {
        toolName: 'handoff_to_background',
        callId,
        message: error.message,
        turnId,
      });
      return {
        ok: false,
        callId,
        message: '后台任务执行失败了，请用简短自然的话告诉用户可以稍后再试。',
        error: error.message,
        userIntent,
      };
    } finally {
      if (this.state === 'background_running') {
        this.setState('listening', 'background_function_call_finished', { turnEpoch, turnId });
      }
    }
  }

  cancelBackgroundTasks(reason) {
    if (this.backgroundTaskControllers.size === 0) {
      return;
    }
    for (const controller of this.backgroundTaskControllers) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    }
    emitEvent('background_task.cancel_requested', {
      reason,
      count: this.backgroundTaskControllers.size,
      turnEpoch: this.turnEpoch,
    });
  }

  enqueueAnnouncement(message, { backgroundTaskId, reminderId, source = 'background_task', turnEpoch = this.turnEpoch, turnId } = {}) {
    if (turnEpoch < this.turnEpoch) {
      emitEvent('announcement.skipped', {
        backgroundTaskId,
        reminderId,
        source,
        reason: 'stale_turn',
        turnEpoch,
        turnId,
        currentTurnEpoch: this.turnEpoch,
      });
      return;
    }
    this.announcementQueue.push({ message, backgroundTaskId, reminderId, source, turnEpoch, turnId });
    emitEvent('announcement.queued', { backgroundTaskId, reminderId, source, text: message, turnEpoch, turnId });
    this.drainAnnouncements();
  }

  async drainAnnouncements() {
    if (this.isResponding || this.isAnnouncing || this.isPlaybackDraining || this.announcementQueue.length === 0) {
      return;
    }
    const announcement = this.announcementQueue.shift();
    if (announcement.turnEpoch < this.turnEpoch) {
      emitEvent('announcement.skipped', {
        backgroundTaskId: announcement.backgroundTaskId,
        reminderId: announcement.reminderId,
        source: announcement.source,
        reason: 'stale_turn',
        turnEpoch: announcement.turnEpoch,
        turnId: announcement.turnId,
        currentTurnEpoch: this.turnEpoch,
      });
      this.drainAnnouncements();
      return;
    }
    this.isAnnouncing = true;
    this.activeAnnouncement = announcement;
    emitEvent('announcement.started', {
      backgroundTaskId: announcement.backgroundTaskId,
      reminderId: announcement.reminderId,
      source: announcement.source,
      text: announcement.message,
      outlet: 'realtime',
      turnEpoch: announcement.turnEpoch,
      turnId: announcement.turnId,
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
        reminderId: announcement.reminderId,
        source: announcement.source,
        outlet: 'realtime',
        turnEpoch: announcement.turnEpoch,
        turnId: announcement.turnId,
      });
    } catch (error) {
      emitEvent('announcement.failed', {
        backgroundTaskId: announcement.backgroundTaskId,
        reminderId: announcement.reminderId,
        source: announcement.source,
        outlet: 'realtime',
        message: error.message,
        turnEpoch: announcement.turnEpoch,
        turnId: announcement.turnId,
      });
    } finally {
      this.isAnnouncing = false;
      this.activeAnnouncement = null;
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
        this.clearResponsePlaybackDoneTimer();
        this.setState('stopping', 'shutdown');
        emitEvent('voice_loop.stopping');
        this.cancelBackgroundTasks('shutdown');
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
