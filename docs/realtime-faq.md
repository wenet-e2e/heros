# Realtime FAQ

## Why can a response tail be played at the beginning of the next response?

Symptom:

- The current assistant reply sounds truncated.
- The missing tail is not lost; it is played at the beginning of the next assistant reply.
- This was easiest to reproduce around short filler speech before a background handoff.

Root cause:

- `response.done` only means the realtime service finished sending the response events.
- It does not mean the local CLI playback backend has fully drained audio to the device.
- The CLI originally started and ended a SoX `play` process per response. That made handoff timing depend on process close semantics instead of actual playback drain.
- After switching to one long-lived SoX stream, SoX/raw-pipe buffering could still hold a small PCM tail. If the stream was not flushed at a response boundary, the tail could be released when the next response wrote more PCM.

Fix:

- Keep a long-lived SoX `play` stream for the CLI voice session.
- Maintain a local playback cursor from written PCM bytes, similar to a browser `AudioContext` playback cursor.
- Make handoff scheduling wait for the local playback cursor before sending the final background result back to realtime speech.
- Use a small SoX buffer.
- At each response boundary, write a short silence tail to flush SoX pipe buffering so the final speech frames are pushed through before the next response begins.
- Add a short configurable post-filler pause with `HEROS_HANDOFF_POST_FILLER_PAUSE_MS`.

Relevant files:

- `src/audio.js`: long-lived player, playback cursor, silence flush.
- `src/voiceLoop.js`: controlled filler, background handoff wait, result speech scheduling.
- `src/realtimeClient.js`: `response.create` payload support and `createSpeechResponse()`.
- `src/config.js` and `.env.example`: post-filler pause config.

Verification:

- `npm run check`
- `npm run gate`
- `npm run context-health`

The important lesson is that realtime protocol completion and local audio playback completion are different clocks. The interaction model should not start the next spoken result until the local playback clock has drained.
