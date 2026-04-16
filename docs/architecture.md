# Architecture

This document is the long-form companion to the README's diagram. If you're
trying to understand how a single user prompt becomes file edits and back, read
this top to bottom; everything else in `src/` is implementation detail of the
loop described here.

## The whole story in 80 lines

```
SessionConfig {
  adapter, system, cwd, sink, input, tools?, policy?, hooks?, sensors?,
  workspaceRoot?, maxToolsPerUserTurn?, maxSubagentDepth?, signal?,
  on*Callbacks
}
        │
        ▼
runSession(cfg)                                       src/runtime/session.ts
  ├─ emit SessionStart event + hook
  ├─ open conversation messages = []
  │
  └─ userLoop:
        ├─ userInput = await cfg.input.next()        // null → end_reason="user_exit"
        ├─ dispatch UserPromptSubmit hook            // can block
        ├─ messages.push({role:"user", content:userInput})
        │
        └─ modelLoop:
              ├─ drain pendingReminders → user msgs   // sensor + hook feedback
              ├─ for-await event of adapter.runTurn({system, messages, tools}):
              │     text_delta → assistantText, emit AssistantTextDelta
              │     tool_call  → toolCalls.push(...)
              │     usage      → totalIn/Out += ...
              │     stop       → stopReason
              ├─ if assistantText or toolCalls:
              │     emit AssistantMessage; messages.push({role:"assistant", ...})
              ├─ emit Usage + Stop
              │
              ├─ if stopReason !== "tool_use": run after_turn sensors; break modelLoop
              │
              └─ for call of toolCalls:
                    ├─ emit ToolCall
                    ├─ tool = registry.get(call.name)        // "Unknown tool" if missing
                    ├─ parsed = tool.inputSchema.safeParse   // model gets validation error if bad
                    ├─ decision = policy.decide(...)         // allow|deny|ask
                    ├─ emit PolicyDecision
                    ├─ if !allow: synthesize "Denied by policy" tool result
                    ├─ dispatch PreToolUse hook              // can block
                    ├─ result = await tool.run(parsed, ctx)
                    ├─ emit ToolResult
                    ├─ messages.push({role:"tool", toolCallId, content})
                    ├─ dispatch PostToolUse / PostToolUseFailure hook
                    └─ run after_tool sensors                // results → pendingReminders
```

That's it. There is no orchestrator, no graph executor, no DAG. Two nested
`while`-loops and a discriminated union of events.

## Sequence — happy path with sensor feedback

```
user      cli           session         adapter         tool          sensor
 │  prompt  │             │               │              │              │
 │─────────▶│             │               │              │              │
 │          │  runSession │               │              │              │
 │          │────────────▶│               │              │              │
 │          │             │  runTurn      │              │              │
 │          │             │──────────────▶│              │              │
 │          │             │ ←text_delta   │              │              │
 │          │  ←onDelta   │               │              │              │
 │          │             │ ←tool_call    │              │              │
 │          │             │ ←stop tool_use│              │              │
 │          │             │ policy.decide │              │              │
 │          │             │ tool.run ────────────────────▶              │
 │          │             │ ←ToolResult ok                              │
 │          │             │ run after_tool sensors ─────────────────────▶
 │          │             │ ←sensor msg "type error in foo.ts"          │
 │          │             │ pendingReminders.push("<sensor-feedback…>") │
 │          │             │  runTurn (next iter)                        │
 │          │             │  msgs += {role:"user", content:reminder}    │
 │          │             │──────────────▶│              │              │
 │          │             │ ←text "fixing"│              │              │
 │          │             │ ←tool_call (edit_file)       │              │
 │          │             │ tool.run ────────────────────▶              │
 │          │             │ ←ok                                         │
 │          │             │ ←stop end_turn                              │
 │          │             │ break modelLoop                             │
 │          │             │ wait for next user input                    │
```

The key bit is `pendingReminders`. Sensors don't get to interrupt the loop
mid-turn; they queue feedback that gets prepended as a user message at the
start of the *next* model call. This keeps the conversation transcript well-
formed (every assistant turn is followed by tool results, then a fresh user
turn, never sensor noise spliced in the middle).

## Context layers (the "guides" half of the model)

The agent's prompt isn't one string — it's a stack of layers, each owned by a
different part of the system:

| Layer        | Owner                            | Lifetime          |
|--------------|----------------------------------|-------------------|
| `instruction`| `cfg.system`                     | per session       |
| `project`    | `AGENTS.md` resolved at PreToolUse| per file path    |
| `tools`      | `ToolRegistry.specs()`           | per session       |
| `state`      | run id, cwd, permission mode     | per session       |
| `query`      | `messages[]` (rolling)           | grows per turn    |
| `memory`     | sensor feedback + hook system msgs| consumed next turn|

This separation matters because each layer evolves on its own clock.
`AGENTS.md` is re-resolved per tool call so a nested override can take effect
without restarting the session. Sensor feedback is one-shot: once injected, it
becomes part of `query` and is never re-sent. Tool specs are computed once per
session — adding a tool mid-session would require rebuilding them.

## Sensors: computational vs inferential

Both implement the same interface, but the cost/latency profile is different:

```ts
type Sensor = {
  name: string;
  kind: "computational" | "inferential";
  trigger: "after_tool" | "after_turn" | "final";
  applicable?(ctx): Promise<boolean>;   // skip if config absent
  run(ctx): Promise<{ ok: boolean; message: string }>;
};
```

- **Computational** sensors run shell commands (`tsc --noEmit`, `eslint`,
  `vitest`). They're deterministic, fast (sub-second to a few seconds), and
  cheap. You want these on every meaningful trigger.
- **Inferential** sensors call out to another LLM (a code reviewer, for
  example). Slower, charged per token, non-deterministic. Default-disabled in
  this repo because they'd spike cost on every run.

The triggers are deliberately coarse:
- `after_tool` — runs after each tool result. Useful for fast checks like
  `tsc` on the touched file.
- `after_turn` — runs after the assistant says something without calling a
  tool. Useful for "did the agent actually finish?" checks.
- `final` — runs once at `SessionEnd`. Useful for full test suite, full lint.

Errors in sensor `run()` at the `final` trigger are swallowed so a broken
sensor can't fail the session.

## Policy: matchers and modes

```ts
type PolicyRule =
  | { match: { tool: string | RegExp; pattern?: RegExp };
      decision: "allow" | "deny" | "ask"; reason?: string };
```

Rules are evaluated in order; first match wins. The pattern is matched against
a tool-specific subject (for `run_command` it's `input.command`; for everything
else it's `JSON.stringify(input)`).

Permission modes globally override the rule decisions:

| Mode               | Behavior                                              |
|--------------------|-------------------------------------------------------|
| `default`          | Rules apply. `ask` prompts the user (CLI: y/N).       |
| `acceptEdits`      | `ask` is auto-allowed for write-class tools.          |
| `bypassPermissions`| Everything except explicit `deny` is allowed.         |
| `plan`             | Writes/executes are short-circuited to "planned".     |

A `deny` is sticky — `bypassPermissions` won't bypass it. That's the
denylist's whole purpose.

## Sub-agents: context isolation, not orchestration

The `subagent` tool spawns a fresh `runSession` with:

- The same `adapter`, `sink`, `policy`, `hooks` (so events end up in the same
  log and policy is consistently applied).
- A **filtered** registry: the `subagent` tool itself is removed (no
  recursion), and `allowedTools` further narrows what the child can do.
- A fresh `messages[]` — the child sees only its `prompt`, no parent context.
- `subagentDepth + 1`. The default `maxSubagentDepth = 1` means parents may
  spawn but children may not — defense in depth even though the registry
  filter already prevents recursion.
- No sensors — running typecheck inside every subagent is usually wasteful
  duplication.

The child runs to `end_turn`, and its last assistant message becomes the
parent's tool result. The parent never sees the child's intermediate steps,
only the summary it wrote. That's the whole "context isolation" pattern:
delegate a noisy subtask, get back a clean string.

## Event log

`.harness/runs/<run-id>/events.jsonl` — append-only, one JSON object per line,
schema in `src/runtime/events.ts` as a discriminated union. Field names mirror
Claude Code's hook payloads (snake_case + `event` key) so on-disk traces and
hook handlers share a vocabulary.

`harness inspect` parses the file back and renders a timeline. The same data
is enough to reconstruct the conversation, audit policy decisions, and bisect
sensor regressions.

## What we don't do

- No graph executor. Two nested loops handle every shape we care about.
- No streaming back-pressure. The adapter yields events; the loop consumes
  them synchronously. If the model produces a megabyte of text we'll buffer it
  in memory — fine at this scale, would need to change for serious workloads.
- No shared mutable state between sub-agents. Parent and child write to the
  same sink but otherwise their conversation arrays are disjoint.
- No automatic cost cap. Token totals are tracked; enforcement is the caller's
  job for v0.

These are all deliberate v0 omissions, not blind spots — see the ADRs for
which ones were considered and rejected.
