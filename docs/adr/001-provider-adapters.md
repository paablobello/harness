# ADR-001: Provider adapters, no abstraction framework

## Status

Accepted, 2026-04.

## Context

We need to support both Anthropic's `messages.stream` and OpenAI's
`chat.completions.create({stream:true})`. Their wire formats differ in how tool
calls are emitted, how multi-block content is structured, and how stop reasons
are signalled.

The available abstractions:

1. Use a SDK like LangChain that already wraps both. Get a `ChatModel`
   interface for free; pay with vendor lock-in to the abstraction itself, a
   surface area we don't need (memory, retrievers, output parsers), and an
   opinionated streaming protocol that doesn't quite match either provider.
2. Define our own `ModelAdapter` interface with one implementation per
   provider, written against the official SDK directly.
3. Skip abstraction entirely and just call the SDK we need today.

## Decision

Option 2: a single `ModelAdapter` interface in `src/types.ts`, one
implementation per provider in `src/adapters/`, and a strict rule that
provider SDK types **never leak outside `src/adapters/`**.

```ts
type ModelAdapter = {
  name: string;
  model: string;
  runTurn(input: ModelTurnInput, signal: AbortSignal): AsyncIterable<ModelEvent>;
};
type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: "stop"; reason: "end_turn"|"max_tokens"|"tool_use"|"error"; error?: string };
```

The adapter's job is to translate the provider's stream into `ModelEvent`s and
nothing else. Conversation translation (our `ConversationMessage[]` →
provider-specific message arrays) lives in the adapter too, kept private.

## Consequences

**Good**:
- Adding a provider is one file (~150 LOC) with a known shape.
- The session loop has no `if (provider === "anthropic")` branches.
- Tests use a `createScriptedAdapter([events])` fixture — full provider
  fakery in 20 lines.
- We can vendor / strip a provider SDK without touching the loop.

**Bad / accepted**:
- Provider features that don't fit `ModelEvent` (parallel tool calls,
  Anthropic's "thinking" blocks, OpenAI's reasoning tokens) need either an
  extension to the union or are silently flattened. We chose flatten-by-default
  and will extend the union when we hit a feature we genuinely need.
- The translation logic for tool-result blocks is duplicated across adapters.
  Extracting it would require coupling them — not worth it for two adapters.
