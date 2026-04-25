import OpenAI from "openai";

import { computeCost } from "../runtime/cost.js";
import type {
  ConversationMessage,
  ModelAdapter,
  ModelEvent,
  ModelTurnInput,
  StopReason,
  ToolSpec,
} from "../types.js";

export type OpenAIAdapterOptions = {
  model: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens?: number;
  /**
   * Force using the Responses API (`/v1/responses`) regardless of model.
   * Default: auto — Responses API is used for reasoning models (gpt-5*, o1/o3/o4/o5*),
   * Chat Completions for everything else.
   */
  api?: "auto" | "responses" | "chat";
  /**
   * Pre-built OpenAI client. Used by tests to inject mocks without touching
   * the network; production callers should leave this undefined and pass
   * `apiKey` / `baseURL` instead.
   *
   * Typed permissively so tests don't have to construct a full SDK instance.
   */
  client?: unknown;
};

export function createOpenAIAdapter(opts: OpenAIAdapterOptions): ModelAdapter {
  const client =
    (opts.client as OpenAI | undefined) ??
    new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    });

  return {
    name: "openai",
    model: opts.model,

    async *runTurn(input: ModelTurnInput, signal: AbortSignal): AsyncIterable<ModelEvent> {
      const useResponses = shouldUseResponsesApi(opts, input);
      try {
        if (useResponses) {
          yield* runWithResponsesApi(client, opts, input, signal);
        } else {
          yield* runWithChatCompletions(client, opts, input, signal);
        }
      } catch (err) {
        yield {
          type: "stop",
          reason: "error",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/**
 * Decide which OpenAI API to use for this turn.
 *
 * Why route at all? `gpt-5*` / `o*` reasoning models **reject** `reasoning_effort`
 * on `/v1/chat/completions` when function tools are present — OpenAI surfaces it
 * as a 400 telling you to use `/v1/responses`. Chat Completions is also the path
 * with broader 3rd-party compatibility (local proxies, Azure, etc.) so we keep
 * it as the default for non-reasoning models.
 *
 * Rules:
 * - Explicit `opts.api === "responses" | "chat"` wins.
 * - Otherwise: reasoning models → Responses API, everything else → Chat.
 *   We don't gate on `input.reasoning` being present — reasoning models should
 *   go through Responses even without an explicit effort knob, because that's
 *   what OpenAI recommends going forward.
 */
function shouldUseResponsesApi(opts: OpenAIAdapterOptions, _input: ModelTurnInput): boolean {
  if (opts.api === "responses") return true;
  if (opts.api === "chat") return false;
  return isReasoningModel(opts.model);
}

/** Prefix match against the public reasoning-model families. Extend as
 *  OpenAI ships new ones. */
function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return /^(o[1345]|gpt-5)(\b|[-./])/.test(m);
}

// ───────────────────────────────────────────────────────────────────────────
// Chat Completions path (unchanged behaviour for gpt-4o, 4-turbo, mini, etc.)
// ───────────────────────────────────────────────────────────────────────────

async function* runWithChatCompletions(
  client: OpenAI,
  opts: OpenAIAdapterOptions,
  input: ModelTurnInput,
  signal: AbortSignal,
): AsyncIterable<ModelEvent> {
  const maxTokens = input.maxTokens ?? opts.maxTokens;
  // NB: `reasoning_effort` is intentionally NOT forwarded on the chat path.
  // The only models that would accept it are reasoning models, and those get
  // auto-routed to Responses above. Sending it here against gpt-4o-class
  // models would 400.
  const stream = await client.chat.completions.create(
    {
      model: opts.model,
      messages: toChatMessages(input.system, input.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(input.tools && input.tools.length > 0
        ? {
            tools: input.tools.map((t) => ({
              type: "function" as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema as Record<string, unknown>,
              },
            })),
          }
        : {}),
      ...(maxTokens !== undefined ? { max_completion_tokens: maxTokens } : {}),
    },
    { signal },
  );

  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: StopReason = "end_turn";
  const toolAcc = new Map<number, { id: string; name: string; argParts: string[] }>();

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    const delta = choice?.delta.content;
    if (delta) yield { type: "text_delta", text: delta };

    const toolCalls = choice?.delta.tool_calls;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const idx = tc.index;
        let acc = toolAcc.get(idx);
        if (!acc) {
          acc = { id: tc.id ?? "", name: tc.function?.name ?? "", argParts: [] };
          toolAcc.set(idx, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.argParts.push(tc.function.arguments);
      }
    }

    if (choice?.finish_reason === "length") stopReason = "max_tokens";
    else if (choice?.finish_reason === "stop") stopReason = "end_turn";
    else if (choice?.finish_reason === "tool_calls") stopReason = "tool_use";

    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens;
      outputTokens = chunk.usage.completion_tokens;
    }
  }

  for (const acc of toolAcc.values()) {
    yield { type: "tool_call", id: acc.id, name: acc.name, input: parseJsonOrRaw(acc.argParts) };
  }

  yield* finalize(opts.model, inputTokens, outputTokens, stopReason);
}

// ───────────────────────────────────────────────────────────────────────────
// Responses API path (reasoning-aware)
// ───────────────────────────────────────────────────────────────────────────

async function* runWithResponsesApi(
  client: OpenAI,
  opts: OpenAIAdapterOptions,
  input: ModelTurnInput,
  signal: AbortSignal,
): AsyncIterable<ModelEvent> {
  const effort = normalizeEffort(input);
  const maxTokens = input.maxTokens ?? opts.maxTokens;

  const stream = await client.responses.create(
    {
      model: opts.model,
      instructions: input.system,
      input: toResponsesInput(input.messages),
      stream: true,
      // We rebuild the full history each turn — no need for server-side state.
      store: false,
      ...(input.tools && input.tools.length > 0 ? { tools: toResponsesTools(input.tools) } : {}),
      ...(effort ? { reasoning: { effort } } : {}),
      ...(maxTokens !== undefined ? { max_output_tokens: maxTokens } : {}),
    },
    { signal },
  );

  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: StopReason = "end_turn";
  let sawFunctionCall = false;

  /** function_call items arrive across multiple events: `output_item.added`
   *  gives us id/call_id/name, `function_call_arguments.delta` streams the
   *  JSON arguments, `output_item.done` closes the item. We accumulate by
   *  the item's `id`. */
  const funcAcc = new Map<string, { callId: string; name: string; argParts: string[] }>();

  for await (const event of stream as AsyncIterable<ResponsesStreamEvent>) {
    switch (event.type) {
      case "response.output_text.delta":
        if (event.delta) yield { type: "text_delta", text: event.delta };
        break;

      case "response.output_item.added": {
        const item = event.item;
        if (item && item.type === "function_call") {
          funcAcc.set(item.id ?? item.call_id ?? "", {
            callId: item.call_id ?? item.id ?? "",
            name: item.name ?? "",
            argParts: item.arguments ? [item.arguments] : [],
          });
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        const acc = funcAcc.get(event.item_id ?? "");
        if (acc && event.delta) acc.argParts.push(event.delta);
        break;
      }

      case "response.output_item.done": {
        const item = event.item;
        if (item && item.type === "function_call") {
          const acc = funcAcc.get(item.id ?? item.call_id ?? "");
          // Prefer the final `arguments` the server echoes on `.done` over our
          // streamed accumulation — they should match but if a delta was lost
          // the server's copy is authoritative.
          const raw = item.arguments ?? acc?.argParts.join("") ?? "";
          sawFunctionCall = true;
          yield {
            type: "tool_call",
            id: acc?.callId ?? item.call_id ?? item.id ?? "",
            name: acc?.name ?? item.name ?? "",
            input: parseJsonOrRaw([raw]),
          };
          funcAcc.delete(item.id ?? item.call_id ?? "");
        }
        break;
      }

      case "response.completed": {
        const usage = event.response?.usage;
        if (usage) {
          inputTokens = usage.input_tokens ?? 0;
          outputTokens = usage.output_tokens ?? 0;
        }
        const status = event.response?.status;
        if (
          status === "incomplete" &&
          event.response?.incomplete_details?.reason === "max_output_tokens"
        ) {
          stopReason = "max_tokens";
        } else if (sawFunctionCall || funcAcc.size > 0 || hadFunctionCall(event.response)) {
          // If the response contains function_calls, the turn is "tool_use".
          stopReason = "tool_use";
        }
        break;
      }

      case "response.failed":
      case "response.error":
        throw new Error(
          event.error?.message ?? event.response?.error?.message ?? "response failed",
        );

      default:
        // Ignore reasoning_summary deltas, content_part events, refusals, etc.
        // If we ever want to surface chain-of-thought, handle
        // `response.reasoning_summary_text.delta` here.
        break;
    }
  }

  // Belt-and-braces: if a function_call was emitted but `response.completed`
  // did not include an output summary, the runtime still needs to execute it.
  if (stopReason === "end_turn" && sawFunctionCall) stopReason = "tool_use";

  yield* finalize(opts.model, inputTokens, outputTokens, stopReason);
}

function normalizeEffort(input: ModelTurnInput): "low" | "medium" | "high" | null {
  const r = input.reasoning;
  if (!r || !r.effort || r.effort === "off") return null;
  return r.effort;
}

// ───────────────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────────────

async function* finalize(
  model: string,
  inputTokens: number,
  outputTokens: number,
  stopReason: StopReason,
): AsyncIterable<ModelEvent> {
  const cost = computeCost(model, inputTokens, outputTokens);
  const usage: ModelEvent = { type: "usage", inputTokens, outputTokens };
  if (cost !== undefined) usage.costUsd = cost;
  yield usage;
  yield { type: "stop", reason: stopReason };
}

function parseJsonOrRaw(parts: readonly string[]): unknown {
  const raw = parts.join("");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function toChatMessages(
  system: string,
  msgs: ConversationMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
  ];
  for (const m of msgs) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const base: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: m.content || null,
      };
      if (m.toolCalls && m.toolCalls.length > 0) {
        base.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
        }));
      }
      out.push(base);
    } else {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

/**
 * Translate our internal conversation into the Responses API `input` array.
 *
 * Shape per OpenAI docs (as of late 2025):
 *   - user text → `{ role: "user", content: "..." }`
 *   - assistant text → `{ role: "assistant", content: "..." }`
 *   - assistant tool call → `{ type: "function_call", call_id, name, arguments }`
 *   - tool result → `{ type: "function_call_output", call_id, output }`
 *
 * Notes:
 *  - We DO NOT include past reasoning items here. With `store: false` there's
 *    no reasoning context to pass back, and the model re-derives on each turn.
 *  - The SDK types are strict about unions; we cast the array once to keep
 *    the call site readable. The individual items are well-typed inline.
 */
function toResponsesInput(msgs: ConversationMessage[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.content && m.content.length > 0) {
        out.push({ role: "assistant", content: m.content });
      }
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          out.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.input ?? {}),
          });
        }
      }
    } else {
      out.push({
        type: "function_call_output",
        call_id: m.toolCallId,
        output: m.content,
      });
    }
  }
  return out;
}

function toResponsesTools(tools: readonly ToolSpec[]): ResponsesToolParam[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema as Record<string, unknown>,
    strict: false,
  }));
}

function hadFunctionCall(response: ResponsesStreamEvent["response"]): boolean {
  return !!response?.output?.some(
    (o: ResponsesOutputItem | null | undefined) => o?.type === "function_call",
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Lightly-typed stream events
// ───────────────────────────────────────────────────────────────────────────
//
// The OpenAI SDK exports rich discriminated unions for Responses stream
// events, but the union is wide enough (30+ variants) that narrowing every
// branch clutters the reader. We use a single permissive shape and read the
// fields we care about directly — unknown event types fall through the
// `default` case of the switch untouched.

type ResponsesStreamEvent = {
  type: string;
  delta?: string;
  item_id?: string;
  item?: ResponsesOutputItem;
  response?: {
    status?: string;
    incomplete_details?: { reason?: string } | null;
    usage?: { input_tokens?: number; output_tokens?: number };
    output?: (ResponsesOutputItem | null | undefined)[];
    error?: { message?: string };
  };
  error?: { message?: string };
};

type ResponsesOutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
};

/**
 * Shapes accepted by `responses.create({ input })`. The SDK's type is a huge
 * union; we enumerate only the cases we emit.
 */
type ResponsesInputItem =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

type ResponsesToolParam = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
};
