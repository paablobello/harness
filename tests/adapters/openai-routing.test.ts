/**
 * Routing tests for the OpenAI adapter.
 *
 * We don't call OpenAI — we inject a fake `client` via the (test-only)
 * `client` option. This lets us assert which API (chat.completions vs
 * responses) the adapter chose for a given model + reasoning combo.
 *
 * This is the routing that was silently sending invalid 400s before we added
 * the Responses API path (gpt-5.x rejects `reasoning_effort` on chat).
 */

import { describe, expect, it } from "vitest";

import { createOpenAIAdapter } from "../../src/adapters/openai.js";
import type { ModelEvent } from "../../src/types.js";

type Capture = {
  chatCalls: Record<string, unknown>[];
  responsesCalls: Record<string, unknown>[];
};

function makeFakeClient(opts: {
  readonly chatStream?: () => AsyncIterable<Record<string, unknown>>;
  readonly responsesStream?: () => AsyncIterable<Record<string, unknown>>;
} = {}): { client: unknown; capture: Capture } {
  const capture: Capture = { chatCalls: [], responsesCalls: [] };

  const chatStream = opts.chatStream ?? async function* () {
    yield {
      choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
    };
    yield {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    };
  };

  const responsesStream = opts.responsesStream ?? async function* () {
    yield { type: "response.output_text.delta", delta: "hi" };
    yield {
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 3, output_tokens: 1 },
        output: [],
      },
    };
  };

  const client = {
    chat: {
      completions: {
        create: (args: Record<string, unknown>) => {
          capture.chatCalls.push(args);
          return chatStream();
        },
      },
    },
    responses: {
      create: (args: Record<string, unknown>) => {
        capture.responsesCalls.push(args);
        return responsesStream();
      },
    },
  };

  return { client, capture };
}

async function drain(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("OpenAI adapter — API routing", () => {
  it("routes gpt-5.x + function tools through Responses API (reasoning path)", async () => {
    const { client, capture } = makeFakeClient();
    const adapter = createOpenAIAdapter({ model: "gpt-5.4", client });
    const events = await drain(
      adapter.runTurn(
        {
          system: "s",
          messages: [{ role: "user", content: "hi" }],
          tools: [
            {
              name: "echo",
              description: "echo",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
          reasoning: { effort: "high" },
        },
        new AbortController().signal,
      ),
    );

    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(capture.chatCalls).toHaveLength(0);
    expect(capture.responsesCalls).toHaveLength(1);

    const call = capture.responsesCalls[0]!;
    expect(call["reasoning"]).toEqual({ effort: "high" });
    expect(call["model"]).toBe("gpt-5.4");
    // Crucially NOT reasoning_effort at the top level — Responses API uses
    // the nested `reasoning: { effort }` shape. Sending `reasoning_effort`
    // here would be a silent no-op or a 400.
    expect(call["reasoning_effort"]).toBeUndefined();
  });

  it("routes o3 family through Responses API even without reasoning param", async () => {
    const { client, capture } = makeFakeClient();
    const adapter = createOpenAIAdapter({ model: "o3-mini", client });
    await drain(
      adapter.runTurn(
        { system: "s", messages: [{ role: "user", content: "hi" }] },
        new AbortController().signal,
      ),
    );
    expect(capture.responsesCalls).toHaveLength(1);
    expect(capture.chatCalls).toHaveLength(0);
  });

  it("keeps gpt-4o on Chat Completions and does NOT forward reasoning_effort", async () => {
    const { client, capture } = makeFakeClient();
    const adapter = createOpenAIAdapter({ model: "gpt-4o", client });
    await drain(
      adapter.runTurn(
        {
          system: "s",
          messages: [{ role: "user", content: "hi" }],
          // We deliberately pass a reasoning spec with a non-reasoning model
          // to prove the adapter drops it silently instead of 400-ing.
          reasoning: { effort: "high" },
        },
        new AbortController().signal,
      ),
    );
    expect(capture.responsesCalls).toHaveLength(0);
    expect(capture.chatCalls).toHaveLength(1);
    const call = capture.chatCalls[0]!;
    expect(call["reasoning_effort"]).toBeUndefined();
    expect(call["model"]).toBe("gpt-4o");
  });

  it("explicit api: 'chat' forces Chat Completions even for gpt-5", async () => {
    const { client, capture } = makeFakeClient();
    const adapter = createOpenAIAdapter({ model: "gpt-5.4", api: "chat", client });
    await drain(
      adapter.runTurn(
        { system: "s", messages: [{ role: "user", content: "hi" }] },
        new AbortController().signal,
      ),
    );
    expect(capture.chatCalls).toHaveLength(1);
    expect(capture.responsesCalls).toHaveLength(0);
  });

  it("explicit api: 'responses' forces Responses API for gpt-4o", async () => {
    const { client, capture } = makeFakeClient();
    const adapter = createOpenAIAdapter({ model: "gpt-4o", api: "responses", client });
    await drain(
      adapter.runTurn(
        { system: "s", messages: [{ role: "user", content: "hi" }] },
        new AbortController().signal,
      ),
    );
    expect(capture.responsesCalls).toHaveLength(1);
    expect(capture.chatCalls).toHaveLength(0);
  });

  it("translates assistant tool-calls + tool results into Responses input items", async () => {
    const { client, capture } = makeFakeClient();
    const adapter = createOpenAIAdapter({ model: "gpt-5.4", client });
    await drain(
      adapter.runTurn(
        {
          system: "s",
          messages: [
            { role: "user", content: "do it" },
            {
              role: "assistant",
              content: "sure",
              toolCalls: [{ id: "c1", name: "echo", input: { text: "x" } }],
            },
            { role: "tool", toolCallId: "c1", content: "x" },
          ],
          tools: [
            {
              name: "echo",
              description: "echo",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        },
        new AbortController().signal,
      ),
    );

    const call = capture.responsesCalls[0]!;
    const inputArr = call["input"] as { type?: string; role?: string; call_id?: string }[];
    expect(inputArr.find((i) => i.role === "user")).toBeDefined();
    expect(inputArr.find((i) => i.role === "assistant")).toBeDefined();
    const fc = inputArr.find((i) => i.type === "function_call");
    expect(fc).toMatchObject({ call_id: "c1" });
    const fco = inputArr.find((i) => i.type === "function_call_output");
    expect(fco).toMatchObject({ call_id: "c1" });
  });

  it("marks Responses turns with completed function calls as tool_use", async () => {
    const responsesStream = async function* () {
      yield {
        type: "response.output_item.added",
        item: { type: "function_call", id: "item_1", call_id: "call_1", name: "echo" },
      };
      yield {
        type: "response.function_call_arguments.delta",
        item_id: "item_1",
        delta: '{"text":"hi"}',
      };
      yield {
        type: "response.output_item.done",
        item: { type: "function_call", id: "item_1", call_id: "call_1", name: "echo" },
      };
      yield {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 5, output_tokens: 2 },
          output: [],
        },
      };
    };
    const { client } = makeFakeClient({ responsesStream });
    const adapter = createOpenAIAdapter({ model: "gpt-5.4", client });

    const events = await drain(
      adapter.runTurn(
        {
          system: "s",
          messages: [{ role: "user", content: "call tool" }],
          tools: [
            {
              name: "echo",
              description: "echo",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        },
        new AbortController().signal,
      ),
    );

    expect(events).toContainEqual({ type: "tool_call", id: "call_1", name: "echo", input: { text: "hi" } });
    expect(events[events.length - 1]).toEqual({ type: "stop", reason: "tool_use" });
  });
});
