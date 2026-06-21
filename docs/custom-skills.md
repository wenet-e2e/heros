# Custom Skills

HerOS custom skills use the same basic shape as standard Codex skills: a folder with a required `SKILL.md` file.

## Location

Put local skills under the runtime data directory:

```text
.heros/skills/<skill_id>/SKILL.md
```

If a local skill has the same `name` or `id` as a built-in skill, the local skill overrides the built-in one.

## Minimal Skill

```markdown
---
name: weather-advice
description: Use when the user asks for weather-aware suggestions, clothing advice, or outdoor planning.
---

# Weather Advice

Help the user reason about weather-sensitive plans.

Ask for the city if it is missing. Keep spoken answers short, practical, and location-aware.
```

With only `name` and `description`, HerOS will:

- discover the skill,
- inject the skill summary into Shared Context,
- include the skill body in Background Agent skill instructions,
- expose the skill through `npm run skills`.

## Optional HerOS Fields

HerOS also supports optional frontmatter fields for runtime capability metadata:

```markdown
---
name: weather-advice
description: Use when the user asks for weather-aware suggestions, clothing advice, or outdoor planning.
version: 0.1.0
status: enabled
triggers:
  - 天气
  - 出门
  - 穿什么
capabilities:
  - type: weather_advice
    description: Give weather-aware advice.
    handler: background_agent
    risk: low
tools:
  - name: weather_lookup
    description: Look up weather before giving advice.
    risk: low
---

# Weather Advice

Ask for city when missing. Prefer concise advice that can be spoken aloud.
```

Supported values:

- `status`: `enabled` or `disabled`.
- `handler`: `background_agent` or `local_task_router`.
- `risk`: `low`, `medium`, or `high`.

## Current Runtime Boundary

Custom skills are discoverable and available in realtime/background context today. They do not automatically install arbitrary executable tools yet.

For now:

- Use `SKILL.md` to add domain behavior, routing hints, and background-agent instructions.
- Built-in executable task abilities are still reminders and memory.
- New executable tools need code support before they can perform side effects.

## Verify

Run:

```bash
npm run skills
npm run skills -- weather-advice
npm run agent-context -- "出门要穿什么"
npm run context-health
```
