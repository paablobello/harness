import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultPolicy } from "../../src/policy/defaults.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import { MemoryEventSink } from "../../src/runtime/events.js";
import { runSession } from "../../src/runtime/session.js";
import { createBuiltinRegistry } from "../../src/tools/builtin.js";
import { createScriptedAdapter, queuedInput } from "../fixtures/fake-adapter.js";

describe("runSession subagent flow", () => {
  it("spawns a subagent and feeds its last message back as tool result", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sub-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({
        rules: defaultPolicy,
        mode: "bypassPermissions",
      });

      // Script is consumed sequentially across parent+child since they share
      // the same adapter instance:
      //   turn 0 (parent): emits subagent tool_call
      //   turn 1 (child):  emits final message + end_turn
      //   turn 2 (parent): receives child message, emits final text + end_turn
      const adapter = createScriptedAdapter([
        [
          {
            type: "tool_call",
            id: "call-sub",
            name: "subagent",
            input: {
              description: "find-thing",
              prompt: "look for the thing and report back",
            },
          },
          { type: "usage", inputTokens: 10, outputTokens: 5 },
          { type: "stop", reason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "I looked. Here is the thing." },
          { type: "usage", inputTokens: 4, outputTokens: 6 },
          { type: "stop", reason: "end_turn" },
        ],
        [
          { type: "text_delta", text: "Subagent reported back. Done." },
          { type: "usage", inputTokens: 8, outputTokens: 3 },
          { type: "stop", reason: "end_turn" },
        ],
      ]);

      const summary = await runSession({
        adapter,
        system: "parent",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        input: queuedInput(["delegate this"]),
      });

      // Parent ran 2 turns; child counted internally but contributes its own
      // events to the shared sink.
      expect(summary.turns).toBe(2);
      expect(summary.lastAssistantMessage).toBe("Subagent reported back. Done.");

      const kinds = sink.events.map((e) => e.event);
      expect(kinds).toContain("SubagentStart");
      expect(kinds).toContain("SubagentStop");

      const start = sink.events.find((e) => e.event === "SubagentStart");
      expect(start && "agent_type" in start && start.agent_type).toBe("find-thing");

      const stop = sink.events.find((e) => e.event === "SubagentStop");
      expect(stop && "last_message" in stop && stop.last_message).toBe(
        "I looked. Here is the thing.",
      );

      const toolResult = sink.events.find(
        (e) => e.event === "ToolResult" && "tool_name" in e && e.tool_name === "subagent",
      );
      expect(toolResult && "ok" in toolResult && toolResult.ok).toBe(true);
      expect(toolResult && "output" in toolResult && toolResult.output).toBe(
        "I looked. Here is the thing.",
      );

      // Parent RunSummary reflects parent-only usage; child's tokens are
      // surfaced separately via the SpawnSubagentResult returned to the tool.
      expect(summary.totalInputTokens).toBe(10 + 8);
      expect(summary.totalOutputTokens).toBe(5 + 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("strips the subagent tool from the child registry (no nesting)", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-sub-strip-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({
        rules: defaultPolicy,
        mode: "bypassPermissions",
      });

      // Child tries to spawn a nested subagent; the tool isn't in its registry
      // so the runtime returns "Unknown tool".
      const adapter = createScriptedAdapter([
        [
          {
            type: "tool_call",
            id: "p1",
            name: "subagent",
            input: { description: "outer", prompt: "go" },
          },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "tool_use" },
        ],
        [
          {
            type: "tool_call",
            id: "c1",
            name: "subagent",
            input: { description: "inner", prompt: "nest" },
          },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "child gives up" },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "end_turn" },
        ],
        [
          { type: "text_delta", text: "parent done" },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "end_turn" },
        ],
      ]);

      await runSession({
        adapter,
        system: "parent",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        input: queuedInput(["go"]),
      });

      const subagentResults = sink.events.filter(
        (e) => e.event === "ToolResult" && "tool_name" in e && e.tool_name === "subagent",
      );
      // One ToolResult per subagent call: the child's call resolves to
      // "Unknown tool" because subagent was filtered out of its registry.
      const childCall = subagentResults.find(
        (e) => "tool_use_id" in e && e.tool_use_id === "c1",
      );
      expect(childCall && "ok" in childCall && childCall.ok).toBe(false);
      expect(childCall && "output" in childCall && childCall.output).toMatch(
        /Unknown tool/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
