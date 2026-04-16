import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defaultPolicy } from "../../src/policy/defaults.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import type { ToolDefinition } from "../../src/types.js";

const readTool: ToolDefinition = {
  name: "read_file",
  description: "",
  inputSchema: z.any(),
  risk: "read",
  source: "builtin",
  async run() {
    return { ok: true, output: "" };
  },
};
const editTool: ToolDefinition = { ...readTool, name: "edit_file", risk: "write" };
const runTool: ToolDefinition = { ...readTool, name: "run_command", risk: "execute" };

describe("PolicyEngine (defaults)", () => {
  it("allows reads without asking", async () => {
    const ask = vi.fn(async () => false);
    const engine = new PolicyEngine({ rules: defaultPolicy, ask });
    const decision = await engine.decide({ tool: readTool, input: { path: "x" } });
    expect(decision.decision).toBe("allow");
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks on edits and respects user approval", async () => {
    const ask = vi.fn(async () => true);
    const engine = new PolicyEngine({ rules: defaultPolicy, ask });
    const decision = await engine.decide({
      tool: editTool,
      input: { path: "a.ts", old_str: "x", new_str: "y" },
    });
    expect(decision.decision).toBe("allow");
    expect(ask).toHaveBeenCalledOnce();
  });

  it("denies destructive run_command before asking", async () => {
    const ask = vi.fn(async () => true);
    const engine = new PolicyEngine({ rules: defaultPolicy, ask });
    const decision = await engine.decide({
      tool: runTool,
      input: { command: "rm -rf /" },
    });
    expect(decision.decision).toBe("deny");
    expect(ask).not.toHaveBeenCalled();
  });

  it("remembers approval for identical input (sticky)", async () => {
    const ask = vi.fn(async () => true);
    const engine = new PolicyEngine({ rules: defaultPolicy, ask });
    await engine.decide({ tool: editTool, input: { path: "a", old_str: "x", new_str: "y" } });
    await engine.decide({ tool: editTool, input: { path: "a", old_str: "x", new_str: "y" } });
    expect(ask).toHaveBeenCalledOnce();
  });

  it("bypass mode short-circuits to allow", async () => {
    const ask = vi.fn(async () => false);
    const engine = new PolicyEngine({ rules: defaultPolicy, mode: "bypassPermissions", ask });
    const decision = await engine.decide({
      tool: runTool,
      input: { command: "rm -rf /" },
    });
    expect(decision.decision).toBe("allow");
    expect(ask).not.toHaveBeenCalled();
  });

  it("plan mode denies writes and executes", async () => {
    const engine = new PolicyEngine({ rules: defaultPolicy, mode: "plan" });
    expect((await engine.decide({ tool: editTool, input: {} })).decision).toBe("deny");
    expect((await engine.decide({ tool: runTool, input: { command: "ls" } })).decision).toBe(
      "deny",
    );
    expect((await engine.decide({ tool: readTool, input: {} })).decision).toBe("allow");
  });
});
