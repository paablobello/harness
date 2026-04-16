# ADR-003: No LangChain, LangGraph, or Mastra

## Status

Accepted, 2026-04.

## Context

There's a healthy ecosystem of TypeScript agent frameworks: LangChain,
LangGraph, Mastra, Vercel AI SDK's agent helpers. Using one would cut
implementation time meaningfully — they all ship conversation management,
tool binding, streaming helpers, and (in LangGraph's case) a DAG executor for
multi-step plans.

This is a portfolio project whose stated goal is to **demonstrate
understanding of harness primitives**, not to ship an agent product. The
interesting thing to show a reader is how the pieces fit together — context
layers, policy, sensors, hook events — not how to wire up somebody else's
graph.

## Decision

No agent framework. We depend directly on the provider SDKs
(`@anthropic-ai/sdk`, `openai`) and nothing else at that layer. The session
loop is plain TypeScript.

Exceptions:

- `@modelcontextprotocol/sdk` is not an "agent framework"; it's the reference
  implementation of the MCP protocol itself. Using it is the only sensible
  move.
- `zod` and `zod-to-json-schema` are data-shape libraries, not agent
  frameworks. Allowed.
- `execa` wraps `child_process` ergonomically. Allowed.

## Consequences

**Good**:

- Every primitive is visible in the repo; nothing meaningful is hidden behind
  an import.
- The session loop (`src/runtime/session.ts`) is one file. A reader can hold
  the whole control flow in their head in ten minutes.
- Upgrade risk is scoped to provider SDK bumps. We don't get dragged along
  with a framework's churn.
- The readme's claim — "here's what a harness actually is" — is credible
  because there's no framework doing the interesting work for us.

**Bad / accepted**:

- We reimplement things that frameworks have solved: multi-turn message
  threading, streaming parse state machines, tool schema translation. This is
  the whole point of the exercise.
- Anything that genuinely benefits from a graph executor (parallel branches,
  conditional replanning, long-running workflows) is out of scope for v0. If
  we ever needed that, LangGraph would be the honest choice — and we'd
  rewrite, not bolt it on.
