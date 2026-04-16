import OpenAI from "openai";

import { computeCost } from "../runtime/cost.js";
import type {
  ConversationMessage,
  ModelAdapter,
  ModelEvent,
  ModelTurnInput,
  StopReason,
} from "../types.js";

export type OpenAIAdapterOptions = {
  model: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens?: number;
};

export function createOpenAIAdapter(opts: OpenAIAdapterOptions): ModelAdapter {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
  });

  return {
    name: "openai",
    model: opts.model,

    async *runTurn(input: ModelTurnInput, signal: AbortSignal): AsyncIterable<ModelEvent> {
      try {
        const maxTokens = input.maxTokens ?? opts.maxTokens;
        const stream = await client.chat.completions.create(
          {
            model: opts.model,
            messages: toOpenAIMessages(input.system, input.messages),
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
          const raw = acc.argParts.join("");
          let parsed: unknown = {};
          if (raw.length > 0) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = { _raw: raw };
            }
          }
          yield { type: "tool_call", id: acc.id, name: acc.name, input: parsed };
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

function toOpenAIMessages(
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
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content,
      });
    }
  }
  return out;
}
