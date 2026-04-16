import { describe, expect, it } from "vitest";

import { MemoryEventSink } from "../../src/runtime/events.js";
import { runSession } from "../../src/runtime/session.js";
import { createScriptedAdapter, queuedInput } from "../fixtures/fake-adapter.js";

describe("runSession", () => {
  it("runs a one-turn session and writes the expected event sequence", async () => {
    const sink = new MemoryEventSink();
    const adapter = createScriptedAdapter([
      [
        { type: "text_delta", text: "Hello" },
        { type: "text_delta", text: ", world!" },
        { type: "usage", inputTokens: 10, outputTokens: 3 },
        { type: "stop", reason: "end_turn" },
      ],
    ]);

    const summary = await runSession({
      adapter,
      system: "test",
      cwd: "/tmp",
      sink,
      input: queuedInput(["Hi"]),
    });

    expect(summary.turns).toBe(1);
    expect(summary.totalInputTokens).toBe(10);
    expect(summary.totalOutputTokens).toBe(3);

    const kinds = sink.events.map((e) => e.event);
    expect(kinds).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "AssistantTextDelta",
      "AssistantTextDelta",
      "AssistantMessage",
      "Usage",
      "Stop",
      "SessionEnd",
    ]);

    const assistantMsg = sink.events.find((e) => e.event === "AssistantMessage");
    expect(assistantMsg && "text" in assistantMsg && assistantMsg.text).toBe("Hello, world!");

    const sessionEnd = sink.events.find((e) => e.event === "SessionEnd");
    expect(sessionEnd && "end_reason" in sessionEnd && sessionEnd.end_reason).toBe("user_exit");
  });

  it("records multiple turns and accumulates usage", async () => {
    const sink = new MemoryEventSink();
    const adapter = createScriptedAdapter([
      [
        { type: "text_delta", text: "First" },
        { type: "usage", inputTokens: 5, outputTokens: 1 },
        { type: "stop", reason: "end_turn" },
      ],
      [
        { type: "text_delta", text: "Second" },
        { type: "usage", inputTokens: 8, outputTokens: 1 },
        { type: "stop", reason: "end_turn" },
      ],
    ]);

    const summary = await runSession({
      adapter,
      system: "test",
      cwd: "/tmp",
      sink,
      input: queuedInput(["a", "b"]),
    });

    expect(summary.turns).toBe(2);
    expect(summary.totalInputTokens).toBe(13);
    expect(summary.totalOutputTokens).toBe(2);
    expect(sink.events.filter((e) => e.event === "AssistantMessage")).toHaveLength(2);
  });

  it("ends with error reason when adapter yields stop=error", async () => {
    const sink = new MemoryEventSink();
    const adapter = createScriptedAdapter([[{ type: "stop", reason: "error", error: "boom" }]]);

    await runSession({
      adapter,
      system: "test",
      cwd: "/tmp",
      sink,
      input: queuedInput(["go"]),
    });

    const stop = sink.events.find((e) => e.event === "Stop");
    expect(stop && "reason" in stop && stop.reason).toBe("error");
    const end = sink.events.find((e) => e.event === "SessionEnd");
    expect(end && "end_reason" in end && end.end_reason).toBe("error");
  });
});
