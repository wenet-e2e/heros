# HerOS CLI Runtime

Phase 1 uses a no-UI CLI to validate the core runtime before any desktop UI work.

## Commands

- `npm run check`: syntax checks and local smoke tests.
- `npm run verify`: full local + DashScope verification.
- `npm run smoke:background`: network smoke test for Background Agent reminder creation in a temp data dir.
- `npm run smoke:realtime`: network smoke test for realtime text injection and spoken transcript.
- `npm run doctor`: checks DashScope Realtime and Background LLM connectivity.
- `npm run status`: prints local runtime status without network calls.
- `npm run events`: prints recent structured runtime events.
- `npm run events -- --type response.completed`: filters recent structured runtime events by type.
- `npm run events -- --turn-id turn_xxx`: filters recent structured runtime events by turn.
- `npm run events -- --background-task-id task_xxx`: filters recent structured runtime events by background task.
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
- `/context`: print the current Shared Context snapshot.
- `/help`: list typed CLI commands.
- `/cancel-reminder <id>`: cancel a scheduled reminder.
- `/memory`: list long-term memories.
- `/remember <content>`: create a long-term memory.
- `/update-memory <id> <content>`: update a long-term memory.
- `/forget <id>`: delete a long-term memory.

## Current Phase 1 Status

Implemented:

- DashScope Realtime WebSocket session check.
- Realtime connection retry events for transient WebSocket startup failures.
- Continuous VAD voice loop with microphone input and PCM audio output.
- User interrupt handling by cancelling the active realtime response.
- New user speech cancels active Background Agent delegations so stale tasks cannot complete after interruption.
- Voice loop shutdown cancels active Background Agent delegations before waiting for cleanup.
- Shared Context updates from typed turns and realtime transcripts.
- Realtime session instructions include agent bootstrap context and long-term memory summaries.
- Background reminder delegation through a shared TaskRouter.
- Background Agent reminder creation is covered by a temp-dir network smoke.
- Background Agent delegation has a timeout guard and emits cancellation events when a task runs too long.
- Background clarification results are tracked as `needs_clarification` in Shared Context.
- Background task result announcements through the same realtime audio outlet.
- Local reminder creation, validation, scheduling, and trigger events.
- Reminder cancellation is limited to scheduled reminders so historical triggered records are not rewritten.
- Natural-language scheduled reminder listing.
- Explicit natural-language reminder cancellation when a single scheduled reminder matches.
- Due reminder announcements through the same realtime audio outlet when the voice loop is running.
- Stale background announcements are skipped when the user starts a newer voice turn.
- Runtime `MEMORY.md` CRUD, explicit natural-language memory creation/listing, and safe natural-language memory deletion.
- Agent bootstrap files are copied into the runtime data dir and injected into CLI/background model prompts.
- Structured event logging to `events.ndjson`.
- Event log filtering and summary commands for CLI debugging and later UI state mapping.
- Turn IDs on conversation turns and response/transcript events.
- Background task response events include their `backgroundTaskId` for CLI/UI correlation.
- Background task correlation IDs and triggering turn IDs across request, execution, tool call, and completion events.
- Basic secret redaction before structured events are printed/persisted or written into Shared Context.
- Voice loop state transitions, including `background_running`, as `state.changed` events for later desktop UI mapping.

## Environment

Required:

- `DASHSCOPE_API_KEY`

Common overrides:

- `HEROS_REALTIME_MODEL`
- `HEROS_REALTIME_TURN_DETECTION` (default `semantic_vad`)
- `HEROS_REALTIME_CONNECT_RETRIES` (default `2`)
- `HEROS_REALTIME_CONNECT_RETRY_DELAY_MS` (default `500`)
- `HEROS_BACKGROUND_MODEL`
- `HEROS_BACKGROUND_TASK_TIMEOUT_MS` (default `60000`)
- `HEROS_TIME_ZONE`
- `HEROS_DATA_DIR`
- `HEROS_EVENT_LOG_PATH`

See `.env.example` for a local template.
