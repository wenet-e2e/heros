# HerOS CLI Runtime

Phase 1 uses a no-UI CLI to validate the core runtime before any desktop UI work.

## Commands

- `npm run check`: syntax checks and local smoke tests.
- `npm run verify`: full local + DashScope verification.
- `npm run smoke:realtime`: network smoke test for realtime text injection and spoken transcript.
- `npm run doctor`: checks DashScope Realtime and Background LLM connectivity.
- `npm run status`: prints local runtime status without network calls.
- `npm run events`: prints recent structured runtime events.
- `npm run events -- --type response.completed`: filters recent structured runtime events by type.
- `npm run event-summary`: summarizes structured runtime events by type.
- `npm run voice`: starts the continuous realtime voice loop. This is the primary Phase 1 runtime path.
- `npm run voice -- --no-play --duration-ms 3000`: starts a short no-play voice loop smoke.
- `npm run talk`: records one manual voice turn for focused realtime debugging.
- `npm run cli`: starts the typed CLI fallback.

## Runtime Data

Local runtime data is written under `.heros/` by default and is ignored by git:

- `events.ndjson`: structured runtime event log.
- `reminders.json`: local reminder data.
- `agent-bootstrap/`: runtime copies of `AGENTS.md`, `SOUL.md`, and `MEMORY.md`.

## Typed CLI Commands

- `/reminders`: list reminders.
- `/help`: list typed CLI commands.
- `/cancel-reminder <id>`: cancel a scheduled reminder.
- `/memory`: list long-term memories.
- `/remember <content>`: create a long-term memory.
- `/update-memory <id> <content>`: update a long-term memory.
- `/forget <id>`: delete a long-term memory.

## Current Phase 1 Status

Implemented:

- DashScope Realtime WebSocket session check.
- Continuous VAD voice loop with microphone input and PCM audio output.
- User interrupt handling by cancelling the active realtime response.
- Shared Context updates from typed turns and realtime transcripts.
- Background reminder delegation through a shared TaskRouter.
- Background task result announcements through the same realtime audio outlet.
- Local reminder creation, validation, scheduling, and trigger events.
- Explicit natural-language reminder cancellation when a single scheduled reminder matches.
- Due reminder announcements through the same realtime audio outlet when the voice loop is running.
- Runtime `MEMORY.md` CRUD and explicit natural-language memory requests.
- Structured event logging to `events.ndjson`.
- Event log filtering and summary commands for CLI debugging and later UI state mapping.
- Background task correlation IDs across request, execution, tool call, and completion events.
- Basic secret redaction before structured events are printed/persisted or written into Shared Context.
- Voice loop state transitions as `state.changed` events for later desktop UI mapping.

## Environment

Required:

- `DASHSCOPE_API_KEY`

Common overrides:

- `HEROS_REALTIME_MODEL`
- `HEROS_REALTIME_TURN_DETECTION` (default `semantic_vad`)
- `HEROS_BACKGROUND_MODEL`
- `HEROS_TIME_ZONE`
- `HEROS_DATA_DIR`
- `HEROS_EVENT_LOG_PATH`

See `.env.example` for a local template.
