import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetPersistentShells,
  acquirePersistentShell,
} from "../../src/tools/persistent-shell.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-pshell-"));
});
afterEach(async () => {
  __resetPersistentShells();
  await rm(root, { recursive: true, force: true });
});

describe("PersistentShell", () => {
  it("captures stdout and exit 0", async () => {
    const sh = acquirePersistentShell("t1", root);
    const r = await sh.run("echo hello", { timeoutMs: 5_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello");
  });

  it("captures non-zero exit code without dying", async () => {
    const sh = acquirePersistentShell("t2", root);
    const a = await sh.run("exit 7", { timeoutMs: 5_000 });
    expect(a.exitCode).toBe(7);
    // Following command must still work — the parent shell survived.
    const b = await sh.run("echo alive", { timeoutMs: 5_000 });
    expect(b.exitCode).toBe(0);
    expect(b.stdout).toContain("alive");
  });

  it("preserves cwd across calls (cd persists via EXIT trap)", async () => {
    const sh = acquirePersistentShell("t3", root);
    const r1 = await sh.run("mkdir sub && cd sub && pwd", { timeoutMs: 5_000 });
    expect(r1.exitCode).toBe(0);
    expect(r1.cwd.endsWith("/sub") || r1.cwd.includes("/sub")).toBe(true);
    const r2 = await sh.run("pwd", { timeoutMs: 5_000 });
    expect(r2.cwd.endsWith("/sub") || r2.cwd.includes("/sub")).toBe(true);
    expect(r2.stdout).toContain("/sub");
  });

  it("times out and reports timed_out=true", async () => {
    const sh = acquirePersistentShell("t4", root);
    const r = await sh.run("sleep 5", { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
  }, 10_000);

  it("respects abort signal", async () => {
    const sh = acquirePersistentShell("t5", root);
    const ac = new AbortController();
    const promise = sh.run("sleep 5", { timeoutMs: 5_000, abortSignal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const r = await promise;
    expect(r.aborted).toBe(true);
  }, 10_000);

  it("streams chunks via onChunk", async () => {
    const sh = acquirePersistentShell("t6", root);
    const chunks: string[] = [];
    const r = await sh.run("for i in 1 2 3; do echo line$i; sleep 0.06; done", {
      timeoutMs: 5_000,
      onChunk: (stream, text) => {
        if (stream === "stdout") chunks.push(text);
      },
    });
    expect(r.exitCode).toBe(0);
    const merged = chunks.join("");
    expect(merged).toContain("line1");
    expect(merged).toContain("line3");
  }, 10_000);

  it("inactivity timeout fires before total timeout", async () => {
    const sh = acquirePersistentShell("t7", root);
    const r = await sh.run("sleep 5", { timeoutMs: 5_000, inactivityMs: 200 });
    expect(r.timedOut).toBe(true);
  }, 10_000);
});
