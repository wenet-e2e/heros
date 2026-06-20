#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import process from 'node:process';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import { commandExists } from './audio.js';
import { DashScopeRealtimeClient } from './realtimeClient.js';
import { VoiceLoop } from './voiceLoop.js';
import { createRuntime } from './runtime.js';
import {
  filterEvents,
  followEventLog,
  readEventLog,
  summarizeBackgroundTasks,
  summarizeErrors,
  summarizeEvents,
  summarizeRuntimeState,
  summarizeSharedContext,
  summarizeTurns,
} from './eventLog.js';
import { connectRealtimeWithRetry } from './realtimeRetry.js';
import { emitEvent } from './events.js';

function createRealtimeClient(config) {
  return new DashScopeRealtimeClient({
    apiKey: config.dashscopeApiKey,
    url: config.realtimeUrl,
    model: config.realtimeModel,
  });
}

function getArgValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  return args[index + 1] || null;
}

function getEventCount(args) {
  const value = args[1];
  if (!value || value.startsWith('--')) {
    return 20;
  }
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 20;
}

function getPositiveNumberArg(args, name, fallback) {
  const value = Number(getArgValue(args, name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function checkRealtime(config) {
  const realtime = createRealtimeClient(config);
  const logSessionEvent = (event) => {
    if (['session.created', 'session.updated', 'error'].includes(event.type)) {
      console.log(`[realtime] ${event.type}`);
    }
  };
  realtime.on('event', logSessionEvent);
  await connectRealtimeWithRetry(realtime, {
    retries: config.realtimeConnectRetries,
    delayMs: config.realtimeConnectRetryDelayMs,
  });
  realtime.updateSession({
    modalities: ['text', 'audio'],
    voice: config.realtimeVoice,
    instructions: config.realtimeInstructions,
    turnDetection: null,
    inputAudioTranscription: {
      model: config.realtimeInputTranscriptionModel,
    },
  });
  await realtime.waitFor('session.updated', 15000);
  realtime.off('event', logSessionEvent);
  realtime.close();
}

async function doctor() {
  const { config, client, bootstrap } = createRuntime();
  emitEvent('doctor.started', {
    realtimeModel: config.realtimeModel,
    backgroundModel: config.backgroundModel,
  });
  console.log(`DashScope base URL: ${config.dashscopeBaseUrl}`);
  console.log(`DashScope request timeout: ${config.dashscopeRequestTimeoutMs}ms`);
  console.log(`Realtime URL: ${config.realtimeUrl}`);
  console.log(`Realtime model: ${config.realtimeModel}`);
  console.log(`Realtime voice: ${config.realtimeVoice}`);
  console.log(`Realtime turn detection: ${config.realtimeTurnDetection}`);
  console.log(`Realtime connect retries: ${config.realtimeConnectRetries}`);
  console.log(`Background model: ${config.backgroundModel}`);
  console.log(`Background task timeout: ${config.backgroundTaskTimeoutMs}ms`);
  console.log(`Time zone: ${config.timeZone}`);
  console.log(`Reminder poll interval: ${config.reminderPollMs}ms`);
  console.log(`Data dir: ${config.dataDir}`);
  console.log(`Event log path: ${config.eventLogPath}`);
  console.log(`Agent bootstrap dir: ${bootstrap.targetDir}`);
  console.log(`Audio recorder available: ${await commandExists('rec')}`);
  console.log(`Audio player available: ${await commandExists('play')}`);
  console.log('Checking realtime WebSocket session...');
  try {
    await checkRealtime(config);
    emitEvent('doctor.realtime_ok', { model: config.realtimeModel });
    console.log('Realtime session OK.');
    console.log('Checking background LLM...');
    const reply = await client.text({
      model: config.backgroundModel,
      temperature: 0.2,
      messages: [
        { role: 'system', content: '用一句中文短句回答。' },
        { role: 'user', content: '介绍你自己。' },
      ],
    });
    emitEvent('doctor.background_ok', { model: config.backgroundModel });
    emitEvent('doctor.completed', {
      realtimeModel: config.realtimeModel,
      backgroundModel: config.backgroundModel,
    });
    console.log(`Background LLM OK: ${reply}`);
  } catch (error) {
    emitEvent('doctor.failed', { message: error.message });
    throw error;
  }
}

async function once(text) {
  const { interactionModel } = createRuntime();
  const reply = await interactionModel.respond(text);
  console.log(`HerOS: ${reply}`);
}

async function realtimeText(text) {
  if (!text.trim()) {
    throw new Error('Usage: npm run realtime -- <text>');
  }
  const runtime = createRuntime({ printEvents: false });
  const realtime = createRealtimeClient(runtime.config);
  let responseText = '';

  realtime.on('event', (event) => {
    if (event.type === 'response.audio_transcript.delta' || event.type === 'response.text.delta') {
      responseText += event.delta || '';
    } else if (event.type === 'response.audio_transcript.done') {
      responseText = event.transcript || responseText;
    } else if (event.type === 'response.text.done') {
      responseText = event.text || responseText;
    } else if (event.type === 'error') {
      emitEvent('error', { source: 'realtime_text', error: event.error || event });
    }
  });

  const userTurn = runtime.context.addTurn('user', text);
  emitEvent('input_audio.completed', { mode: 'realtime_text' });
  emitEvent('interaction.context_updated', {
    contextVersion: runtime.context.version,
    reason: 'realtime_text_input',
    turnId: userTurn.id,
  });
  emitEvent('transcript.completed', {
    mode: 'realtime_text',
    text,
    contextVersion: runtime.context.version,
    turnId: userTurn.id,
  });

  try {
    await connectRealtimeWithRetry(realtime, {
      retries: runtime.config.realtimeConnectRetries,
      delayMs: runtime.config.realtimeConnectRetryDelayMs,
    });
    realtime.updateSession({
      modalities: ['text', 'audio'],
      voice: runtime.config.realtimeVoice,
      instructions: runtime.config.realtimeInstructions,
      turnDetection: null,
      inputAudioTranscription: {
        model: runtime.config.realtimeInputTranscriptionModel,
      },
    });
    await realtime.waitFor('session.updated', 15000);
    realtime.createUserTextMessage(text);
    realtime.createResponse();
    await realtime.waitFor('response.done', 60000);
  } finally {
    realtime.close();
  }

  const reply = responseText.trim();
  if (!reply) {
    throw new Error('Realtime text turn did not return a transcript');
  }
  const assistantTurn = runtime.context.addTurn('assistant', reply);
  emitEvent('response.completed', {
    source: 'realtime_text',
    model: runtime.config.realtimeModel,
    sourceTurnId: userTurn.id,
    text: reply,
    turnId: assistantTurn.id,
  });
  console.log(JSON.stringify({
    text,
    response: reply,
  }, null, 2));
}

async function status() {
  const { config, reminderStore, memoryStore, bootstrap } = createRuntime({ requireApiKey: false });
  const reminders = reminderStore.list();
  const loggedEvents = readEventLog(config.eventLogPath);
  const eventSummary = summarizeEvents(loggedEvents);
  const taskSummary = summarizeBackgroundTasks(loggedEvents);
  const runtimeState = summarizeRuntimeState(loggedEvents);
  const errorSummary = summarizeErrors(loggedEvents);
  const turnSummary = summarizeTurns(loggedEvents);
  const remindersByStatus = reminders.reduce((acc, reminder) => {
    acc[reminder.status] = (acc[reminder.status] || 0) + 1;
    return acc;
  }, {});
  const scheduledReminders = reminders
    .filter((reminder) => reminder.status === 'scheduled')
    .sort((a, b) => Date.parse(a.remindAt) - Date.parse(b.remindAt));
  const dueScheduled = scheduledReminders.filter((reminder) => Date.parse(reminder.remindAt) <= Date.now());
  const backgroundTasksByStatus = taskSummary.tasks.reduce((acc, task) => {
    acc[task.status] = (acc[task.status] || 0) + 1;
    return acc;
  }, {});
  const lastBackgroundTask = taskSummary.tasks[0] || null;
  console.log(JSON.stringify({
    apiKeyConfigured: Boolean(config.dashscopeApiKey),
    realtimeModel: config.realtimeModel,
    backgroundModel: config.backgroundModel,
    backgroundTaskTimeoutMs: config.backgroundTaskTimeoutMs,
    timeZone: config.timeZone,
    dataDir: config.dataDir,
    eventLogPath: config.eventLogPath,
    bootstrapDir: bootstrap.targetDir,
    bootstrapFiles: bootstrap.files.length,
    audio: {
      recorderAvailable: await commandExists('rec'),
      playerAvailable: await commandExists('play'),
    },
    reminders: {
      total: reminders.length,
      byStatus: remindersByStatus,
      dueScheduled: dueScheduled.length,
      nextScheduledAt: scheduledReminders[0]?.remindAt || null,
    },
    events: {
      total: eventSummary.total,
      lastEventType: eventSummary.lastEventType,
      lastEventAt: eventSummary.lastEventAt,
    },
    turns: {
      total: turnSummary.total,
      lastTurnId: turnSummary.turns.at(-1)?.turnId || null,
      lastTurnAt: turnSummary.turns.at(-1)?.createdAt || null,
    },
    errors: {
      total: errorSummary.total,
      lastErrorType: errorSummary.errors.at(-1)?.type || null,
      lastErrorAt: errorSummary.errors.at(-1)?.createdAt || null,
    },
    backgroundTasks: {
      total: taskSummary.total,
      byStatus: backgroundTasksByStatus,
      lastTaskStatus: lastBackgroundTask?.status || null,
      lastTaskUpdatedAt: lastBackgroundTask?.updatedAt || null,
    },
    runtimeState: {
      state: runtimeState.state,
      reason: runtimeState.reason,
      updatedAt: runtimeState.updatedAt,
      speaking: runtimeState.speaking,
      backgroundRunning: runtimeState.backgroundRunning,
      activeBackgroundTaskCount: runtimeState.activeBackgroundTaskCount,
      pendingClarificationCount: runtimeState.pendingClarificationCount,
    },
    memories: {
      total: memoryStore.list().length,
    },
  }, null, 2));
}

async function events({ backgroundTaskId, count = 20, follow = false, fromStart = false, pollMs = 500, sourceTurnId, turnId, type } = {}) {
  const { config } = createRuntime({ requireApiKey: false });
  if (follow) {
    console.log(`Following event log: ${config.eventLogPath}`);
    await followEventLog(config.eventLogPath, {
      backgroundTaskId,
      fromStart,
      pollMs,
      sourceTurnId,
      turnId,
      type,
      onEvent(event) {
        console.log(JSON.stringify(event));
      },
    });
    return;
  }
  const allEvents = readEventLog(config.eventLogPath);
  if (allEvents.length === 0) {
    console.log('No event log yet.');
    return;
  }
  for (const event of filterEvents(allEvents, { backgroundTaskId, sourceTurnId, turnId, type }).slice(-count)) {
    console.log(JSON.stringify(event));
  }
}

async function eventSummary() {
  const { config } = createRuntime({ requireApiKey: false });
  console.log(JSON.stringify(summarizeEvents(readEventLog(config.eventLogPath)), null, 2));
}

async function errorSummary({ count = 20 } = {}) {
  const { config } = createRuntime({ requireApiKey: false });
  const summary = summarizeErrors(readEventLog(config.eventLogPath));
  console.log(JSON.stringify({
    ...summary,
    errors: summary.errors.slice(-count),
  }, null, 2));
}

async function taskSummary({ count = 20 } = {}) {
  const { config } = createRuntime({ requireApiKey: false });
  const summary = summarizeBackgroundTasks(readEventLog(config.eventLogPath));
  console.log(JSON.stringify({
    ...summary,
    tasks: summary.tasks.slice(0, count),
  }, null, 2));
}

async function runtimeState() {
  const { config } = createRuntime({ requireApiKey: false });
  console.log(JSON.stringify(summarizeRuntimeState(readEventLog(config.eventLogPath)), null, 2));
}

async function contextSummary() {
  const { bootstrap, config, memoryStore, reminderStore } = createRuntime({ requireApiKey: false, printEvents: false });
  console.log(JSON.stringify(summarizeSharedContext(readEventLog(config.eventLogPath), {
    bootstrapFiles: bootstrap.files,
    memories: memoryStore.list(),
    reminders: reminderStore.list(),
  }), null, 2));
}

async function turnSummary({ count = 20 } = {}) {
  const { config } = createRuntime({ requireApiKey: false });
  const summary = summarizeTurns(readEventLog(config.eventLogPath));
  console.log(JSON.stringify({
    ...summary,
    turns: summary.turns.slice(-count),
  }, null, 2));
}

function routeTarget(decision) {
  if (!decision) {
    return 'realtime_interaction_model';
  }
  return decision.type === 'reminder' ? 'background_agent' : 'local_task_router';
}

async function routeText(text) {
  if (!text.trim()) {
    throw new Error('Usage: npm run route -- <text>');
  }
  const { taskRouter } = createRuntime({ requireApiKey: false, printEvents: false });
  const decision = taskRouter.shouldDelegate(text);
  console.log(JSON.stringify({
    text,
    delegatesToBackground: Boolean(decision),
    handledBy: routeTarget(decision),
    taskType: decision?.type || null,
    reason: decision?.reason || 'no_background_task',
  }, null, 2));
}

async function bootstrapStatus() {
  const { bootstrap, memoryStore } = createRuntime({ requireApiKey: false, printEvents: false });
  const files = bootstrap.files.map((filePath) => {
    const stat = fs.statSync(filePath);
    return {
      name: path.basename(filePath),
      path: filePath,
      sizeBytes: stat.size,
    };
  });
  console.log(JSON.stringify({
    bootstrapDir: bootstrap.targetDir,
    files,
    memoryCount: memoryStore.list().length,
  }, null, 2));
}

async function audioStatus() {
  console.log(JSON.stringify({
    recorder: {
      command: 'rec',
      available: await commandExists('rec'),
    },
    player: {
      command: 'play',
      available: await commandExists('play'),
    },
  }, null, 2));
}

function checkWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probePath = path.join(dir, `.heros-preflight-${process.pid}`);
    fs.writeFileSync(probePath, 'ok');
    fs.unlinkSync(probePath);
    return { path: dir, writable: true };
  } catch (error) {
    return { path: dir, writable: false, error: error.message };
  }
}

async function collectPreflight(runtime = createRuntime({ requireApiKey: false, printEvents: false })) {
  const { bootstrap, config } = runtime;
  const recorderAvailable = await commandExists('rec');
  const playerAvailable = await commandExists('play');
  const bootstrapNames = bootstrap.files.map((filePath) => path.basename(filePath));
  const missingBootstrap = ['AGENTS.md', 'SOUL.md', 'MEMORY.md'].filter((name) => !bootstrapNames.includes(name));
  const dataDir = checkWritableDir(config.dataDir);
  const eventLogDir = checkWritableDir(path.dirname(config.eventLogPath));
  const checks = {
    apiKey: {
      ok: Boolean(config.dashscopeApiKey),
      source: config.dashscopeApiKey ? 'env_or_dotenv' : null,
    },
    audio: {
      recorder: {
        command: 'rec',
        ok: recorderAvailable,
        installHint: recorderAvailable ? null : 'Install SoX, for example: brew install sox',
      },
      player: {
        command: 'play',
        ok: playerAvailable,
        installHint: playerAvailable ? null : 'Install SoX, for example: brew install sox',
      },
    },
    runtimeData: {
      dataDir,
      eventLogDir,
    },
    bootstrap: {
      ok: missingBootstrap.length === 0,
      dir: bootstrap.targetDir,
      files: bootstrapNames,
      missing: missingBootstrap,
    },
  };
  return {
    ready: checks.apiKey.ok
      && checks.audio.recorder.ok
      && checks.audio.player.ok
      && checks.runtimeData.dataDir.writable
      && checks.runtimeData.eventLogDir.writable
      && checks.bootstrap.ok,
    realtimeModel: config.realtimeModel,
    backgroundModel: config.backgroundModel,
    checks,
  };
}

async function preflight() {
  console.log(JSON.stringify(await collectPreflight(), null, 2));
}

async function phaseOneReview() {
  const runtime = createRuntime({ requireApiKey: false, printEvents: false });
  const preflightReport = await collectPreflight(runtime);
  const events = readEventLog(runtime.config.eventLogPath);
  const reminderRoute = runtime.taskRouter.shouldDelegate('明天九点提醒我喝水');
  const chatRoute = runtime.taskRouter.shouldDelegate('你怎么看这个观点？');
  const context = summarizeSharedContext(events, {
    bootstrapFiles: runtime.bootstrap.files,
    memories: runtime.memoryStore.list(),
    reminders: runtime.reminderStore.list(),
  });
  const review = {
    phase: 'phase_1_no_ui_cli',
    ready: preflightReport.ready
      && reminderRoute?.type === 'reminder'
      && !chatRoute
      && fs.existsSync(path.join(process.cwd(), 'README.md'))
      && fs.existsSync(path.join(process.cwd(), 'docs', 'system-design.md')),
    checks: {
      preflight: preflightReport,
      routing: {
        reminderDelegatesToBackground: reminderRoute?.type === 'reminder',
        chatStaysRealtime: !chatRoute,
      },
      observability: {
        eventLogPath: runtime.config.eventLogPath,
        eventCount: events.length,
        lastEventType: events.at(-1)?.type || null,
      },
      sharedContext: {
        contextVersion: context.contextVersion,
        turns: context.turns.total,
        backgroundTasks: context.backgroundTasks.total,
        reminders: context.reminders.total,
        memories: context.longTermMemory.total,
      },
      docs: {
        readme: fs.existsSync(path.join(process.cwd(), 'README.md')),
        systemDesign: fs.existsSync(path.join(process.cwd(), 'docs', 'system-design.md')),
        cliRuntime: fs.existsSync(path.join(process.cwd(), 'docs', 'cli-runtime.md')),
      },
    },
  };
  console.log(JSON.stringify(review, null, 2));
}

async function listReminders() {
  const { reminderStore } = createRuntime({ requireApiKey: false });
  console.log(JSON.stringify(reminderStore.list(), null, 2));
}

async function cancelReminder(id) {
  if (!id) {
    throw new Error('Usage: npm run cancel-reminder -- <id>');
  }
  const { reminderStore } = createRuntime({ requireApiKey: false, printEvents: false });
  const reminder = reminderStore.cancel(id);
  if (!reminder) {
    throw new Error(`Scheduled reminder not found: ${id}`);
  }
  emitEvent('reminder.cancelled', { reminder });
  console.log(JSON.stringify(reminder, null, 2));
}

async function checkReminders() {
  const { reminderScheduler } = createRuntime({ requireApiKey: false, printEvents: false });
  console.log(JSON.stringify(reminderScheduler.check({ print: false }), null, 2));
}

async function listMemories() {
  const { memoryStore } = createRuntime({ requireApiKey: false });
  console.log(JSON.stringify(memoryStore.list(), null, 2));
}

async function remember(content) {
  if (!content.trim()) {
    throw new Error('Usage: npm run remember -- <content>');
  }
  const { memoryStore } = createRuntime({ requireApiKey: false, printEvents: false });
  const memory = memoryStore.create(content);
  emitEvent('memory.created', { memory });
  console.log(JSON.stringify(memory, null, 2));
}

async function updateMemory(id, content) {
  if (!id || !content.trim()) {
    throw new Error('Usage: npm run update-memory -- <id> <content>');
  }
  const { memoryStore } = createRuntime({ requireApiKey: false, printEvents: false });
  const memory = memoryStore.update(id, content);
  if (!memory) {
    throw new Error(`Memory not found: ${id}`);
  }
  emitEvent('memory.updated', { memory });
  console.log(JSON.stringify(memory, null, 2));
}

async function forgetMemory(id) {
  if (!id) {
    throw new Error('Usage: npm run forget-memory -- <id>');
  }
  const { memoryStore } = createRuntime({ requireApiKey: false, printEvents: false });
  if (!memoryStore.delete(id)) {
    throw new Error(`Memory not found: ${id}`);
  }
  emitEvent('memory.deleted', { memoryId: id });
  console.log(JSON.stringify({ deleted: true, id }, null, 2));
}

function printInteractiveHelp() {
  console.log([
    'Commands:',
    '  /help',
    '  /exit',
    '  /reminders',
    '  /context',
    '  /cancel-reminder <id>',
    '  /memory',
    '  /remember <content>',
    '  /update-memory <id> <content>',
    '  /forget <id>',
  ].join('\n'));
}

async function interactive() {
  const { interactionModel, reminderStore, reminderScheduler, memoryStore } = createRuntime();
  const rl = readline.createInterface({ input, output });
  reminderScheduler.start();
  console.log('HerOS CLI ready. Type /exit to quit, /reminders to list reminders, /memory to list memory.');
  try {
    while (true) {
      const text = (await rl.question('You: ')).trim();
      if (!text) {
        continue;
      }
      if (text === '/exit') {
        break;
      }
      if (text === '/help') {
        printInteractiveHelp();
        continue;
      }
      if (text === '/reminders') {
        console.log(JSON.stringify(reminderStore.list(), null, 2));
        continue;
      }
      if (text === '/context') {
        console.log(JSON.stringify(interactionModel.context.snapshot(), null, 2));
        continue;
      }
      if (text.startsWith('/cancel-reminder ')) {
        const reminder = reminderStore.cancel(text.slice('/cancel-reminder '.length).trim());
        console.log(reminder ? `Cancelled: ${reminder.id}` : 'Reminder not found.');
        continue;
      }
      if (text === '/memory') {
        console.log(JSON.stringify(memoryStore.list(), null, 2));
        interactionModel.context.setLongTermMemory(memoryStore.list());
        continue;
      }
      if (text.startsWith('/remember ')) {
        try {
          const memory = memoryStore.create(text.slice('/remember '.length));
          interactionModel.context.setLongTermMemory(memoryStore.list());
          console.log(`Remembered: ${memory.id}`);
        } catch (error) {
          console.log(`Memory error: ${error.message}`);
        }
        continue;
      }
      if (text.startsWith('/forget ')) {
        const deleted = memoryStore.delete(text.slice('/forget '.length).trim());
        interactionModel.context.setLongTermMemory(memoryStore.list());
        console.log(deleted ? 'Forgotten.' : 'Memory not found.');
        continue;
      }
      if (text.startsWith('/update-memory ')) {
        const rest = text.slice('/update-memory '.length).trim();
        const space = rest.indexOf(' ');
        if (space === -1) {
          console.log('Usage: /update-memory <id> <content>');
          continue;
        }
        try {
          const memory = memoryStore.update(rest.slice(0, space), rest.slice(space + 1));
          interactionModel.context.setLongTermMemory(memoryStore.list());
          console.log(memory ? `Updated: ${memory.id}` : 'Memory not found.');
        } catch (error) {
          console.log(`Memory error: ${error.message}`);
        }
        continue;
      }
      try {
        const reply = await interactionModel.respond(text);
        console.log(`HerOS: ${reply}`);
      } catch (error) {
        console.error(`HerOS error: ${error.message}`);
      }
    }
  } finally {
    reminderScheduler.stop();
    rl.close();
  }
}

async function voiceLoop({ playAudio = true, durationMs } = {}) {
  const runtime = createRuntime();
  const realtime = createRealtimeClient(runtime.config);
  const loop = new VoiceLoop({
    agentBootstrap: runtime.agentBootstrap,
    config: runtime.config,
    realtime,
    taskRouter: runtime.taskRouter,
    context: runtime.interactionModel.context,
    reminderScheduler: runtime.reminderScheduler,
    playAudio,
  });
  try {
    await loop.start({ durationMs });
  } finally {
    runtime.reminderScheduler.stop();
  }
}

async function talkOnce({ playAudio = true } = {}) {
  const { config } = createRuntime();
  const hasRec = await commandExists('rec');
  if (!hasRec) {
    throw new Error('Missing `rec`. Install SoX first, for example: brew install sox');
  }
  const hasPlay = playAudio && (await commandExists('play'));
  const realtime = createRealtimeClient(config);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const outputPath = path.join(config.dataDir, `realtime-response-${Date.now()}.pcm`);
  const outputFile = fs.createWriteStream(outputPath);
  let player = null;
  let responseText = '';
  let userTranscript = '';

  realtime.on('event', (event) => {
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      userTranscript = event.transcript || '';
      console.log(`\nYou said: ${userTranscript}`);
    } else if (event.type === 'response.audio_transcript.delta') {
      const delta = event.delta || '';
      responseText += delta;
      process.stdout.write(delta);
    } else if (event.type === 'response.audio_transcript.done') {
      responseText = event.transcript || responseText;
      process.stdout.write('\n');
    } else if (event.type === 'response.text.delta') {
      const delta = event.delta || '';
      responseText += delta;
      process.stdout.write(delta);
    } else if (event.type === 'response.audio.delta') {
      const audio = Buffer.from(event.delta || '', 'base64');
      outputFile.write(audio);
      if (player?.stdin.writable) {
        player.stdin.write(audio);
      }
    } else if (event.type === 'error') {
      console.error(`Realtime error: ${event.error?.message || JSON.stringify(event)}`);
    }
  });

  await connectRealtimeWithRetry(realtime, {
    retries: config.realtimeConnectRetries,
    delayMs: config.realtimeConnectRetryDelayMs,
  });
  realtime.updateSession({
    modalities: ['text', 'audio'],
    voice: config.realtimeVoice,
    instructions: config.realtimeInstructions,
    turnDetection: null,
    inputAudioTranscription: {
      model: config.realtimeInputTranscriptionModel,
    },
  });
  await realtime.waitFor('session.updated', 15000);

  if (hasPlay) {
    player = spawn('play', ['-q', '-b', '16', '-c', '1', '-r', '24000', '-e', 'signed-integer', '-t', 'raw', '-'], {
      stdio: ['pipe', 'ignore', 'inherit'],
    });
  }

  const recorder = spawn('rec', ['-q', '-b', '16', '-c', '1', '-r', '16000', '-e', 'signed-integer', '-t', 'raw', '-'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  recorder.stdout.on('data', (chunk) => realtime.appendAudio(chunk));

  const rl = readline.createInterface({ input, output });
  console.log('Recording. Press Enter to stop and send.');
  await rl.question('');
  rl.close();
  recorder.kill('SIGINT');

  await new Promise((resolve) => recorder.once('close', resolve));
  realtime.commitAudio();
  realtime.createResponse();
  await realtime.waitFor('response.done', 120000);
  outputFile.end();
  if (player?.stdin.writable) {
    player.stdin.end();
  }
  realtime.close();

  console.log(`Audio response saved: ${outputPath}`);
  if (!responseText && !userTranscript) {
    console.log('No transcript was returned. Check whether the microphone captured speech.');
  }
}

function printUsage() {
  console.log([
    'HerOS CLI',
    '',
    'Commands:',
    '  npm run doctor            Check DashScope realtime and background LLM.',
    '  npm run status            Print local runtime status without network calls.',
    '  npm run events            Print recent structured runtime events.',
    '  npm run events:follow     Follow structured runtime events as they arrive.',
    '  npm run events -- --type response.completed',
    '  npm run events -- --turn-id turn_xxx',
    '  npm run events -- --source-turn-id turn_xxx',
    '  npm run events -- --background-task-id task_xxx',
    '  npm run event-summary     Summarize structured runtime events.',
    '  npm run errors            Summarize recent error events.',
    '  npm run tasks             Summarize background tasks from event logs.',
    '  npm run runtime-state     Reconstruct client runtime state from event logs.',
    '  npm run context           Reconstruct Shared Context from runtime data.',
    '  npm run turns             Reconstruct recent user/assistant turns from event logs.',
    '  npm run route -- <text>   Show whether text stays realtime or delegates to a task.',
    '  npm run bootstrap         Print runtime agent bootstrap status.',
    '  npm run audio             Check local audio recorder/player commands.',
    '  npm run preflight         Check local readiness before starting voice.',
    '  npm run review            Run local Phase 1 no-UI CLI review.',
    '  npm run reminders         List local reminders without network calls.',
    '  npm run check-reminders   Trigger due local reminders once without starting voice.',
    '  npm run cancel-reminder -- <id>',
    '  npm run memories          List long-term memories without network calls.',
    '  npm run remember -- <content>',
    '  npm run update-memory -- <id> <content>',
    '  npm run forget-memory -- <id>',
    '  npm run cli               Start typed CLI fallback.',
    '  npm run voice             Start continuous realtime voice loop.',
    '  npm run voice -- --duration-ms 3000',
    '  npm run realtime -- hi     Send one text turn through Qwen-Omni-Realtime.',
    '  npm run cli -- --talk     Record one voice turn with Qwen-Omni-Realtime.',
    '  npm run cli -- --once hi  Send one typed fallback turn.',
    '',
    'Environment:',
    '  DASHSCOPE_API_KEY         Required, usually in .env.local.',
    '  HEROS_REALTIME_MODEL      Default qwen3.5-omni-plus-realtime.',
    '  HEROS_REALTIME_TURN_DETECTION Default semantic_vad.',
    '  HEROS_REALTIME_CONNECT_RETRIES Default 2.',
    '  HEROS_BACKGROUND_MODEL    Default qwen3.7-plus.',
    '  HEROS_BACKGROUND_TASK_TIMEOUT_MS Default 60000.',
    '  HEROS_TIME_ZONE           Default system time zone.',
    '  HEROS_REMINDER_POLL_MS    Default 30000.',
    '  HEROS_EVENT_LOG_PATH      Default .heros/events.ndjson.',
  ].join('\n'));
}

const args = process.argv.slice(2);
try {
  if (args[0] === '--doctor') {
    await doctor();
  } else if (args[0] === '--status') {
    await status();
  } else if (args[0] === '--events') {
    await events({
      count: getEventCount(args),
      follow: args.includes('--follow'),
      fromStart: args.includes('--from-start'),
      pollMs: getPositiveNumberArg(args, '--poll-ms', 500),
      type: getArgValue(args, '--type'),
      turnId: getArgValue(args, '--turn-id'),
      sourceTurnId: getArgValue(args, '--source-turn-id'),
      backgroundTaskId: getArgValue(args, '--background-task-id'),
    });
  } else if (args[0] === '--event-summary') {
    await eventSummary();
  } else if (args[0] === '--errors') {
    await errorSummary({ count: getEventCount(args) });
  } else if (args[0] === '--tasks') {
    await taskSummary({ count: getEventCount(args) });
  } else if (args[0] === '--runtime-state') {
    await runtimeState();
  } else if (args[0] === '--context') {
    await contextSummary();
  } else if (args[0] === '--turns') {
    await turnSummary({ count: getEventCount(args) });
  } else if (args[0] === '--route') {
    await routeText(args.slice(1).join(' '));
  } else if (args[0] === '--bootstrap') {
    await bootstrapStatus();
  } else if (args[0] === '--audio') {
    await audioStatus();
  } else if (args[0] === '--preflight') {
    await preflight();
  } else if (args[0] === '--review') {
    await phaseOneReview();
  } else if (args[0] === '--reminders') {
    await listReminders();
  } else if (args[0] === '--check-reminders') {
    await checkReminders();
  } else if (args[0] === '--cancel-reminder') {
    await cancelReminder(args[1]);
  } else if (args[0] === '--memories') {
    await listMemories();
  } else if (args[0] === '--remember') {
    await remember(args.slice(1).join(' '));
  } else if (args[0] === '--update-memory') {
    await updateMemory(args[1], args.slice(2).join(' '));
  } else if (args[0] === '--forget-memory') {
    await forgetMemory(args[1]);
  } else if (args[0] === '--voice-loop') {
    const durationMs = Number(getArgValue(args, '--duration-ms') || 0) || undefined;
    await voiceLoop({ playAudio: !args.includes('--no-play'), durationMs });
  } else if (args[0] === '--realtime-text') {
    await realtimeText(args.slice(1).join(' '));
  } else if (args[0] === '--talk') {
    await talkOnce({ playAudio: args[1] !== '--no-play' });
  } else if (args[0] === '--help' || args[0] === '-h') {
    printUsage();
  } else if (args[0] === '--once') {
    await once(args.slice(1).join(' ') || '你好');
  } else {
    await interactive();
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
