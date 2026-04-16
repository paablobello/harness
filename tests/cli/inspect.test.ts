import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { readEvents, renderTimeline } from "../../src/cli/inspect.js";
import type { HarnessEvent } from "../../src/runtime/events.js";

function ev<E extends HarnessEvent>(e: E): E {
  return e;
}

const BASE = {
  timestamp: "2026-04-16T00:00:00.000Z",
  session_id: "sess-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  run_id: "run-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
};

describe("inspect renderTimeline", () => {
  it("summarizes a session with tools, sensors, and usage", () => {
    const events: HarnessEvent[] = [
      ev({ ...BASE, event: "SessionStart", model: "test-model", adapter: "fake", cwd: "/tmp/x" }),
      ev({ ...BASE, event: "UserPromptSubmit", prompt: "do a thing" }),
      ev({ ...BASE, event: "AssistantTextDelta", text: "ok " }),
      ev({ ...BASE, event: "AssistantTextDelta", text: "doing it" }),
      ev({ ...BASE, event: "AssistantMessage", text: "ok doing it" }),
      ev({
        ...BASE,
        event: "ToolCall",
        tool_use_id: "t1",
        tool_name: "edit_file",
        tool_input: { path: "x.txt", old_str: "", new_str: "y" },
      }),
      ev({
        ...BASE,
        event: "PolicyDecision",
        tool_use_id: "t1",
        tool_name: "edit_file",
        decision: "allow",
      }),
      ev({
        ...BASE,
        event: "ToolResult",
        tool_use_id: "t1",
        tool_name: "edit_file",
        ok: true,
        output: "wrote x.txt",
        duration_ms: 12,
      }),
      ev({
        ...BASE,
        event: "SensorRun",
        name: "typecheck",
        kind: "computational",
        trigger: "after_turn",
        ok: true,
        message: "no type errors",
        duration_ms: 800,
      }),
      ev({ ...BASE, event: "Usage", input_tokens: 10, output_tokens: 5, cost_usd: 0.001 }),
      ev({ ...BASE, event: "Stop", reason: "end_turn" }),
      ev({ ...BASE, event: "SessionEnd", end_reason: "user_exit" }),
    ];

    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    });

    try {
      renderTimeline(events);
    } finally {
      spy.mockRestore();
    }

    const all = logs.join("\n");
    expect(all).toContain("Session");
    expect(all).toContain("user>");
    expect(all).toContain("do a thing");
    expect(all).toContain("ok doing it");
    expect(all).toContain("→ edit_file");
    expect(all).toContain("policy: allow");
    expect(all).toContain("ok");
    expect(all).toContain("wrote x.txt");
    expect(all).toContain("sensor ok");
    expect(all).toContain("typecheck");
    // Footer summary
    expect(all).toMatch(/tools=1.*tokens=10→5/);
    expect(all).toContain("session end");
  });

  it("readEvents parses JSONL and skips malformed lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-inspect-"));
    try {
      const path = join(dir, "events.jsonl");
      const lines = [
        JSON.stringify({ ...BASE, event: "SessionStart", model: "m", adapter: "a", cwd: "/" }),
        "{ not valid json",
        "",
        JSON.stringify({ ...BASE, event: "SessionEnd", end_reason: "eof" }),
      ];
      await writeFile(path, lines.join("\n") + "\n", "utf8");
      const parsed = await readEvents(path);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]?.event).toBe("SessionStart");
      expect(parsed[1]?.event).toBe("SessionEnd");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
