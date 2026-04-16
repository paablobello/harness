import { describe, expect, it } from "vitest";

import { HookDispatcher } from "../../src/hooks/dispatcher.js";

const basePayload = {
  session_id: "s",
  run_id: "r",
  cwd: "/tmp",
  timestamp: "now",
};

describe("HookDispatcher", () => {
  it("runs handlers in registration order for the matching event", async () => {
    const order: string[] = [];
    const d = new HookDispatcher();
    d.on("UserPromptSubmit", async () => {
      order.push("A");
    });
    d.on("UserPromptSubmit", async () => {
      order.push("B");
    });
    d.on("PreToolUse", async () => {
      order.push("X");
    });
    await d.dispatch({
      ...basePayload,
      hook_event_name: "UserPromptSubmit",
      prompt: "hi",
    });
    expect(order).toEqual(["A", "B"]);
  });

  it("short-circuits on first block and returns its reason", async () => {
    const d = new HookDispatcher();
    d.on("PreToolUse", async () => ({ block: true, reason: "nope" }));
    d.on("PreToolUse", async () => {
      throw new Error("should not run");
    });
    const res = await d.dispatch({
      ...basePayload,
      hook_event_name: "PreToolUse",
      tool_name: "edit_file",
      tool_input: {},
      tool_use_id: "c1",
    });
    expect(res.block).toBe(true);
    expect(res.reason).toBe("nope");
  });

  it("concatenates systemMessages from multiple handlers", async () => {
    const d = new HookDispatcher();
    d.on("UserPromptSubmit", async () => ({ systemMessage: "first" }));
    d.on("UserPromptSubmit", async () => ({ systemMessage: "second" }));
    const res = await d.dispatch({
      ...basePayload,
      hook_event_name: "UserPromptSubmit",
      prompt: "p",
    });
    expect(res.systemMessage).toContain("first");
    expect(res.systemMessage).toContain("second");
  });
});
