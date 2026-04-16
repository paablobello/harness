import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HookDispatcher } from "../../src/hooks/dispatcher.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import { MemoryEventSink } from "../../src/runtime/events.js";
import { runSession } from "../../src/runtime/session.js";
import { createBuiltinRegistry } from "../../src/tools/builtin.js";
import type { Sensor } from "../../src/sensors/types.js";
import { createScriptedAdapter, queuedInput } from "../fixtures/fake-adapter.js";

describe("runSession with hooks and sensors", () => {
  it("PreToolUse hook blocks a tool call and records HookBlocked", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-hook-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({ rules: [], mode: "bypassPermissions" });
      const hooks = new HookDispatcher();
      hooks.on("PreToolUse", async (p) => {
        if ("tool_name" in p && p.tool_name === "edit_file") {
          return { block: true, reason: "edits disabled for this test" };
        }
      });

      const adapter = createScriptedAdapter([
        [
          {
            type: "tool_call",
            id: "c1",
            name: "edit_file",
            input: { path: "a.txt", old_str: "", new_str: "x" },
          },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "ok" },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "end_turn" },
        ],
      ]);

      await runSession({
        adapter,
        system: "test",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        hooks,
        input: queuedInput(["edit"]),
      });

      const blocked = sink.events.find((e) => e.event === "HookBlocked");
      expect(blocked && "reason" in blocked && blocked.reason).toMatch(/edits disabled/);
      const result = sink.events.find((e) => e.event === "ToolResult");
      expect(result && "ok" in result && result.ok).toBe(false);
      expect(result && "output" in result && result.output).toMatch(/Blocked by hook/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("after_tool sensor feedback is injected as a user message for the next turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sensor-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({ rules: [], mode: "bypassPermissions" });

      const fakeSensor: Sensor = {
        name: "fake",
        kind: "computational",
        trigger: "after_tool",
        async run() {
          return { ok: false, message: "lint error found" };
        },
      };

      const seenMessages: string[] = [];
      const adapter = {
        name: "fake",
        model: "fake",
        async *runTurn(input: { messages: { role: string; content: string }[] }) {
          seenMessages.push(input.messages.map((m) => `${m.role}:${m.content}`).join(" | "));
          const turn = seenMessages.length - 1;
          if (turn === 0) {
            yield {
              type: "tool_call" as const,
              id: "c1",
              name: "list_files",
              input: {},
            };
            yield { type: "usage" as const, inputTokens: 1, outputTokens: 1 };
            yield { type: "stop" as const, reason: "tool_use" as const };
          } else {
            yield { type: "text_delta" as const, text: "done" };
            yield { type: "usage" as const, inputTokens: 1, outputTokens: 1 };
            yield { type: "stop" as const, reason: "end_turn" as const };
          }
        },
      };

      await runSession({
        adapter,
        system: "t",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        sensors: [fakeSensor],
        input: queuedInput(["go"]),
      });

      const sensorEvent = sink.events.find((e) => e.event === "SensorRun");
      expect(sensorEvent).toBeDefined();
      expect(seenMessages[1]).toMatch(/sensor-feedback/);
      expect(seenMessages[1]).toMatch(/lint error found/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
