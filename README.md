# harness-lab

A coding-agent harness — CLI + SDK — in TypeScript. Built to understand and demonstrate the primitives behind tools like Claude Code: explicit context layers, policy-gated tools, hooks, sensors, MCP client, and replay tooling.

**Status**: early WIP. Public roadmap below.

## Why

Modern coding agents look like magic, but the core is an LLM, a loop, and tools. What makes one production-grade and another a toy is the harness around it — how context is composed, how tool calls are gated, how feedback from the environment flows back in, and how runs are made observable and replayable.

`harness-lab` is my attempt to build one from scratch, staff-engineer style: small, legible, no framework magic, every primitive explicit.

## Quickstart

```bash
pnpm install
pnpm test
pnpm build
```

## Roadmap

- **M0** — scaffold + CI
- **M1** — core turn loop, provider adapters (Anthropic + OpenAI), JSONL event log
- **M2** — tool registry, policy engine, workspace sandbox
- **M3** — hooks (Claude Code-style subset), computational sensors, AGENTS.md loader
- **M4** — MCP client, sub-agents with context isolation
- **M5** — replay, inspect, eval harness (approved fixtures)
- **M6** — docs, ADRs, demo

## License

MIT
