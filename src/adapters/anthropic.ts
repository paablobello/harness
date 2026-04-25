import Anthropic from "@anthropic-ai/sdk";

import { computeCost } from "../runtime/cost.js";
import type {
  ConversationMessage,
  ModelAdapter,
  ModelEvent,
  ModelTurnInput,
  ReasoningEffort,
  StopReason,
} from "../types.js";

export type AnthropicAdapterOptions = {
  model: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens?: number;
};

const DEFAULT_MAX_TOKENS = 4096;

/** Default Anthropic `thinking.budget_tokens` per effort level. Picked to
 *  roughly match Claude Code's reported plan-mode budget (~16k on high). */
const THINKING_BUDGETS: Record<Exclude<ReasoningEffort, "off">, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
};

export function createAnthropicAdapter(opts: AnthropicAdapterOptions): ModelAdapter {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
  });

  return {
    name: "anthropic",
    model: opts.model,

    async *runTurn(input: ModelTurnInput, signal: AbortSignal): AsyncIterable<ModelEvent> {
      try {
        const thinking = resolveThinking(input);
        // Anthropic requires max_tokens > budget_tokens when thinking is on.
        // We bump it automatically so callers don't have to know.
        const requestedMax = input.maxTokens ?? opts.maxTokens ?? DEFAULT_MAX_TOKENS;
        const maxTokens = thinking
          ? Math.max(requestedMax, thinking.budget_tokens + 1024)
          : requestedMax;

        const stream = await client.messages.create(
          {
            model: opts.model,
            max_tokens: maxTokens,
            system: input.system,
            messages: toAnthropicMessages(input.messages),
            ...(input.tools && input.tools.length > 0
              ? {
                  tools: input.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
                  })),
                }
              : {}),
            ...(thinking ? { thinking } : {}),
            stream: true,
          },
          { signal },
        );

        let inputTokens = 0;
        let outputTokens = 0;
        let stopReason: StopReason = "end_turn";
        const toolBlocks = new Map<number, { id: string; name: string; jsonParts: string[] }>();

        for await (const chunk of stream) {
          switch (chunk.type) {
            case "message_start":
              inputTokens = chunk.message.usage.input_tokens;
              outputTokens = chunk.message.usage.output_tokens ?? 0;
              break;
            case "content_block_start":
              if (chunk.content_block.type === "tool_use") {
                toolBlocks.set(chunk.index, {
                  id: chunk.content_block.id,
                  name: chunk.content_block.name,
                  jsonParts: [],
                });
              }
              break;
            case "content_block_delta":
              if (chunk.delta.type === "text_delta") {
                yield { type: "text_delta", text: chunk.delta.text };
              } else if (chunk.delta.type === "input_json_delta") {
                const block = toolBlocks.get(chunk.index);
                if (block) block.jsonParts.push(chunk.delta.partial_json);
              }
              break;
            case "content_block_stop": {
              const block = toolBlocks.get(chunk.index);
              if (block) {
                const raw = block.jsonParts.join("");
                let parsed: unknown = {};
                if (raw.length > 0) {
                  try {
                    parsed = JSON.parse(raw);
                  } catch {
                    parsed = { _raw: raw };
                  }
                }
                yield { type: "tool_call", id: block.id, name: block.name, input: parsed };
                toolBlocks.delete(chunk.index);
              }
              break;
            }
            case "message_delta":
              if (chunk.usage?.output_tokens !== undefined) {
                outputTokens = chunk.usage.output_tokens;
              }
              if (chunk.delta.stop_reason === "max_tokens") stopReason = "max_tokens";
              else if (chunk.delta.stop_reason === "tool_use") stopReason = "tool_use";
              break;
          }
        }

        const cost = computeCost(opts.model, inputTokens, outputTokens);
        const usage: ModelEvent = { type: "usage", inputTokens, outputTokens };
        if (cost !== undefined) usage.costUsd = cost;
        yield usage;
        yield { type: "stop", reason: stopReason };
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
 * Translate our provider-agnostic `reasoning` spec into Anthropic's
 * `thinking` param. Returns `null` when thinking should be disabled — either
 * because the caller didn't ask for it or because they explicitly set
 * `effort: "off"`.
 *
 * The return shape is an inline structural type (not the SDK's
 * `Messages.ThinkingConfigEnabled`) on purpose: the SDK's namespace layout
 * has shifted between versions and we don't want this file to break on
 * routine SDK bumps. The two required fields (`type`, `budget_tokens`) are
 * stable public API, documented since extended thinking shipped in Claude 3.7.
 *
 * Note: `thinking_delta` / `signature_delta` / `thinking` content-blocks
 * returned by the API are currently dropped by the stream loop (the switch
 * only handles `text_delta` / `input_json_delta` / `tool_use`). That's fine
 * — we don't want to render chain-of-thought as assistant text. If a future
 * UI wants to surface it, wire a new `ModelEvent.thinking_delta` there.
 */
function resolveThinking(input: ModelTurnInput): { type: "enabled"; budget_tokens: number } | null {
  const r = input.reasoning;
  if (!r) return null;
  if (r.effort === "off") return null;
  const budget =
    r.budgetTokens ?? THINKING_BUDGETS[(r.effort ?? "medium") as keyof typeof THINKING_BUDGETS];
  if (!budget || budget < 1024) return null;
  return { type: "enabled", budget_tokens: budget };
}

type AnthropicContentBlockParam =
  | Anthropic.Messages.TextBlockParam
  | Anthropic.Messages.ToolUseBlockParam
  | Anthropic.Messages.ToolResultBlockParam
  | Anthropic.Messages.ImageBlockParam;

function toAnthropicMessages(msgs: ConversationMessage[]): Anthropic.Messages.MessageParam[] {
  const out: Anthropic.Messages.MessageParam[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const content: AnthropicContentBlockParam[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.input as Record<string, unknown>,
          });
        }
      }
      out.push({ role: "assistant", content });
    } else {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: m.content,
            ...(m.isError ? { is_error: true } : {}),
          },
        ],
      });
    }
  }
  return out;
}
