# HarnessLab

Provider-agnostic coding-agent harness in TypeScript (CLI + SDK).

## Project layout

- `src/runtime/` — session/turn loop, events, cost accounting
- `src/adapters/` — model provider adapters (Anthropic, OpenAI)
- `src/tools/` — built-in tools (read/list/grep/edit/apply-patch/run-command/subagent)
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

## Testing

- `FakeModelAdapter` for integration tests (no API calls in CI).
- Tests in `tests/` mirror `src/` structure.
- Unit tests never hit disk outside of temp dirs.
