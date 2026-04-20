import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetBackgroundJobs,
  startBackgroundJob,
  waitForJob,
} from "../../src/runtime/background-jobs.js";
import { jobKillTool } from "../../src/tools/job-kill.js";
import { jobOutputTool } from "../../src/tools/job-output.js";
import type { ToolContext } from "../../src/types.js";

let root: string;
const SESSION = "job-test";
const ctx = (): ToolContext => ({
  workspaceRoot: root,
  cwd: root,
  signal: new AbortController().signal,
  sessionId: SESSION,
  runId: "r",
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-job-"));
});
afterEach(async () => {
  __resetBackgroundJobs();
  await rm(root, { recursive: true, force: true });
});

describe("job_output", () => {
  it("lists 'No background jobs' when none exist", async () => {
    const r = await jobOutputTool.run({}, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("No background jobs");
  });

  it("shows a started job in the list", async () => {
    const job = startBackgroundJob({
      sessionId: SESSION,
      command: "sleep 5",
      cwd: root,
    });
    const r = await jobOutputTool.run({}, ctx());
    expect(r.output).toContain(job.id);
    expect(r.output).toContain("running");
  });

  it("returns accumulated output for a finished job", async () => {
    const job = startBackgroundJob({
      sessionId: SESSION,
      command: "echo hello && echo world",
      cwd: root,
    });
    const settled = await waitForJob(SESSION, job.id, 3_000);
    expect(settled?.done).toBe(true);
    const r = await jobOutputTool.run({ id: job.id }, ctx());
    expect(r.output).toContain("hello");
    expect(r.output).toContain("world");
    expect(r.output).toContain("done");
  });

  it("kills a running job", async () => {
    const job = startBackgroundJob({
      sessionId: SESSION,
      command: "sleep 30",
      cwd: root,
    });
    const r = await jobKillTool.run({ id: job.id }, ctx());
    expect(r.output).toContain("Killed");
  }, 10_000);

  it("respects tail_lines", async () => {
    const job = startBackgroundJob({
      sessionId: SESSION,
      command: "for i in $(seq 1 10); do echo line$i; done",
      cwd: root,
    });
    await waitForJob(SESSION, job.id, 3_000);
    const r = await jobOutputTool.run({ id: job.id, tail_lines: 3 }, ctx());
    // Should NOT contain line1 (truncated to last 3 lines).
    expect(r.output).not.toContain("line1\n");
    expect(r.output).toContain("line10");
  });

  it("returns 'No such job' for an unknown id", async () => {
    const r = await jobOutputTool.run({ id: "does-not-exist" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toContain("No such job");
  });
});
