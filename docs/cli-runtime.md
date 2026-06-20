# HerOS CLI Runtime

Phase 1 uses a no-UI CLI to validate the core runtime before any desktop UI work.

## Commands

- `npm run check`: syntax checks and local smoke tests.
- `npm run doctor`: checks DashScope Realtime and Background LLM connectivity.
- `npm run status`: prints local runtime status without network calls.
- `npm run voice`: starts the continuous realtime voice loop.
- `npm run talk`: records one manual voice turn.
- `npm run cli`: starts the typed CLI fallback.

## Runtime Data

Local runtime data is written under `.heros/` by default and is ignored by git:

- `events.ndjson`: structured runtime event log.
- `reminders.json`: local reminder data.
- `agent-bootstrap/`: runtime copies of `AGENTS.md`, `SOUL.md`, and `MEMORY.md`.

## Environment

Required:

- `DASHSCOPE_API_KEY`

Common overrides:

- `HEROS_REALTIME_MODEL`
- `HEROS_BACKGROUND_MODEL`
- `HEROS_TIME_ZONE`
- `HEROS_DATA_DIR`
- `HEROS_EVENT_LOG_PATH`
