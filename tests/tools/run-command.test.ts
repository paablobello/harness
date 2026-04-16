import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCommandTool } from "../../src/tools/run-command.js";
import type { ToolContext } from "../../src/types.js";

let root: string;
const ctx = (): ToolContext => ({
  workspaceRoot: root,
  cwd: root,
  signal: new AbortController().signal,
  sessionId: "s",
  runId: "r",
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-run-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("run_command", () => {
  it("captures stdout and exit 0", async () => {
    const r = await runCommandTool.run({ command: "echo hello" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("hello");
    expect(r.output).toContain("exit=0");
  });

  it("reports non-zero exit as ok=false", async () => {
    const r = await runCommandTool.run({ command: "exit 7" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toContain("exit=7");
  });

  it("times out and flags timed_out", async () => {
    const r = await runCommandTool.run({ command: "sleep 2", timeout_ms: 100 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toContain("timed_out=true");
  }, 10_000);
});
