import Anthropic from "@anthropic-ai/sdk";

import { computeCost } from "../runtime/cost.js";
import type {
  ConversationMessage,
  ModelAdapter,
  ModelEvent,
  ModelTurnInput,
  StopReason,
} from "../types.js";

export type AnthropicAdapterOptions = {
  model: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens?: number;
};

const DEFAULT_MAX_TOKENS = 4096;

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
        const stream = await client.messages.create(
          {
            model: opts.model,
            max_tokens: input.maxTokens ?? opts.maxTokens ?? DEFAULT_MAX_TOKENS,
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
            stream: true,
          },
          { signal },
        );

        let inputTokens = 0;
        let outputTokens = 0;
        let stopReason: StopReason = "end_turn";
        const toolBlocks = new Map<
          number,
          { id: string; name: string; jsonParts: string[] }
        >();

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

type AnthropicContentBlockParam =
  | Anthropic.Messages.TextBlockParam
  | Anthropic.Messages.ToolUseBlockParam
  | Anthropic.Messages.ToolResultBlockParam
  | Anthropic.Messages.ImageBlockParam;

function toAnthropicMessages(
  msgs: ConversationMessage[],
): Anthropic.Messages.MessageParam[] {
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
