import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultPolicy } from "../../src/policy/defaults.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import { MemoryEventSink } from "../../src/runtime/events.js";
import { runSession } from "../../src/runtime/session.js";
import { createBuiltinRegistry } from "../../src/tools/builtin.js";
import { createScriptedAdapter, queuedInput } from "../fixtures/fake-adapter.js";

describe("runSession with tools", () => {
  it("executes a tool call, feeds result back, and ends on end_turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-int-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({
        rules: defaultPolicy,
        mode: "acceptEdits",
      });

      const adapter = createScriptedAdapter([
        [
          { type: "text_delta", text: "Creating file..." },
          {
            type: "tool_call",
            id: "call-1",
            name: "edit_file",
            input: { path: "greeting.txt", old_str: "", new_str: "hola" },
          },
          { type: "usage", inputTokens: 10, outputTokens: 5 },
          { type: "stop", reason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "Done." },
          { type: "usage", inputTokens: 12, outputTokens: 2 },
          { type: "stop", reason: "end_turn" },
        ],
      ]);

      const summary = await runSession({
        adapter,
        system: "test",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        input: queuedInput(["write a greeting file"]),
      });

      expect(summary.turns).toBe(2);
      expect(summary.totalInputTokens).toBe(22);
      expect(summary.totalOutputTokens).toBe(7);

      expect(await readFile(join(root, "greeting.txt"), "utf8")).toBe("hola");

      const kinds = sink.events.map((e) => e.event);
      expect(kinds).toContain("ToolCall");
      expect(kinds).toContain("PolicyDecision");
      expect(kinds).toContain("ToolResult");
      expect(kinds[kinds.length - 1]).toBe("SessionEnd");

      const toolResult = sink.events.find((e) => e.event === "ToolResult");
      expect(toolResult && "ok" in toolResult && toolResult.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records deny when policy blocks the tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-int-deny-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({ rules: defaultPolicy });

      const adapter = createScriptedAdapter([
        [
          {
            type: "tool_call",
            id: "c1",
            name: "run_command",
            input: { command: "rm -rf /" },
          },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "ok stopping" },
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
        input: queuedInput(["break things"]),
      });

      const decision = sink.events.find((e) => e.event === "PolicyDecision");
      expect(decision && "decision" in decision && decision.decision).toBe("deny");
      const result = sink.events.find((e) => e.event === "ToolResult");
      expect(result && "ok" in result && result.ok).toBe(false);
      expect(result && "output" in result && result.output).toMatch(/Denied/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces maxToolsPerUserTurn", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-int-max-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({
        rules: defaultPolicy,
        mode: "bypassPermissions",
      });

      const listCall = {
        type: "tool_call" as const,
        id: "c",
        name: "list_files",
        input: {},
      };
      const loopTurn = [
        listCall,
        { type: "usage" as const, inputTokens: 1, outputTokens: 1 },
        { type: "stop" as const, reason: "tool_use" as const },
      ];
      const endTurn = [
        { type: "text_delta" as const, text: "stop" },
        { type: "usage" as const, inputTokens: 1, outputTokens: 1 },
        { type: "stop" as const, reason: "end_turn" as const },
      ];
      const adapter = createScriptedAdapter([loopTurn, loopTurn, loopTurn, endTurn]);

      await runSession({
        adapter,
        system: "test",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        input: queuedInput(["loop"]),
        maxToolsPerUserTurn: 2,
      });

      const toolResults = sink.events.filter((e) => e.event === "ToolResult");
      const aborted = toolResults.find((e) => "output" in e && e.output.includes("exceeded max"));
      expect(aborted).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
