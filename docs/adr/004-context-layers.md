# ADR-004: Context as layers, not a single system prompt

## Status

Accepted, 2026-04.

## Context

The naive harness concatenates everything an agent needs to know — role,
project conventions, tool descriptions, recent tool results — into one giant
system prompt string. That works until you need to:

- Keep project rules separate from the base role prompt so they can be loaded
  from repository files (`AGENTS.md` / `CLAUDE.md`) instead of repeated in
  every user prompt.
- Inject environment feedback (a failing typecheck) that should be _visible
  to the agent but not part of its role_.
- Swap the tool list without resending the role every turn.
- Audit which piece of the prompt caused a given behavior.

A flat string loses every one of those affordances.

## Decision

The session's context is modeled as a stack of **layers**, each owned by a
different subsystem and each with its own lifecycle:

| Layer         | Owned by                                    | Lifecycle            |
| ------------- | ------------------------------------------- | -------------------- |
| `instruction` | `SessionConfig.system`                      | constant per session |
| `project`     | `loadAgentsMd()` via CLI prompt composition | per session          |
| `tools`       | `ToolRegistry.specs()`                      | constant per session |
| `state`       | `{runId, cwd, permissionMode, tokens}`      | updated per turn     |
| `query`       | `messages[]`                                | appended per turn    |
| `memory`      | `pendingReminders[]` (sensor + hook msgs)   | consumed next turn   |

The loop composes them on each `runTurn` call by:

1. Pulling the stable `instruction` + project guide + `tools` into the
   provider-specific system / tools slot.
2. Draining `pendingReminders` as fresh `role: "user"` messages **before**
   calling the adapter. This is how sensor feedback and hook `systemMessage`
   returns get injected without polluting the assistant turn.
3. Letting `query` grow append-only across turns.

## Consequences

**Good**:

- Sensor feedback is first-class: it's a layer with a documented lifecycle,
  not a mystery string that appears in the system prompt.
- `AGENTS.md` is explicit context, not ambient magic hidden in user prompts.
  Today the CLI loads it once per session; per-tool nested refresh can be
  added later without changing the message model.
- Every event in the log can be traced to a layer. When the agent does
  something weird, you know which layer to blame.
- The provider adapter receives a clean `{system, messages, tools}` — it
  doesn't need to understand layers at all.

**Bad / accepted**:

- Reasoning about what the model sees in any given turn requires knowing the
  drain order of `pendingReminders`. Documented in `docs/architecture.md`.
- Sensor feedback as a "user" message is a small lie: it's not from the user,
  it's from the environment. The alternative (a dedicated role) would break
  compatibility with provider message schemas. Wrapping the content in
  `<sensor-feedback sensor="..." />` tags mitigates this — the agent can tell
  the difference.
- We haven't implemented a `knowledge` (RAG) layer. The slot is reserved in
  `docs/architecture.md` but unimplemented; adding it is additive.
