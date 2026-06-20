#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import process from 'node:process';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import { getConfig } from './config.js';
import { DashScopeClient } from './dashscope.js';
import { DashScopeRealtimeClient } from './realtimeClient.js';
import { SharedContext } from './context.js';
import { ReminderStore } from './reminders.js';
import { BackgroundAgent } from './backgroundAgent.js';
import { CliInteractionModel } from './interactionModel.js';

const HEROS_INSTRUCTIONS = [
  '你是 HerOS，一个受到电影《HER》启发的个人 AI。',
  '你要像一个自然、温暖、聪明的长期伙伴一样对话，也要在需要时把复杂任务交给后台能力更强的 LLM/Agent。',
  '实时语音层优先保持低延迟、可打断、自然简洁；复杂推理、长期任务、工具执行由后台模型完成。',
  '默认使用中文，除非用户明确使用其他语言。',
].join('\n');

function createRuntime() {
  const config = getConfig();
  const client = new DashScopeClient({
    apiKey: config.dashscopeApiKey,
    baseUrl: config.dashscopeBaseUrl,
  });
  const context = new SharedContext();
  const reminderStore = new ReminderStore(config.dataDir);
  const backgroundAgent = new BackgroundAgent({
    client,
    model: config.backgroundModel,
    reminderStore,
    timeZone: config.timeZone,
  });
  const interactionModel = new CliInteractionModel({
    client,
    model: config.backgroundModel,
    backgroundAgent,
    context,
  });
  return { config, client, interactionModel, reminderStore };
}

function createRealtimeClient(config) {
  return new DashScopeRealtimeClient({
    apiKey: config.dashscopeApiKey,
    url: config.realtimeUrl,
    model: config.realtimeModel,
  });
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn('which', [command], { stdio: 'ignore' });
    child.on('close', (code) => resolve(code === 0));
  });
}

async function checkRealtime(config) {
  const realtime = createRealtimeClient(config);
  realtime.on('event', (event) => {
    if (['session.created', 'session.updated', 'error'].includes(event.type)) {
      console.log(`[realtime] ${event.type}`);
    }
  });
  await realtime.connect();
  realtime.updateSession({
    modalities: ['text', 'audio'],
    voice: config.realtimeVoice,
    instructions: HEROS_INSTRUCTIONS,
    turnDetection: null,
  });
  await realtime.waitFor('session.updated', 15000);
  realtime.close();
}

async function doctor() {
  const { config, client } = createRuntime();
  console.log(`DashScope base URL: ${config.dashscopeBaseUrl}`);
  console.log(`Realtime URL: ${config.realtimeUrl}`);
  console.log(`Realtime model: ${config.realtimeModel}`);
  console.log(`Realtime voice: ${config.realtimeVoice}`);
  console.log(`Background model: ${config.backgroundModel}`);
  console.log(`Time zone: ${config.timeZone}`);
  console.log(`Data dir: ${config.dataDir}`);
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

async function interactive() {
  const { interactionModel, reminderStore } = createRuntime();
  const rl = readline.createInterface({ input, output });
  console.log('HerOS CLI ready. Type /exit to quit, /reminders to list reminders.');
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
    try {
      const reply = await interactionModel.respond(text);
      console.log(`HerOS: ${reply}`);
    } catch (error) {
      console.error(`HerOS error: ${error.message}`);
    }
  }
  rl.close();
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
    instructions: HEROS_INSTRUCTIONS,
    turnDetection: null,
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
    '  npm run cli               Start typed CLI fallback.',
    '  npm run cli -- --talk     Record one voice turn with Qwen-Omni-Realtime.',
    '  npm run cli -- --once hi  Send one typed fallback turn.',
    '',
    'Environment:',
    '  DASHSCOPE_API_KEY         Required, usually in .env.local.',
    '  HEROS_REALTIME_MODEL      Default qwen3.5-omni-plus-realtime.',
    '  HEROS_BACKGROUND_MODEL    Default qwen3.7-plus.',
    '  HEROS_TIME_ZONE           Default system time zone.',
  ].join('\n'));
}

const args = process.argv.slice(2);
try {
  if (args[0] === '--doctor') {
    await doctor();
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
