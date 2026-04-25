# HarnessLab

Provider-agnostic coding-agent harness in TypeScript (CLI + SDK).

## Project layout

- `src/runtime/` — session/turn loop, events, cost accounting
- `src/adapters/` — model provider adapters (Anthropic, OpenAI)
- `src/tools/` — built-in tools (read/list/grep/edit/apply-patch/run-command/job-output/subagent/exit-plan-mode); see `command-parser.ts`, `persistent-shell.ts`
- `src/policy/` — policy engine + defaults
- `src/hooks/` — hook dispatcher (Claude Code-style events)
- `src/sensors/` — computational + inferential sensors
- `src/mcp/` — MCP client
- `src/config/` — harness.config.ts loader, AGENTS.md resolver
- `src/cli/` — commander-based CLI
- `tests/` — vitest unit + integration, fixture-based evals

## Commands

- `pnpm build` — tsup bundles to `dist/`
- `pnpm test` — vitest
- `pnpm typecheck` — tsc --noEmit
- `pnpm lint` — eslint on src + tests
- `pnpm format` — prettier write

## Conventions

- ESM only. No CommonJS.
- Strict TypeScript (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- Zod for input schemas; never hand-write JSON Schema (use `zod-to-json-schema`).
- Provider SDK types stay inside `src/adapters/`. The core never imports `@anthropic-ai/sdk` or `openai` directly.
- Every tool invocation goes through the policy engine.
- Every run writes a JSONL event stream to `.harness/runs/<run-id>/events.jsonl`.

## Plan mode

A read-only deliberation mode for large / ambiguous tasks. Toggle in the Ink UI
with `Shift+Tab` (default ↔ plan). The `--permission-mode plan` CLI flag starts
a session directly in plan mode.

Plan mode pulls three levers at once:

1. **Hard enforcement.** While `mode === "plan"`, the `PolicyEngine`
   (`src/policy/engine.ts`) denies every tool whose `risk !== "read"`. The
   model cannot write files or run commands, even if it tries.
2. **Elevated reasoning budget.** The session auto-injects
   `reasoning: { effort: "high" }` into every `ModelTurnInput` while plan mode
   is active (`src/runtime/session.ts` → `resolveReasoningForMode`). Adapter
   translation:
   - **Anthropic** → `thinking: { type: "enabled", budget_tokens: 16384 }`
     on the existing `messages.create` stream (`max_tokens` auto-bumped past
     the budget so the API doesn't reject).
   - **OpenAI** → the adapter auto-routes reasoning-family models
     (`gpt-5*`, `o1*`, `o3*`, `o4*`, `o5*`) to the **Responses API**
     (`/v1/responses`) with `reasoning: { effort }` in the nested shape,
     because `chat.completions` 400s on `reasoning_effort` when function
     tools are present. Non-reasoning models (`gpt-4o` etc.) stay on
     `chat.completions` with the reasoning param silently dropped. Force a
     specific path with the adapter option `api: "chat" | "responses"
| "auto"` (default `"auto"`).
   - Override per-mode via `SessionConfig.reasoning.plan` — `null` disables
     it entirely.
3. **Prompt contract.** `src/runtime/plan-mode-prompts.ts` ships an entry
   `<system-reminder>` that (a) explains hard enforcement, (b) mandates at
   least three read-only tool calls before `exit_plan_mode`, and (c) spells
   out the required plan shape (Objective · Affected files · Approach +
   alternatives · Steps · Risks · Verification). `exit_plan_mode` runs a
   soft-validation on the submitted plan (word count, file-path refs, step
   count, section signals) and auto-rejects thin plans before bothering the
   user — the model reads the rejection reason as a tool result and
   iterates.

Workflow:

1. User toggles plan mode (`Shift+Tab`) or starts the session with
   `--permission-mode plan`. The runtime pushes `{ type: "set_mode", mode:
"plan" }` into the `ControlChannel`; `session.drainControls` applies it
   between turns, calls `policy.setMode("plan")`, emits
   `PermissionModeChanged`, and queues `PLAN_ENTRY_REMINDER`.
2. Model explores with `read_file` / `list_files` / `grep_files`, optionally
   delegates parallel exploration via `subagent`, and may call
   `ask_user_question` when scope is unclear.
3. When the plan is ready, the model calls `exit_plan_mode({ plan })`. The
   tool opens the `PlanApprovalDialog` via `ctx.askPlan`, whose review stage
   offers four hotkeys:
   - `a` **approve** → tool writes `.harness/plans/<YYYYMMDD-HHmmss>-<slug>.md`,
     calls `ctx.setPermissionMode(previousMode)` to restore `default` /
     `acceptEdits`, and returns `ok:true` with the artifact path.
   - `v` **expand/collapse** → toggles between the 22-line preview and the
     full plan in-place (no separate overlay).
   - `e` **edit in $EDITOR** → opens `$EDITOR` (falls back to `$VISUAL`, then
     `nano`) on a tmp file seeded with the plan. On save+close, the dialog
     shows an `✎ edited` marker and approval persists the _edited_ text (the
     model's original plan is discarded). Same pause/resume trick as
     `InputPrompt`'s Ctrl+E — we drop Ink's raw-mode while the editor owns
     the TTY.
   - `r` **reject** → free-text feedback input; tool returns `ok:false` with
     the feedback, plan mode stays on, and the model iterates on its next
     turn.
4. After approval the model implements the plan under whatever permission
   mode was active before plan mode.

`exit_plan_mode` is marked `risk: "read"` (not `"write"`) on purpose: the file
write is gated by the user-facing approval dialog, not by the policy engine,
so in a non-interactive runtime the tool fails fast instead of writing without
consent.

## Command execution

`run_command` is the only tool that can spawn arbitrary processes. It is the
single largest blast radius in the harness, so the implementation is layered
defence-in-depth across **policy → protected paths → execution mode → output
streaming → background lifecycle**.

### 1. Segment-based policy

The legacy "single regex on the raw command" approach is trivially bypassed
(`echo hi && rm -rf ~`, `cat foo | bash`). We tokenise the command with
`shell-quote` (`src/tools/command-parser.ts`) and split it on every shell
control op (`;`, `&&`, `||`, `|`, `&`). The result is a list of `Segment`s
plus pipeline groupings, with flags for `hasPipe`, `hasRedirection`,
`hasSubshell`, and `parseError`.

`src/policy/run-command-policy.ts` then walks the parsed command in a fixed
order:

1. **Catastrophic patterns → hard `deny`** (`rm -rf /`, `mkfs.*`, `dd of=/dev/sda`,
   classic fork bomb, `chmod 777 /`). Cannot be auto-approved.
2. **Remote-fetched script piped to a shell → hard `deny`** (`curl … | sh`,
   even when separated by `tee`/`xargs`).
3. **Subshell `$(…)` or backticks → `ask`.** We can't statically reason
   inside, so we degrade to user confirmation.
4. **Sensitive executables → `ask`** (`sudo`, `ssh`, `rsync`, `apt`, `brew`,
   `systemctl`, `iptables`, browsers, …). Note: routed through `ask`, **not**
   `deny`. The previous default was deny-by-banlist which led to silent
   failures the model couldn't recover from. The escalation flow is now
   "ask the user" rather than "fail closed".
5. **All segments on the safe-prefix allowlist → auto-`allow`** (`git status`,
   `ls`, `pwd`, `cat`, `pnpm test`, `node -v`, …). Prefix-based so
   `git status -s` is just as safe as `git status`, but `git push` is not on
   the list and falls through.
6. Otherwise → `ask`.

`PolicyEngine.decide` calls this evaluator before applying its general rule
matcher (`src/policy/engine.ts`). Catastrophic denies short-circuit even when
a rule (or session-wide "always allow") would have allowed the tool. Explicit
allow rules win over a segment "ask" so the TUI's `a` ("always allow for
session") affordance still works.

### 2. Protected paths (filesystem-aware)

`src/runtime/protected-paths.ts` is independent from the policy engine and
inspects every argv token of every parsed segment. Each path is `~`/`$HOME`
expanded, normalised, then matched as a path **prefix** (so
`cat ~/.ssh/id_rsa`, `cat /Users/x/.ssh/id_rsa`, and `cat ./.ssh/id_rsa`
when cwd is `$HOME` all hit). Coverage:

- Absolute: `/etc/sudoers`, `/etc/shadow`, `/etc/passwd`, `/etc/ssh`,
  `/etc/ssl/private`, `/var/root`, `/root`.
- Home-relative: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.gcloud`, `~/.kube`,
  `~/.docker/config.json`, `~/.npmrc`, `~/.pypirc`, `~/.netrc`,
  `~/.config/gh`.
- Workspace: `.git`, `.harness/runs`.
- Basename glob: `.env*`, `*.pem`, `*.key`, `id_rsa`/`id_ed25519`/…

A protected-path hit downgrades a would-be `allow` to `ask` with the matched
token surfaced in the prompt reason.

### 3. Execution modes

Three execution backends, picked per call:

- **`runWithPersistentShell` (default on POSIX).** Long-lived `$SHELL` per
  session (`src/tools/persistent-shell.ts`). Each command runs inside a
  subshell `( … )` so `exit N` can't kill the parent shell, with
  `trap "pwd > …" EXIT` capturing the cwd no matter how the subshell
  terminates. Result: `cd` survives across calls, but `export FOO=…` does
  not (assignment happens in the subshell). We accept losing env-var
  persistence to gain crash-resistance. Output is redirected to per-call
  temp files which we tail at 50 ms for streaming. `killChildren()` uses
  `pgrep -P` and SIGTERM → SIGKILL after a 200 ms grace.
- **`runTransient` (Windows or `use_persistent_shell: false`).** Plain
  `execa` invocation, no cwd persistence. The fallback for platforms where
  the persistent shell isn't reliable.
- **`runAsBackground` (`run_in_background: true` or auto-trigger).**
  Spawned via `execa` and registered in `src/runtime/background-jobs.ts`.
  Returns a `job_id` immediately. Stdout/stderr are buffered in-memory
  (capped at 256 KB each, oldest dropped). The model inspects/kills jobs
  through the `job_output` tool. The session's cleanup (`SessionEnd`) calls
  `releaseSessionJobs` which SIGTERM-then-SIGKILLs every live job.

### 4. Timeouts and auto-backgrounding

`run_command` accepts both `timeout_ms` (absolute wall-clock cap) and
`inactivity_ms` (resets on every output chunk). When a foreground command
crosses `auto_background_after_ms` (default 60s), it is **promoted to a
background job** transparently — the tool returns the job id and the model
can poll progress with `job_output`. Conversely, jobs explicitly started in
the background go through a 1s **fast-failure window**: if the process exits
within that window we synchronously return its result instead of a job id,
so commands that die immediately surface as normal failures.

### 5. Streaming output (UI ↔ runtime)

Tools receive an optional `ctx.emitOutput(chunk)` callback (`src/types.ts`).
The session forwards each chunk to the runtime as a `ToolOutputDelta` event
(`src/runtime/events.ts`); the Ink bridge dispatches `TOOL_OUTPUT_DELTA`
into the UI reducer (`src/cli/ui/state.ts`); `ToolBlock.tsx` swaps the
"final output" view for a live `StreamingOutput` component while the tool
is `running`. The UI buffer is also capped so a chatty server doesn't grow
state without bound.

### Platform notes

- **macOS / Linux.** Full feature set: persistent shell, streaming, auto-
  background, `pgrep`-based child kill.
- **Windows.** Best-effort: the persistent shell is disabled (we fall back
  to transient `execa`); cwd does not persist across calls; child-kill
  relies on `execa`'s built-in tree kill since `pgrep` isn't available.

### Out of scope (future PR)

OS-level sandboxing (`sandbox-exec` on macOS, `bubblewrap`/`firejail` on
Linux, optional Docker container wrapping) is **explicitly deferred**. The
soft layers above already deny the obviously-bad shapes and ask for
everything else; sandboxing will plug in as an optional `runner: "sandbox"
| "container"` per-tool setting without changing the policy contract.

## Testing

- `FakeModelAdapter` for integration tests (no API calls in CI).
- Tests in `tests/` mirror `src/` structure.
- Unit tests never hit disk outside of temp dirs.
