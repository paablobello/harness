import { describe, expect, it } from "vitest";

import { MemoryEventSink } from "../../../src/runtime/events.js";
import { runSession } from "../../../src/runtime/session.js";
import { initialState, reducer, type Action, type SessionMeta } from "../../../src/cli/ui/state.js";
import { createScriptedAdapter } from "../../fixtures/fake-adapter.js";

const SESSION: SessionMeta = {
  mode: "chat",
  adapter: { name: "fake", model: "scripted-1" },
  cwd: "/tmp",
  logPath: "/tmp/log.jsonl",
  configPath: null,
  permissionMode: "default",
  withTools: false,
  toolCount: 0,
};

/**
 * Drives the same callbacks the Ink bridge wires into `runSession`, feeding them
 * into the reducer. This is effectively an end-to-end test of the state machine
 * against a real session loop, minus the Ink rendering layer.
 */
describe("UI state integration with runSession", () => {
  it("builds a consistent transcript from a scripted two-turn session", async () => {
    const sink = new MemoryEventSink();
    const adapter = createScriptedAdapter([
      [
        { type: "text_delta", text: "Hi " },
        { type: "text_delta", text: "there" },
        { type: "usage", inputTokens: 5, outputTokens: 2 },
        { type: "stop", reason: "end_turn" },
      ],
      [
        { type: "text_delta", text: "Second reply" },
        { type: "usage", inputTokens: 7, outputTokens: 3 },
        { type: "stop", reason: "end_turn" },
      ],
    ]);

    let state = initialState(SESSION, "dark");
    const dispatch = (action: Action): void => {
      state = reducer(state, action);
    };

    // Mimic what the Ink bridge does: dispatch USER_SENT immediately on submit,
    // TURN_END before blocking on the next input, and forward adapter events.
    const prompts = ["first", "second"];
    let nextIdx = 0;
    const input = {
      async next() {
        dispatch({ type: "TURN_END" });
        const value = prompts[nextIdx++];
        if (value === undefined) return null;
        dispatch({ type: "USER_SENT", text: value });
        return value;
      },
    };

    await runSession({
      adapter,
      system: "t",
      cwd: "/tmp",
      sink,
      input,
      onAssistantDelta: (text) => dispatch({ type: "ASSIST_DELTA", text }),
      onAssistantMessage: (text) => dispatch({ type: "ASSIST_END", text }),
      onUsage: (u) =>
        dispatch({
          type: "USAGE",
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          ...(u.costUsd !== undefined ? { costUsd: u.costUsd } : {}),
        }),
    });

    expect(state.messages.filter((m) => m.kind === "user")).toHaveLength(2);
    const assistants = state.messages.filter((m) => m.kind === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0] && assistants[0].kind === "assistant" ? assistants[0].text : null).toBe(
      "Hi there",
    );
    expect(assistants[1] && assistants[1].kind === "assistant" ? assistants[1].text : null).toBe(
      "Second reply",
    );
    assistants.forEach((a) => {
      expect(a.kind === "assistant" && a.streaming).toBe(false);
    });

    expect(state.stats.tokensIn).toBe(12);
    expect(state.stats.tokensOut).toBe(5);
    expect(state.isAssistantStreaming).toBe(false);
    expect(state.isTurnActive).toBe(false);
  });

  it("tracks tool calls as they run and resolve", () => {
    let state = initialState(SESSION, "dark");
    const dispatch = (action: Action): void => {
      state = reducer(state, action);
    };

    dispatch({ type: "USER_SENT", text: "run it" });
    dispatch({
      type: "TOOL_CALL",
      call: { id: "t1", name: "read", input: { path: "a.ts" } },
    });
    expect(state.focusedToolId).toBe("t1");
    const running = state.messages.find((m) => m.kind === "tool");
    expect(running && running.kind === "tool" && running.status).toBe("running");

    dispatch({
      type: "TOOL_RESULT",
      id: "t1",
      ok: true,
      output: "contents",
    });
    const done = state.messages.find((m) => m.kind === "tool");
    expect(done && done.kind === "tool" && done.status).toBe("ok");
    expect(state.stats.toolCalls).toBe(1);
    expect(state.stats.toolFailures).toBe(0);
  });

  // Keeps vitest happy by referencing MemoryEventSink in this file
  // (ensures the import is used even in coverage configurations that
  // strip imports).
  it("MemoryEventSink import is exercised for coverage", () => {
    expect(new MemoryEventSink().events).toEqual([]);
  });
});
