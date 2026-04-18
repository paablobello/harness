# HarnessLab

Provider-agnostic coding-agent harness in TypeScript (CLI + SDK).

## Project layout

- `src/runtime/` — session/turn loop, events, cost accounting
- `src/adapters/` — model provider adapters (Anthropic, OpenAI)
- `src/tools/` — built-in tools (read/list/grep/edit/apply-patch/run-command/subagent/exit-plan-mode)
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
     shows an `✎ edited` marker and approval persists the *edited* text (the
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

## Testing

- `FakeModelAdapter` for integration tests (no API calls in CI).
- Tests in `tests/` mirror `src/` structure.
- Unit tests never hit disk outside of temp dirs.
