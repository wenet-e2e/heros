#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import process from 'node:process';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import { commandExists } from './audio.js';
import { writeTextFileAtomic } from './storage.js';
import { LOCAL_TASK_ROUTER_HANDLED_LOCALLY } from './taskRouter.js';
import { DashScopeRealtimeClient } from './realtimeClient.js';
import { VoiceLoop } from './voiceLoop.js';
import { createRuntime } from './runtime.js';
import {
  filterEvents,
  followEventLog,
  readEventLog,
  summarizeBackgroundTasks,
  summarizeBackgroundTaskDetail,
  summarizeErrors,
  summarizeEvents,
  summarizeRuntimeState,
  summarizeSharedContext,
  summarizeTimeline,
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

function latestReviewReport(dataDir) {
  const reviewDir = path.join(dataDir, 'reviews');
  if (!fs.existsSync(reviewDir)) {
    return null;
  }
  const reports = fs.readdirSync(reviewDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const reportPath = path.join(reviewDir, name);
      return {
        path: reportPath,
        updatedAtMs: fs.statSync(reportPath).mtimeMs,
      };
    })
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  if (reports.length === 0) {
    return null;
  }
  const latest = reports[0];
  try {
    const report = JSON.parse(fs.readFileSync(latest.path, 'utf8'));
    return {
      path: latest.path,
      phase: report.phase || null,
      ready: typeof report.ready === 'boolean' ? report.ready : null,
      createdAt: report.createdAt || null,
    };
  } catch (error) {
    return {
      path: latest.path,
      error: error.message,
    };
  }
}

function latestReviewEvent(events) {
  const event = events.filter((item) => item.type === 'review.completed').at(-1);
  if (!event) {
    return null;
  }
  return {
    phase: event.phase || null,
    ready: typeof event.ready === 'boolean' ? event.ready : null,
    reportPath: event.reportPath || null,
    createdAt: event.createdAt || null,
  };
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
  const nextScheduled = scheduledReminders[0] || null;
  const dueScheduled = scheduledReminders.filter((reminder) => Date.parse(reminder.remindAt) <= Date.now());
  const backgroundTasksByStatus = taskSummary.tasks.reduce((acc, task) => {
    acc[task.status] = (acc[task.status] || 0) + 1;
    return acc;
  }, {});
  const lastBackgroundTask = taskSummary.tasks[0] || null;
  const pendingClarifications = runtimeState.pendingClarifications || [];
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
      nextScheduledAt: nextScheduled?.remindAt || null,
      nextScheduled: nextScheduled ? {
        id: nextScheduled.id,
        title: nextScheduled.title,
        remindAt: nextScheduled.remindAt,
      } : null,
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
    localTaskRouter: {
      handledLocally: LOCAL_TASK_ROUTER_HANDLED_LOCALLY,
    },
    runtimeState: {
      state: runtimeState.state,
      reason: runtimeState.reason,
      updatedAt: runtimeState.updatedAt,
      speaking: runtimeState.speaking,
      backgroundRunning: runtimeState.backgroundRunning,
      activeBackgroundTaskCount: runtimeState.activeBackgroundTaskCount,
      pendingClarificationCount: runtimeState.pendingClarificationCount,
      pendingClarifications: pendingClarifications.slice(0, 5).map((task) => ({
        backgroundTaskId: task.backgroundTaskId,
        taskType: task.taskType,
        turnId: task.turnId,
        status: task.status,
        question: task.result?.question || null,
        candidateCount: Array.isArray(task.result?.candidates) ? task.result.candidates.length : 0,
        updatedAt: task.updatedAt,
      })),
      lastEventType: runtimeState.lastEventType,
      lastEventAt: runtimeState.lastEventAt,
      lastTurnId: runtimeState.lastTurnId,
      lastBackgroundTask: runtimeState.lastBackgroundTask ? {
        backgroundTaskId: runtimeState.lastBackgroundTask.backgroundTaskId,
        taskType: runtimeState.lastBackgroundTask.taskType,
        status: runtimeState.lastBackgroundTask.status,
        updatedAt: runtimeState.lastBackgroundTask.updatedAt,
      } : null,
    },
    memories: {
      total: memoryStore.list().length,
    },
    review: {
      latestReport: latestReviewReport(config.dataDir),
      latestEvent: latestReviewEvent(loggedEvents),
    },
  }, null, 2));
}

async function events({ backgroundTaskId, count = 20, follow = false, fromStart = false, pollMs = 500, since, sourceTurnId, turnId, type } = {}) {
  const { config } = createRuntime({ requireApiKey: false });
  if (follow) {
    console.log(`Following event log: ${config.eventLogPath}`);
    await followEventLog(config.eventLogPath, {
      backgroundTaskId,
      fromStart,
      pollMs,
      since,
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
  for (const event of filterEvents(allEvents, { backgroundTaskId, since, sourceTurnId, turnId, type }).slice(-count)) {
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

async function timeline({ backgroundTaskId, count = 20, since, sourceTurnId, turnId, type } = {}) {
  const { config } = createRuntime({ requireApiKey: false });
  const summary = summarizeTimeline(filterEvents(readEventLog(config.eventLogPath), {
    backgroundTaskId,
    since,
    sourceTurnId,
    turnId,
    type,
  }));
  console.log(JSON.stringify({
    ...summary,
    entries: summary.entries.slice(-count),
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

async function taskDetail(backgroundTaskId) {
  if (!backgroundTaskId) {
    throw new Error('Usage: npm run task-detail -- <task_id>');
  }
  const { config } = createRuntime({ requireApiKey: false });
  console.log(JSON.stringify(summarizeBackgroundTaskDetail(readEventLog(config.eventLogPath), backgroundTaskId), null, 2));
}

async function runtimeState() {
  const { config } = createRuntime({ requireApiKey: false });
  console.log(JSON.stringify(summarizeRuntimeState(readEventLog(config.eventLogPath)), null, 2));
}

async function contextSummary() {
  const { bootstrap, config, memoryStore, reminderStore } = createRuntime({ requireApiKey: false, printEvents: false });
  console.log(JSON.stringify(summarizeSharedContext(readEventLog(config.eventLogPath), {
    bootstrapFiles: bootstrap.files,
    localTaskRouter: { handledLocally: LOCAL_TASK_ROUTER_HANDLED_LOCALLY },
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

async function transcript({ count = 20 } = {}) {
  const { config } = createRuntime({ requireApiKey: false, printEvents: false });
  const turns = summarizeTurns(readEventLog(config.eventLogPath)).turns.slice(-count);
  if (turns.length === 0) {
    console.log('No transcript yet.');
    return;
  }
  const lines = turns.map((turn) => {
    const speaker = turn.role === 'user' ? 'User' : 'HerOS';
    const source = turn.role === 'assistant' && turn.source ? ` (${turn.source})` : '';
    const time = turn.createdAt ? ` [${turn.createdAt}]` : '';
    return `${speaker}${source}${time}: ${turn.text || ''}`;
  });
  console.log(lines.join('\n'));
}

function routeTarget(decision) {
  if (!decision) {
    return 'realtime_interaction_model';
  }
  return LOCAL_TASK_ROUTER_HANDLED_LOCALLY.includes(decision.type) ? 'local_task_router' : 'background_agent';
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
    pendingBackgroundTaskId: decision?.pendingBackgroundTaskId || null,
    nextOnly: decision?.nextOnly || false,
  }, null, 2));
}

async function taskText(text) {
  if (!text.trim()) {
    throw new Error('Usage: npm run task -- <text>');
  }
  const runtime = createRuntime({ requireApiKey: false, printEvents: false });
  const decision = runtime.taskRouter.shouldDelegate(text);
  const userTurn = runtime.context.addTurn('user', text);
  emitEvent('input_audio.completed', { mode: 'cli_task' });
  emitEvent('interaction.context_updated', {
    contextVersion: runtime.context.version,
    reason: 'cli_task_input',
    turnId: userTurn.id,
  });
  emitEvent('transcript.completed', {
    mode: 'cli_task',
    text,
    contextVersion: runtime.context.version,
    turnId: userTurn.id,
  });

  if (!decision) {
    console.log(JSON.stringify({
      text,
      delegated: false,
      handledBy: 'realtime_interaction_model',
      reason: 'no_background_task',
      turnId: userTurn.id,
      contextVersion: runtime.context.version,
      result: null,
    }, null, 2));
    return;
  }
  if (routeTarget(decision) === 'background_agent' && !runtime.config.dashscopeApiKey) {
    throw new Error('DASHSCOPE_API_KEY is required for background reminder tasks.');
  }

  const result = await runtime.taskRouter.maybeHandle(text, { turnId: userTurn.id });
  let responseTurn = null;
  if (result?.message) {
    responseTurn = runtime.context.addTurn('assistant', result.message);
    emitEvent('response.completed', {
      backgroundTaskId: result.backgroundTaskId,
      source: result.source || routeTarget(decision),
      sourceTurnId: userTurn.id,
      text: result.message,
      turnId: responseTurn.id,
    });
  }
  console.log(JSON.stringify({
    text,
    delegated: true,
    handledBy: routeTarget(decision),
    taskType: decision.type,
    reason: decision.reason,
    pendingBackgroundTaskId: decision.pendingBackgroundTaskId || null,
    nextOnly: decision.nextOnly || false,
    turnId: userTurn.id,
    responseTurnId: responseTurn?.id || null,
    contextVersion: runtime.context.version,
    result,
  }, null, 2));
}

async function scenario(turns) {
  const texts = turns.map((text) => text.trim()).filter(Boolean);
  if (texts.length === 0) {
    throw new Error('Usage: npm run scenario -- <turn1> <turn2> ...');
  }
  const runtime = createRuntime({ requireApiKey: false, printEvents: false });
  const results = [];
  for (const text of texts) {
    const decision = runtime.taskRouter.shouldDelegate(text);
    const userTurn = runtime.context.addTurn('user', text);
    emitEvent('input_audio.completed', { mode: 'cli_scenario' });
    emitEvent('interaction.context_updated', {
      contextVersion: runtime.context.version,
      reason: 'cli_scenario_input',
      turnId: userTurn.id,
    });
    emitEvent('transcript.completed', {
      mode: 'cli_scenario',
      text,
      contextVersion: runtime.context.version,
      turnId: userTurn.id,
    });

    if (!decision) {
      results.push({
        text,
        delegated: false,
        handledBy: 'realtime_interaction_model',
        reason: 'no_background_task',
        turnId: userTurn.id,
        result: null,
      });
      continue;
    }
    const handledBy = routeTarget(decision);
    if (handledBy === 'background_agent' && !runtime.config.dashscopeApiKey) {
      throw new Error('DASHSCOPE_API_KEY is required for background reminder tasks.');
    }
    const result = await runtime.taskRouter.maybeHandle(text, { turnId: userTurn.id });
    let responseTurn = null;
    if (result?.message) {
      responseTurn = runtime.context.addTurn('assistant', result.message);
      emitEvent('response.completed', {
        backgroundTaskId: result.backgroundTaskId,
        source: result.source || handledBy,
        sourceTurnId: userTurn.id,
        text: result.message,
        turnId: responseTurn.id,
      });
    }
    results.push({
      text,
      delegated: true,
      handledBy,
      taskType: decision.type,
      reason: decision.reason,
      pendingBackgroundTaskId: decision.pendingBackgroundTaskId || null,
      nextOnly: decision.nextOnly || false,
      turnId: userTurn.id,
      responseTurnId: responseTurn?.id || null,
      result,
    });
  }
  console.log(JSON.stringify({
    turns: results,
    contextVersion: runtime.context.version,
    backgroundTasks: runtime.context.snapshot().backgroundTasks.length,
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

async function collectAudioProbe({ durationMs = 500 } = {}) {
  if (!(await commandExists('rec'))) {
    throw new Error('Missing `rec`. Install SoX first, for example: brew install sox');
  }
  const seconds = Math.max(0.1, durationMs / 1000);
  const timeoutMs = Math.max(durationMs + 3000, 5000);
  const args = [
    '-q',
    '-b',
    '16',
    '-c',
    '1',
    '-r',
    '16000',
    '-e',
    'signed-integer',
    '-t',
    'raw',
    '-',
    'trim',
    '0',
    String(seconds),
  ];
  const result = await new Promise((resolve, reject) => {
    const child = spawn('rec', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0;
    let stderr = '';
    let settled = false;
    const fail = (message) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`${message}. Check microphone permission, input device selection, and SoX recorder access.`));
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 500).unref();
      fail(`Audio probe timed out after ${timeoutMs}ms while capturing ${durationMs}ms`);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      fail(error.message);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      if (code !== 0) {
        reject(new Error(`${stderr.trim() || `rec exited with code ${code}`}. Check microphone permission, input device selection, and SoX recorder access.`));
        return;
      }
      resolve({ bytesCaptured: bytes });
    });
  });
  return {
    ok: result.bytesCaptured > 0,
    command: 'rec',
    durationMs,
    sampleRate: 16000,
    channels: 1,
    bytesCaptured: result.bytesCaptured,
  };
}

async function audioProbe({ durationMs = 500 } = {}) {
  console.log(JSON.stringify(await collectAudioProbe({ durationMs }), null, 2));
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

async function collectPreflight(runtime = createRuntime({ requireApiKey: false, printEvents: false }), { probeAudio = false, audioProbeDurationMs = 500 } = {}) {
  const { bootstrap, config } = runtime;
  const recorderAvailable = await commandExists('rec');
  const playerAvailable = await commandExists('play');
  const bootstrapNames = bootstrap.files.map((filePath) => path.basename(filePath));
  const missingBootstrap = ['AGENTS.md', 'SOUL.md', 'MEMORY.md'].filter((name) => !bootstrapNames.includes(name));
  const dataDir = checkWritableDir(config.dataDir);
  const eventLogDir = checkWritableDir(path.dirname(config.eventLogPath));
  let capture = { checked: false };
  if (probeAudio) {
    try {
      capture = {
        checked: true,
        ...(await collectAudioProbe({ durationMs: audioProbeDurationMs })),
      };
    } catch (error) {
      capture = {
        checked: true,
        ok: false,
        command: 'rec',
        durationMs: audioProbeDurationMs,
        error: error.message,
      };
    }
  }
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
      capture,
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
      && (!probeAudio || checks.audio.capture.ok)
      && checks.runtimeData.dataDir.writable
      && checks.runtimeData.eventLogDir.writable
      && checks.bootstrap.ok,
    realtimeModel: config.realtimeModel,
    backgroundModel: config.backgroundModel,
    checks,
  };
}

async function preflight({ probeAudio = false, durationMs = 500 } = {}) {
  console.log(JSON.stringify(await collectPreflight(undefined, {
    probeAudio,
    audioProbeDurationMs: durationMs,
  }), null, 2));
}

function reviewTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function phaseOneReview({ writeReport = false } = {}) {
  const runtime = createRuntime({ requireApiKey: false, printEvents: false });
  const preflightReport = await collectPreflight(runtime);
  const events = readEventLog(runtime.config.eventLogPath);
  const reminderRoute = runtime.taskRouter.shouldDelegate('明天九点提醒我喝水');
  const updateReminderRoute = runtime.taskRouter.shouldDelegate('把喝水提醒改到明天十点');
  const listRemindersRoute = runtime.taskRouter.shouldDelegate('查询一下提醒');
  const nextReminderRoute = runtime.taskRouter.shouldDelegate('下一个提醒是什么？');
  const cancelReminderRoute = runtime.taskRouter.shouldDelegate('取消喝水提醒');
  const bareCancelReminderRoute = runtime.taskRouter.shouldDelegate('取消提醒');
  const cancelNextReminderRoute = runtime.taskRouter.shouldDelegate('取消下一个提醒');
  const updateMemoryRoute = runtime.taskRouter.shouldDelegate('把记忆里短回答改成用户喜欢详细回答');
  const bareForgetMemoryRoute = runtime.taskRouter.shouldDelegate('忘记');
  const chatRoute = runtime.taskRouter.shouldDelegate('你怎么看这个观点？');
  runtime.context.addBackgroundTask({
    backgroundTaskId: 'review_pending_cancel_reminder',
    type: 'cancel_reminder',
    status: 'needs_clarification',
    result: { action: 'cancel_reminder_needs_clarification' },
  });
  const pendingCancelReminderRoute = runtime.taskRouter.shouldDelegate('喝水');
  runtime.context.addBackgroundTask({
    backgroundTaskId: 'review_pending_update_memory',
    type: 'update_memory',
    status: 'needs_clarification',
    result: { action: 'update_memory_needs_clarification' },
  });
  const pendingUpdateMemoryRoute = runtime.taskRouter.shouldDelegate('短回答改成用户喜欢详细回答');
  runtime.context.addBackgroundTask({
    backgroundTaskId: 'review_pending_forget_memory',
    type: 'forget_memory',
    status: 'needs_clarification',
    result: { action: 'forget_memory_needs_clarification' },
  });
  const pendingForgetMemoryRoute = runtime.taskRouter.shouldDelegate('短回答');
  const routing = {
    createReminderDelegatesToBackground: reminderRoute?.type === 'reminder',
    updateReminderDelegatesToBackground: updateReminderRoute?.type === 'update_reminder',
    listRemindersHandledLocally: listRemindersRoute?.type === 'list_reminders',
    nextReminderHandledLocally: nextReminderRoute?.type === 'list_reminders' && nextReminderRoute.nextOnly === true,
    cancelReminderHandledLocally: cancelReminderRoute?.type === 'cancel_reminder',
    bareCancelReminderClarifiesLocally: bareCancelReminderRoute?.type === 'cancel_reminder',
    cancelNextReminderHandledLocally: cancelNextReminderRoute?.type === 'cancel_reminder',
    pendingCancelReminderHandledLocally: pendingCancelReminderRoute?.type === 'cancel_reminder'
      && pendingCancelReminderRoute.reason === 'pending_clarification_response'
      && pendingCancelReminderRoute.pendingBackgroundTaskId === 'review_pending_cancel_reminder',
    updateMemoryHandledLocally: updateMemoryRoute?.type === 'update_memory',
    pendingUpdateMemoryHandledLocally: pendingUpdateMemoryRoute?.type === 'update_memory'
      && pendingUpdateMemoryRoute.reason === 'pending_clarification_response'
      && pendingUpdateMemoryRoute.pendingBackgroundTaskId === 'review_pending_update_memory',
    bareForgetMemoryClarifiesLocally: bareForgetMemoryRoute?.type === 'forget_memory',
    pendingForgetMemoryHandledLocally: pendingForgetMemoryRoute?.type === 'forget_memory'
      && pendingForgetMemoryRoute.reason === 'pending_clarification_response'
      && pendingForgetMemoryRoute.pendingBackgroundTaskId === 'review_pending_forget_memory',
    chatStaysRealtime: !chatRoute,
  };
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const scripts = packageJson.scripts || {};
  const commandSurface = {
    check: Boolean(scripts.check),
    verify: Boolean(scripts.verify),
    smoke: Boolean(scripts.smoke),
    smokeBackground: Boolean(scripts['smoke:background']),
    smokeRealtime: Boolean(scripts['smoke:realtime']),
    cli: Boolean(scripts.cli),
    cliOnce: Boolean(scripts['cli:once']),
    doctor: Boolean(scripts.doctor),
    status: Boolean(scripts.status),
    events: Boolean(scripts.events),
    eventsFollow: Boolean(scripts['events:follow']),
    eventSummary: Boolean(scripts['event-summary']),
    errors: Boolean(scripts.errors),
    timeline: Boolean(scripts.timeline),
    tasks: Boolean(scripts.tasks),
    taskDetail: Boolean(scripts['task-detail']),
    runtimeState: Boolean(scripts['runtime-state']),
    context: Boolean(scripts.context),
    turns: Boolean(scripts.turns),
    transcript: Boolean(scripts.transcript),
    route: Boolean(scripts.route),
    task: Boolean(scripts.task),
    scenario: Boolean(scripts.scenario),
    bootstrap: Boolean(scripts.bootstrap),
    audio: Boolean(scripts.audio),
    audioProbe: Boolean(scripts['audio:probe']),
    preflight: Boolean(scripts.preflight),
    review: Boolean(scripts.review),
    reviewReport: Boolean(scripts['review:report']),
    reminders: Boolean(scripts.reminders),
    checkReminders: Boolean(scripts['check-reminders']),
    cancelReminder: Boolean(scripts['cancel-reminder']),
    updateReminder: Boolean(scripts['update-reminder']),
    memories: Boolean(scripts.memories),
    remember: Boolean(scripts.remember),
    updateMemory: Boolean(scripts['update-memory']),
    forgetMemory: Boolean(scripts['forget-memory']),
    realtime: Boolean(scripts.realtime),
    talk: Boolean(scripts.talk),
    voice: Boolean(scripts.voice),
  };
  const context = summarizeSharedContext(events, {
    bootstrapFiles: runtime.bootstrap.files,
    localTaskRouter: { handledLocally: LOCAL_TASK_ROUTER_HANDLED_LOCALLY },
    memories: runtime.memoryStore.list(),
    reminders: runtime.reminderStore.list(),
  });
  const contextHandledLocally = context.localTaskRouter.handledLocally || [];
  const docs = {
    readme: fs.existsSync(path.join(process.cwd(), 'README.md')),
    systemDesign: fs.existsSync(path.join(process.cwd(), 'docs', 'system-design.md')),
    cliRuntime: fs.existsSync(path.join(process.cwd(), 'docs', 'cli-runtime.md')),
  };
  const systemDesignText = docs.systemDesign
    ? fs.readFileSync(path.join(process.cwd(), 'docs', 'system-design.md'), 'utf8')
    : '';
  docs.localTaskRouter = systemDesignText.includes('Local Task Router')
    && systemDesignText.includes('本地确定性任务路由');
  const voiceLoopText = fs.existsSync(path.join(process.cwd(), 'src', 'voiceLoop.js'))
    ? fs.readFileSync(path.join(process.cwd(), 'src', 'voiceLoop.js'), 'utf8')
    : '';
  const singleAudioOutlet = {
    systemDesignConstraint: systemDesignText.includes('单一播报出口'),
    backgroundAnnouncementsUseRealtimeOutlet: voiceLoopText.includes("outlet: 'realtime'")
      && voiceLoopText.includes('this.realtime.createUserTextMessage'),
    correlatesAnnouncementsToRealtimeResponses: voiceLoopText.includes('this.activeAnnouncement')
      && voiceLoopText.includes('backgroundTaskId: this.activeAnnouncement?.backgroundTaskId'),
  };
  const review = {
    phase: 'phase_1_no_ui_cli',
    createdAt: new Date().toISOString(),
    ready: preflightReport.ready
      && Object.values(routing).every(Boolean)
      && Object.values(commandSurface).every(Boolean)
      && Object.values(singleAudioOutlet).every(Boolean)
      && Object.values(docs).every(Boolean),
    checks: {
      preflight: preflightReport,
      routing,
      commandSurface,
      observability: {
        eventLogPath: runtime.config.eventLogPath,
        eventCount: events.length,
        lastEventType: events.at(-1)?.type || null,
      },
      sharedContext: {
        contextVersion: context.contextVersion,
        turns: context.turns.total,
        backgroundTasks: context.backgroundTasks.total,
        localTaskRouter: {
          handledLocally: contextHandledLocally,
          coversReminderCancel: contextHandledLocally.includes('cancel_reminder'),
          coversMemoryCrud: contextHandledLocally.includes('memory')
            && contextHandledLocally.includes('update_memory')
            && contextHandledLocally.includes('forget_memory'),
        },
        reminders: context.reminders.total,
        memories: context.longTermMemory.total,
      },
      singleAudioOutlet,
      docs,
    },
  };
  if (writeReport) {
    const reportPath = path.join(runtime.config.dataDir, 'reviews', `phase-1-review-${reviewTimestamp()}.json`);
    review.reportPath = reportPath;
    writeTextFileAtomic(reportPath, `${JSON.stringify(review, null, 2)}\n`);
  }
  emitEvent('review.completed', {
    phase: review.phase,
    ready: review.ready,
    reportPath: review.reportPath || null,
  });
  console.log(JSON.stringify(review, null, 2));
}

async function listReminders() {
  const { reminderStore } = createRuntime({ requireApiKey: false });
  const reminders = reminderStore.list().sort((a, b) => {
    if (a.status === 'scheduled' && b.status !== 'scheduled') {
      return -1;
    }
    if (a.status !== 'scheduled' && b.status === 'scheduled') {
      return 1;
    }
    return Date.parse(a.remindAt || a.updatedAt || a.createdAt || 0) - Date.parse(b.remindAt || b.updatedAt || b.createdAt || 0);
  });
  console.log(JSON.stringify(reminders, null, 2));
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

async function updateReminder(id, args = []) {
  if (!id) {
    throw new Error('Usage: npm run update-reminder -- <id> --time <iso> [--title <title>] [--note <note>]');
  }
  const remindAt = getArgValue(args, '--time') || getArgValue(args, '--remind-at') || getArgValue(args, '--at');
  const title = getArgValue(args, '--title');
  const note = getArgValue(args, '--note');
  const patch = {};
  if (title?.trim()) {
    patch.title = title.trim();
  }
  if (note !== null) {
    patch.note = note.trim();
  }
  if (remindAt?.trim()) {
    const remindAtMs = Date.parse(remindAt);
    if (!Number.isFinite(remindAtMs)) {
      throw new Error(`Invalid reminder time: ${remindAt}`);
    }
    if (remindAtMs <= Date.now()) {
      throw new Error(`Reminder time is in the past: ${remindAt}`);
    }
    patch.remindAt = remindAt;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('Usage: npm run update-reminder -- <id> --time <iso> [--title <title>] [--note <note>]');
  }
  const { reminderStore } = createRuntime({ requireApiKey: false, printEvents: false });
  const existing = reminderStore.list().find((reminder) => reminder.id === id);
  if (!existing || existing.status !== 'scheduled') {
    throw new Error(`Scheduled reminder not found: ${id}`);
  }
  const reminder = reminderStore.update(id, patch);
  emitEvent('reminder.updated', { reminder, patch });
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
    '  npm run status            Print local runtime status and routing boundary without network calls.',
    '  npm run events            Print recent structured runtime events.',
    '  npm run events:follow     Follow structured runtime events as they arrive.',
    '  npm run events -- --type response.completed',
    '  npm run events -- --turn-id turn_xxx',
    '  npm run events -- --source-turn-id turn_xxx',
    '  npm run events -- --background-task-id task_xxx',
    '  npm run events -- --since 2026-06-20T12:00:00Z',
    '  npm run event-summary     Summarize structured runtime events.',
    '  npm run errors            Summarize recent error events.',
    '  npm run timeline          Print a normalized runtime timeline.',
    '  npm run timeline -- --turn-id turn_xxx',
    '  npm run timeline -- --background-task-id task_xxx',
    '  npm run tasks             Summarize background tasks from event logs.',
    '  npm run task-detail -- <task_id>',
    '  npm run runtime-state     Reconstruct client runtime state from event logs.',
    '  npm run context           Reconstruct Shared Context from runtime data.',
    '  npm run turns             Reconstruct recent user/assistant turns from event logs.',
    '  npm run transcript        Print recent conversation turns as text.',
    '  npm run route -- <text>   Show whether text stays realtime or delegates to a task.',
    '  npm run task -- <text>    Run one delegated task and print JSON.',
    '  npm run scenario -- <turn1> <turn2>',
    '  npm run bootstrap         Print runtime agent bootstrap status.',
    '  npm run audio             Check local audio recorder/player commands.',
    '  npm run audio:probe       Probe microphone capture without network calls.',
    '  npm run preflight         Check local readiness before starting voice.',
    '  npm run preflight -- --probe-audio',
    '  npm run review            Run local Phase 1 no-UI CLI review.',
    '  npm run review:report     Run Phase 1 review and write a local report artifact.',
    '  npm run reminders         List local reminders without network calls.',
    '  npm run check-reminders   Trigger due local reminders once without starting voice.',
    '  npm run cancel-reminder -- <id>',
    '  npm run update-reminder -- <id> --time <iso>',
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
      since: getArgValue(args, '--since'),
      turnId: getArgValue(args, '--turn-id'),
      sourceTurnId: getArgValue(args, '--source-turn-id'),
      backgroundTaskId: getArgValue(args, '--background-task-id'),
    });
  } else if (args[0] === '--event-summary') {
    await eventSummary();
  } else if (args[0] === '--errors') {
    await errorSummary({ count: getEventCount(args) });
  } else if (args[0] === '--timeline') {
    await timeline({
      count: getEventCount(args),
      type: getArgValue(args, '--type'),
      since: getArgValue(args, '--since'),
      turnId: getArgValue(args, '--turn-id'),
      sourceTurnId: getArgValue(args, '--source-turn-id'),
      backgroundTaskId: getArgValue(args, '--background-task-id'),
    });
  } else if (args[0] === '--tasks') {
    await taskSummary({ count: getEventCount(args) });
  } else if (args[0] === '--task-detail') {
    await taskDetail(args[1]);
  } else if (args[0] === '--runtime-state') {
    await runtimeState();
  } else if (args[0] === '--context') {
    await contextSummary();
  } else if (args[0] === '--turns') {
    await turnSummary({ count: getEventCount(args) });
  } else if (args[0] === '--transcript') {
    await transcript({ count: getEventCount(args) });
  } else if (args[0] === '--route') {
    await routeText(args.slice(1).join(' '));
  } else if (args[0] === '--task') {
    await taskText(args.slice(1).join(' '));
  } else if (args[0] === '--scenario') {
    await scenario(args.slice(1));
  } else if (args[0] === '--bootstrap') {
    await bootstrapStatus();
  } else if (args[0] === '--audio') {
    await audioStatus();
  } else if (args[0] === '--audio-probe') {
    await audioProbe({ durationMs: getPositiveNumberArg(args, '--duration-ms', 500) });
  } else if (args[0] === '--preflight') {
    await preflight({
      probeAudio: args.includes('--probe-audio'),
      durationMs: getPositiveNumberArg(args, '--duration-ms', 500),
    });
  } else if (args[0] === '--review') {
    await phaseOneReview();
  } else if (args[0] === '--review-report') {
    await phaseOneReview({ writeReport: true });
  } else if (args[0] === '--reminders') {
    await listReminders();
  } else if (args[0] === '--check-reminders') {
    await checkReminders();
  } else if (args[0] === '--cancel-reminder') {
    await cancelReminder(args[1]);
  } else if (args[0] === '--update-reminder') {
    await updateReminder(args[1], args.slice(2));
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
