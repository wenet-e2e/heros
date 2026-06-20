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

function createRealtimeClient(config) {
  return new DashScopeRealtimeClient({
    apiKey: config.dashscopeApiKey,
    url: config.realtimeUrl,
    model: config.realtimeModel,
  });
}

async function checkRealtime(config) {
  const realtime = createRealtimeClient(config);
  const logSessionEvent = (event) => {
    if (['session.created', 'session.updated', 'error'].includes(event.type)) {
      console.log(`[realtime] ${event.type}`);
    }
  };
  realtime.on('event', logSessionEvent);
  await realtime.connect();
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
  console.log(`DashScope base URL: ${config.dashscopeBaseUrl}`);
  console.log(`DashScope request timeout: ${config.dashscopeRequestTimeoutMs}ms`);
  console.log(`Realtime URL: ${config.realtimeUrl}`);
  console.log(`Realtime model: ${config.realtimeModel}`);
  console.log(`Realtime voice: ${config.realtimeVoice}`);
  console.log(`Background model: ${config.backgroundModel}`);
  console.log(`Time zone: ${config.timeZone}`);
  console.log(`Reminder poll interval: ${config.reminderPollMs}ms`);
  console.log(`Data dir: ${config.dataDir}`);
  console.log(`Event log path: ${config.eventLogPath}`);
  console.log(`Agent bootstrap dir: ${bootstrap.targetDir}`);
  console.log('Checking realtime WebSocket session...');
  await checkRealtime(config);
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
  console.log(`Background LLM OK: ${reply}`);
}

async function once(text) {
  const { interactionModel } = createRuntime();
  const reply = await interactionModel.respond(text);
  console.log(`HerOS: ${reply}`);
}

async function status() {
  const { config, reminderStore, memoryStore, bootstrap } = createRuntime();
  const reminders = reminderStore.list();
  const remindersByStatus = reminders.reduce((acc, reminder) => {
    acc[reminder.status] = (acc[reminder.status] || 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({
    realtimeModel: config.realtimeModel,
    backgroundModel: config.backgroundModel,
    timeZone: config.timeZone,
    dataDir: config.dataDir,
    eventLogPath: config.eventLogPath,
    bootstrapDir: bootstrap.targetDir,
    bootstrapFiles: bootstrap.files.length,
    reminders: {
      total: reminders.length,
      byStatus: remindersByStatus,
    },
    memories: {
      total: memoryStore.list().length,
    },
  }, null, 2));
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
      if (text === '/reminders') {
        console.log(JSON.stringify(reminderStore.list(), null, 2));
        continue;
      }
      if (text === '/memory') {
        console.log(JSON.stringify(memoryStore.list(), null, 2));
        interactionModel.context.setLongTermMemory(memoryStore.list());
        continue;
      }
      if (text.startsWith('/remember ')) {
        const memory = memoryStore.create(text.slice('/remember '.length));
        interactionModel.context.setLongTermMemory(memoryStore.list());
        console.log(`Remembered: ${memory.id}`);
        continue;
      }
      if (text.startsWith('/forget ')) {
        const deleted = memoryStore.delete(text.slice('/forget '.length).trim());
        interactionModel.context.setLongTermMemory(memoryStore.list());
        console.log(deleted ? 'Forgotten.' : 'Memory not found.');
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

async function voiceLoop({ playAudio = true } = {}) {
  const runtime = createRuntime();
  const realtime = createRealtimeClient(runtime.config);
  runtime.reminderScheduler.start();
  const loop = new VoiceLoop({
    config: runtime.config,
    realtime,
    taskRouter: runtime.taskRouter,
    context: runtime.interactionModel.context,
    reminderScheduler: runtime.reminderScheduler,
    playAudio,
  });
  try {
    await loop.start();
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

  await realtime.connect();
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
    '  npm run cli               Start typed CLI fallback.',
    '  npm run voice             Start continuous realtime voice loop.',
    '  npm run cli -- --talk     Record one voice turn with Qwen-Omni-Realtime.',
    '  npm run cli -- --once hi  Send one typed fallback turn.',
    '',
    'Environment:',
    '  DASHSCOPE_API_KEY         Required, usually in .env.local.',
    '  HEROS_REALTIME_MODEL      Default qwen3.5-omni-plus-realtime.',
    '  HEROS_BACKGROUND_MODEL    Default qwen3.7-plus.',
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
  } else if (args[0] === '--voice-loop') {
    await voiceLoop({ playAudio: args[1] !== '--no-play' });
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
