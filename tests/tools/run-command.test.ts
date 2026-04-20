import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetBackgroundJobs } from "../../src/runtime/background-jobs.js";
import { __resetPersistentShells } from "../../src/tools/persistent-shell.js";
import { runCommandTool } from "../../src/tools/run-command.js";
import type { ToolContext } from "../../src/types.js";

let root: string;
let counter = 0;
const ctx = (overrides?: Partial<ToolContext>): ToolContext => ({
  workspaceRoot: root,
  cwd: root,
  signal: new AbortController().signal,
  // Unique per test so the persistent shell singleton doesn't carry stale
  // cwd from a torn-down tmpdir.
  sessionId: `s-${++counter}`,
  runId: "r",
  ...overrides,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-run-"));
});
afterEach(async () => {
  __resetPersistentShells();
  __resetBackgroundJobs();
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
    const r = await runCommandTool.run({ command: "sleep 2", timeout_ms: 200 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toContain("timed_out=true");
  }, 10_000);

  it("denies a command that touches a protected path", async () => {
    const r = await runCommandTool.run({ command: "cat ~/.ssh/id_rsa" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toContain("denied");
    expect(r.output).toContain("protected path");
  });

  it("streams stdout chunks via emitOutput", async () => {
    const chunks: { stream: string; text: string }[] = [];
    const r = await runCommandTool.run(
      // 5 lines, ~50ms apart, gives the poll loop time to catch each.
      { command: "for i in 1 2 3 4 5; do echo line$i; sleep 0.06; done" },
      ctx({
        emitOutput: (chunk) => chunks.push(chunk),
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("line5");
    // Persistent-shell polls at 50ms; we should see ≥2 distinct chunks.
    const stdoutChunks = chunks.filter((c) => c.stream === "stdout");
    expect(stdoutChunks.length).toBeGreaterThanOrEqual(2);
    const merged = stdoutChunks.map((c) => c.text).join("");
    expect(merged).toContain("line1");
    expect(merged).toContain("line5");
  }, 10_000);

  it("auto-backgrounds long commands", async () => {
    const r = await runCommandTool.run(
      { command: "sleep 5", auto_background_after_ms: 200, timeout_ms: 10_000 },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/Background job id|auto-backgrounded/);
  }, 10_000);

  it("fast-failure: a background command that exits in <1s is returned synchronously", async () => {
    const r = await runCommandTool.run(
      { command: "echo quick", run_in_background: true },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("quick");
    expect(r.output).toContain("exit=0");
  });

  it("background: a long-running command returns a job id", async () => {
    const r = await runCommandTool.run(
      { command: "sleep 5", run_in_background: true },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/Started background job/);
  }, 10_000);

  it("respects inactivity timeout independent from total timeout", async () => {
    // Total timeout 5s, inactivity 200ms, command sleeps 2s without output.
    const r = await runCommandTool.run(
      { command: "sleep 2", timeout_ms: 5_000, inactivity_ms: 200 },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("timed_out=true");
  }, 10_000);

  it("tail-truncates output longer than 30KB", async () => {
    // Generate ~40KB of output: 800 lines * 50 chars.
    const r = await runCommandTool.run(
      { command: "yes 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' | head -800" },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("truncated");
    expect(r.output).toContain("from head");
    expect(r.output.length).toBeLessThan(50 * 1024);
  }, 10_000);
});
