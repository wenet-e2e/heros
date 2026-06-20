# HerOS CLI Runtime

Phase 1 uses a no-UI CLI to validate the core runtime before any desktop UI work.

## Commands

- `npm run check`: syntax checks and local smoke tests.
- `npm run verify`: full local + DashScope verification.
- `npm run smoke:background`: network smoke test for Background Agent reminder creation and update in a temp data dir.
- `npm run smoke:realtime`: network smoke test for realtime text injection and spoken transcript.
- `npm run doctor`: checks DashScope Realtime and Background LLM connectivity.
- `npm run status`: prints local runtime status and local task routing boundary without network calls.
- `npm run events`: prints recent structured runtime events.
- `npm run events:follow`: follows structured runtime events as they arrive.
- `npm run events -- --type response.completed`: filters recent structured runtime events by type.
- `npm run events -- --turn-id turn_xxx`: filters recent structured runtime events by turn.
- `npm run events -- --source-turn-id turn_xxx`: filters recent structured runtime events by source turn.
- `npm run events -- --background-task-id task_xxx`: filters recent structured runtime events by background task.
- `npm run events -- --since <iso-or-ms>`: filters recent structured runtime events by creation time.
- `npm run events:follow -- --type state.changed`: follows only matching structured runtime events.
- `npm run event-summary`: summarizes structured runtime events by type.
- `npm run errors`: summarizes recent structured error events.
- `npm run timeline`: prints a normalized runtime timeline for no-UI review and later desktop UI mapping.
- `npm run timeline -- --turn-id turn_xxx`: filters the normalized timeline by turn, background task, event type, or time window.
- `npm run tasks`: summarizes recent background tasks reconstructed from structured runtime events.
- `npm run task-detail -- <task_id>`: prints one background task's related turns and event timeline.
- `npm run session-report`: writes a no-UI runtime session report artifact with turns, timeline, tasks, errors, Shared Context, and runtime state.
- `node src/cli.js --session-report --since <iso-or-ms>`: prints a filtered session report without writing an artifact.
- `npm run runtime-state`: reconstructs the current client runtime state from structured runtime events.
- `npm run context`: reconstructs the current Shared Context view from event logs and local runtime data.
- `npm run turns`: reconstructs recent user/assistant turns from structured runtime events.
- `npm run turns -- --turn-id turn_xxx`: filters reconstructed turns by turn, source turn, background task, event type, or time window.
- `npm run transcript`: prints recent conversation turns as readable text.
- `npm run transcript -- --source-turn-id turn_xxx`: filters readable transcript output with the same event filters.
- `npm run route -- <text>`: shows whether text stays in realtime or delegates to a task path.
- `npm run task -- <text>`: runs one delegated task and prints a clean JSON result.
- `npm run scenario -- <turn1> <turn2>`: replays multiple text turns in one Shared Context without microphone input.
- `npm run bootstrap`: prints runtime agent bootstrap status.
- `npm run audio`: checks local audio recorder/player command availability without network calls.
- `npm run audio:probe -- --duration-ms 500`: optionally probes microphone capture without network calls; failures usually point to local microphone permission or device selection.
- `npm run preflight`: checks local voice-loop readiness without network calls.
- `npm run preflight -- --probe-audio --duration-ms 500`: includes a local microphone capture probe in preflight.
- `npm run review`: runs a local Phase 1 no-UI CLI review without network calls.
- `npm run review:report`: runs the Phase 1 review and writes a JSON artifact under `.heros/reviews/`.
- `npm run reminders`: lists local reminders without network calls.
- `npm run check-reminders`: triggers due local reminders once without starting voice.
- `npm run cancel-reminder -- <id>`: cancels one scheduled local reminder without network calls.
- `npm run update-reminder -- <id> --time <iso>`: updates one scheduled local reminder without network calls.
- `npm run memories`: lists long-term memories without network calls.
- `npm run remember -- <content>`: creates one long-term memory without network calls.
- `npm run update-memory -- <id> <content>`: updates one long-term memory without network calls.
- `npm run forget-memory -- <id>`: deletes one long-term memory without network calls.
- `npm run realtime -- <text>`: sends one text turn through Qwen-Omni-Realtime without microphone input.
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
- Doctor emits structured started/ok/failed/completed events for connectivity checks.
- Headless local audio command availability check.
- Optional headless microphone capture probe for local audio permission/device checks.
- Realtime connection retry events for transient WebSocket startup failures.
- Headless realtime text turn for no-microphone Qwen-Omni-Realtime debugging.
- Continuous VAD voice loop with microphone input and PCM audio output.
- User interrupt handling by cancelling the active realtime response.
- New user speech cancels active Background Agent delegations so stale tasks cannot complete after interruption.
- Voice loop shutdown cancels active Background Agent delegations before waiting for cleanup.
- Background Agent checks cancellation before tool execution so interrupted tasks cannot create stale reminders.
- Background Agent receives a rich context package with Shared Context, scheduled reminders, memory, and runtime metadata.
- Shared Context summaries expose the Local Task Router capability boundary used before Background Agent delegation.
- Shared Context updates from typed turns and realtime transcripts.
- Runtime startup hydrates recent Shared Context turns and background tasks from the event log.
- Runtime startup preserves pending clarification state reconstructed from local task event logs.
- Pending clarification lookup uses the latest pending task in Shared Context so later non-pending task summaries do not hide it.
- Runtime status and Shared Context summaries count only unresolved pending clarifications; a newer task of the same type supersedes older pending state.
- Realtime session instructions include agent bootstrap context and long-term memory summaries.
- Background reminder delegation through a shared TaskRouter.
- Background Agent reminder creation and update are covered by a temp-dir network smoke.
- Background Agent emits `agent.started` and `agent.completed` lifecycle events around model decisions.
- Background Agent emits `background_task.progress` after model decisions for CLI/UI progress mapping.
- Background Agent delegation has a timeout guard and emits cancellation events when a task runs too long.
- Background Agent unexpected failures emit structured failed events for error summaries.
- Background LLM requests preserve external cancellation reasons instead of collapsing them into request timeouts.
- Background and local-router clarification results are tracked as `needs_clarification` events/context.
- Reminder clarification follow-up utterances continue the pending Background Agent task path.
- Local pending clarification follow-up utterances continue cancellation and memory task paths.
- Ambiguous task results are treated as pending clarification for follow-up routing.
- Background task result announcements through the same realtime audio outlet.
- Local reminder creation, validation, scheduling, and trigger events.
- Background Agent reminder creation emits reminder lifecycle events.
- Local reminders keep created/updated timestamps and list scheduled items by reminder time.
- Headless one-shot due reminder trigger checks.
- Local reminder and memory files use atomic writes to reduce partial-write corruption.
- Headless local reminder listing, update, and cancellation commands.
- Headless local reminder and memory mutations write structured events without polluting JSON output.
- Reminder cancellation is limited to scheduled reminders so historical triggered records are not rewritten.
- Natural-language scheduled reminder listing and next-reminder query.
- Background-agent reminder updates for natural-language schedule changes.
- Explicit natural-language reminder cancellation when a single scheduled reminder matches, including next-reminder cancellation.
- Due reminder announcements through the same realtime audio outlet when the voice loop is running.
- Due reminder announcements include reminder IDs for event-log correlation.
- Stale background announcements are skipped when the user starts a newer voice turn.
- Runtime `MEMORY.md` CRUD, explicit natural-language memory creation/listing/update, and safe natural-language memory deletion.
- Natural-language memory update and deletion can ask for missing details and continue from the follow-up utterance.
- Headless long-term memory CRUD commands.
- Agent bootstrap files are copied into the runtime data dir and injected into CLI/background model prompts.
- Headless agent bootstrap status command.
- Structured event logging to `events.ndjson`.
- Event log filtering, including time-window filtering, and summary commands for CLI debugging and later UI state mapping.
- Event log follow mode for live CLI debugging and later desktop UI event-stream mapping.
- Headless voice-loop preflight for API key, audio commands, writable runtime data, and bootstrap files.
- Optional microphone capture probe in preflight for local permission/device diagnostics.
- Headless Phase 1 review for local readiness, core routing matrix, observability, Shared Context, and docs.
- Phase 1 review checks that the system design records the Local Task Router boundary.
- Phase 1 review checks that the single audio outlet constraint is documented and mapped through the realtime announcement path.
- Phase 1 review checks the interruption path for realtime response cancellation, Background Agent cancellation, and stale announcement skipping.
- Phase 1 review covers bare and pending reminder cancellation routing, pending memory update routing, and pending memory deletion routing.
- Phase 1 review also checks the Phase 1 CLI command surface for no-UI regression coverage.
- Headless Phase 1 review report artifacts for milestone checks and later desktop handoff.
- Phase 1 review completion emits a structured event for CLI and later UI observability.
- Error summary command reconstructed from structured runtime events.
- Normalized runtime timeline command reconstructed from structured runtime events.
- Timeline command supports the same turn, background task, event type, and time-window filters as raw event inspection.
- Timeline summaries resolve task types across events with the same background task ID, so completed and announcement entries keep task context.
- Background task summary command reconstructed from event logs for CLI milestone review.
- Background task detail command reconstructs one task's related turns, normalized timeline, and raw event list.
- No-UI session report command writes milestone artifacts with event, turn, task, timeline, error, Shared Context, and runtime state summaries.
- Runtime status includes audio, next reminder, local task router boundary, pending clarification details, review report/event, session report/event, turn, error, and background task summaries.
- Runtime status exposes the latest event, turn, and background task pointers from the reconstructed runtime state.
- Runtime state summary reconstructed from event logs for CLI milestone review and later desktop UI mapping.
- Shared Context summary reconstructed from event logs, reminders, memory, and bootstrap files.
- Shared Context and Phase 1 review expose which deterministic task types are handled locally before Background Agent delegation.
- Turn summary command reconstructed from transcript and response events for CLI conversation replay.
- Readable transcript command for quick no-UI conversation review.
- Turn summary and transcript commands support the shared event filters for focused no-UI replay.
- Headless routing check for realtime-direct vs task delegation decisions.
- Headless delegated task runner for JSON verification without entering the interactive CLI.
- Headless delegated task runner emits assistant response events for transcript replay.
- Headless delegated task runner preserves pending local clarification state across separate CLI invocations.
- Headless scenario replay runs multiple text turns in one Shared Context for no-microphone regression checks.
- Headless scenario replay covers pending reminder cancellation and pending memory deletion follow-ups.
- Headless task and scenario JSON output includes pending task routing metadata for multi-turn debugging.
- Turn IDs on conversation turns and response/transcript events.
- Typed CLI fallback emits transcript and response turn events for conversation replay.
- Background task response events include their `backgroundTaskId` for CLI/UI correlation.
- Realtime announcement response events include their background task source, ID, and source turn.
- Background task correlation IDs and triggering turn IDs across request, execution, tool call, and completion events.
- Secret redaction before structured events are printed/persisted or written into Shared Context, including secret-like field names.
- Voice loop state transitions, including `background_running`, as `state.changed` events for later desktop UI mapping.
- Key `state.changed` events carry turn metadata so background-running, interruption, and response-done states can be correlated with conversation turns.
- Voice loop startup failures emit structured failure and `error` state events before cleanup.

## Environment

Required:

- `DASHSCOPE_API_KEY`

Common overrides:

- `DASHSCOPE_BASE_URL`
- `DASHSCOPE_REQUEST_TIMEOUT_MS`
- `HEROS_REALTIME_URL`
- `HEROS_REALTIME_MODEL`
- `HEROS_REALTIME_VOICE`
- `HEROS_REALTIME_INPUT_TRANSCRIPTION_MODEL`
- `HEROS_REALTIME_TURN_DETECTION` (default `semantic_vad`)
- `HEROS_REALTIME_VAD_THRESHOLD`
- `HEROS_REALTIME_VAD_PREFIX_PADDING_MS`
- `HEROS_REALTIME_VAD_SILENCE_DURATION_MS`
- `HEROS_REALTIME_CONNECT_RETRIES` (default `2`)
- `HEROS_REALTIME_CONNECT_RETRY_DELAY_MS` (default `500`)
- `HEROS_BACKGROUND_MODEL`
- `HEROS_BACKGROUND_TASK_TIMEOUT_MS` (default `60000`)
- `HEROS_TIME_ZONE`
- `HEROS_REMINDER_POLL_MS`
- `HEROS_DATA_DIR`
- `HEROS_EVENT_LOG_PATH`

See `.env.example` for a local template.
