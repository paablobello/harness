# harness-lab

A coding-agent **harness** — CLI + SDK — in TypeScript. The plumbing that turns
an LLM into something you'd let touch a real codebase: explicit context layers,
policy-gated tools, environment sensors, hooks, an MCP client, isolated
sub-agents, and a deterministic JSONL event log for every run.

```
harness init                          # scaffold harness.config.ts + AGENTS.md
harness doctor                        # check node + API keys + write perms
harness run "fix the typo in greet.js, then run it"
harness inspect latest                # read the timeline back
harness eval examples/fixtures/*.json # regression-test the harness itself
```

## Why this exists

Modern coding agents look like magic, but the core is just an LLM, a loop, and
some tools. What separates a production-grade agent from a toy is the **harness**
around it — how context is composed, how tool calls are gated, how feedback
from the environment flows back into the next turn, and how runs are made
observable enough to debug.

This repo is my attempt to build that harness from first principles: small,
legible, no framework magic, every primitive explicit. It's a portfolio piece
meant to demonstrate that I understand *why* Claude Code, Codex CLI, and their
peers are shaped the way they are — not to replace them.

## Harness engineering

The mental model is Martin Fowler's: an agent harness is the engineering
discipline of giving an LLM enough **guides** (instructions, examples, policy)
and **sensors** (signals from the environment) that it can do useful work
without supervision. The interesting design choices live at three layers:

| Layer       | What it does                                                 | In this repo                              |
|-------------|--------------------------------------------------------------|-------------------------------------------|
| **Guides**  | feedforward — what the agent is told before it acts          | `system` prompt + `AGENTS.md` + policy rules + hook system messages |
| **Sensors** | feedback — what the environment tells the agent after acting | `src/sensors/` — typecheck, lint, test (computational); llm-review (inferential) |
| **Loop**    | how guides and sensors compose across turns                  | `src/runtime/session.ts` — the only file you really need to read |

Sensor results are injected as `<sensor-feedback>` user messages on the next
turn, so the agent sees its own typecheck failures and can fix them without
human intervention. That's the whole feedback loop.

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  CLI (commander)                                               │
│  init | doctor | chat | run | tools | inspect | eval           │
└─────────────────────────────┬──────────────────────────────────┘
                              ▼
┌────────────────────────────────────────────────────────────────┐
│  Session / Turn loop  (src/runtime/session.ts)                 │
│   user → adapter → text + tool_calls → policy → hook →         │
│              tool.run → result → sensor → next turn            │
└──┬───────────────┬──────────────┬──────────────┬───────────────┘
   ▼               ▼              ▼              ▼
ModelAdapter   ToolRegistry   PolicyEngine   EventSink
 (anthropic)    (builtin +    (allow/deny/   (JSONL file
 (openai)        MCP tools)    ask + modes)   .harness/runs/…)
```

Full sequence diagrams and design notes live in
[`docs/architecture.md`](docs/architecture.md).

## What's in the box

- **Provider adapters** — `@anthropic-ai/sdk` and `openai`, behind a single
  `ModelAdapter` interface. No SDK types leak into core code.
  ([ADR-001](docs/adr/001-provider-adapters.md))
- **Tool registry** — read/list/grep/edit/apply-patch/run-command, plus a
  `subagent` tool for context isolation. Each tool declares a zod input schema
  + a risk label (`read`/`write`/`execute`).
- **Policy engine** — `{tool, pattern}` matchers → `allow|deny|ask`, with the
  same permission modes Claude Code uses (`default`, `acceptEdits`, `bypass`,
  `plan`). Sticky allow per `tool::input` so the user isn't asked twice.
  ([ADR-002](docs/adr/002-policy-matchers.md))
- **Workspace confinement** — every path is `realpath`-resolved against the
  workspace root before a tool sees it. Symlink escapes fail closed.
- **Hook dispatcher** — Claude Code-style subset: `SessionStart`,
  `UserPromptSubmit`, `PreToolUse` (blockable), `PostToolUse`,
  `PostToolUseFailure`, `SubagentStart/Stop`, `Stop`, `SessionEnd`.
- **Sensors** — computational (`tsc --noEmit`, `eslint`, `vitest`) auto-skip
  when the relevant config file is missing; inferential (`llm-review`) ships
  as a stub. Triggers: `after_tool`, `after_turn`, `final`.
  ([ADR-004](docs/adr/004-context-layers.md))
- **MCP client** — connects to stdio MCP servers and registers their tools as
  `mcp__<server>__<tool>` in the same registry as builtins. The model doesn't
  know which is which.
- **Sub-agents** — `subagent` tool spawns a child session with a filtered
  registry (no recursion), shared sink/policy/hooks, fresh conversation. Result
  comes back as a string. Depth-limited.
- **Event log** — `.harness/runs/<run-id>/events.jsonl`, one JSON line per
  event. Schema is a discriminated union (`src/runtime/events.ts`). Replayable.
- **Inspect** — `harness inspect [run-id|latest]` renders a readable timeline
  with totals, policy decisions, and sensor outcomes.
- **Eval harness** — fixture JSONs declare task + assertions (files exist,
  substrings, exit code, max tool calls). `harness eval examples/fixtures/*`
  runs them as a regression suite for the harness itself.

## What's deliberately not in the box

- LangChain / LangGraph / Mastra. The core is direct adapters, not a graph DSL.
  ([ADR-003](docs/adr/003-no-langchain.md))
- Docker sandbox. Process-level + path confinement only in v0; container
  isolation is an obvious v0.2 add-on.
- MCP server host. We're a client only.
- Multi-agent orchestration. One level of sub-agent, no graphs, no shared
  blackboards.
- Persistent semantic memory across sessions. The `.harness/runs/` log is the
  source of truth.

## Quickstart

```bash
pnpm install
pnpm build

export ANTHROPIC_API_KEY=sk-ant-...

# Try it on a throwaway project
mkdir /tmp/demo && cd /tmp/demo
node /path/to/harness-lab/dist/cli/main.js init
node /path/to/harness-lab/dist/cli/main.js doctor
node /path/to/harness-lab/dist/cli/main.js run \
  "create fizzbuzz.js for 1..15, then run it with node and show me the output"
node /path/to/harness-lab/dist/cli/main.js inspect latest
```

For development:

```bash
pnpm test            # unit + integration (53 tests)
pnpm typecheck
pnpm lint
```

## Repo layout

```
src/
  runtime/      session loop, event log, cost accounting, workspace confinement
  adapters/     anthropic + openai
  tools/        builtin tools + registry + subagent
  policy/       engine + defaults
  hooks/        dispatcher (Claude Code-style subset)
  sensors/      typecheck, lint, test, llm-review (stub)
  mcp/          stdio client → registers tools into the registry
  config/       AGENTS.md loader (nested)
  cli/          init, doctor, chat, run, tools, inspect, eval
docs/
  architecture.md   sequence diagrams + flow
  adr/              short ADRs for the load-bearing decisions
examples/
  fixtures/         eval-harness fixtures
tests/              vitest — one file per module
```

## License

MIT
