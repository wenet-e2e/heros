#!/usr/bin/env node
import { createRuntime } from '../src/runtime.js';
import { DashScopeRealtimeClient } from '../src/realtimeClient.js';

const runtime = createRuntime();
const realtime = new DashScopeRealtimeClient({
  apiKey: runtime.config.dashscopeApiKey,
  url: runtime.config.realtimeUrl,
  model: runtime.config.realtimeModel,
});

let transcript = '';
realtime.on('event', (event) => {
  if (event.type === 'response.audio_transcript.delta') {
    transcript += event.delta || '';
  }
});

await realtime.connect();
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
realtime.createUserTextMessage('请用一句自然的中文短句说：HerOS realtime smoke ok。');
realtime.createResponse();
await realtime.waitFor('response.done', 30000);
realtime.close();

if (!transcript.trim()) {
  throw new Error('Realtime smoke did not return an audio transcript');
}

console.log(transcript);
