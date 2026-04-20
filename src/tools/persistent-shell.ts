/**
 * Long-lived shell session that preserves cwd and env across `run_command`
 * calls within a single Harness session. Inspired by opencode's
 * `GetPersistentShell` (Go) but with TS streaming semantics.
 *
 * Lifecycle:
 *   - `acquire(sessionId, cwd)` returns the singleton for that session,
 *     spawning one if needed. Reused on subsequent calls.
 *   - `release(sessionId)` (called by the runtime on `SessionEnd`) tears it
 *     down, including any in-flight child process.
 *
 * Execution model:
 *   - One long-running `$SHELL` child with stdin/stdout/stderr piped.
 *   - Each command is wrapped to redirect IO into per-call temp files and to
 *     write `pwd` and `$?` into status files. We poll those files at 50ms.
 *   - Streaming is done by tailing the stdout/stderr temp files between
 *     polls, so callers see live output even though the underlying redirect
 *     is to disk.
 *
 * Why temp files (not direct pipe scraping):
 *   - The persistent shell's own stdout would interleave OUR wrapper's writes
 *     (markers, control output) with the child command's stdout. Redirection
 *     to per-call files cleanly isolates user output.
 *   - It's the same pattern opencode uses, and it tolerates `set -x`,
 *     subshell echoes, and other things that would confuse marker parsing.
 *
 * Platform: POSIX-only. Windows callers should skip the persistent shell
 * (the higher-level `run_command` falls back to a transient `execa`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quote as shellQuote } from "shell-quote";
import { execa } from "execa";

export type ShellRunOptions = {
  /** Hard cap for total wall-clock time, ms. Required (no implicit infinity). */
  readonly timeoutMs: number;
  /** Reset on each output chunk; if no chunk for this long, kill. Default: timeoutMs. */
  readonly inactivityMs?: number;
  /** Abort signal — when fired, child is killed and `aborted: true`. */
  readonly abortSignal?: AbortSignal;
  /** Stream callback for stdout/stderr chunks as they arrive. */
  readonly onChunk?: (stream: "stdout" | "stderr", text: string) => void;
};

export type ShellRunResult = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly durationMs: number;
  /** Updated cwd after the command (may differ if the command did `cd …`). */
  readonly cwd: string;
};

const POLL_INTERVAL_MS = 50;

export class PersistentShell {
  private shell: ChildProcess | null = null;
  private alive = false;
  private currentCwd: string;
  private inFlight = false;

  constructor(initialCwd: string) {
    this.currentCwd = initialCwd;
  }

  get cwd(): string {
    return this.currentCwd;
  }

  isAlive(): boolean {
    return this.alive && this.shell !== null;
  }

  /**
   * (Re-)spawn the underlying shell. Idempotent: a no-op when already alive.
   * Called lazily on the first `run` and on respawn after a crash.
   */
  private spawnShell(): void {
    if (this.alive && this.shell) return;
    const userShell = process.env.SHELL ?? "/bin/bash";
    const child = spawn(userShell, [], {
      cwd: this.currentCwd,
      env: {
        ...process.env,
        // Disable interactive editor prompts (git commit, visudo, etc.).
        GIT_EDITOR: "true",
        EDITOR: "true",
        VISUAL: "true",
        // Force a stable PS1 in case the shell echoes prompts to stdout.
        PS1: "",
        // Keep colour output so `pnpm test` etc. render nicely when streamed.
        FORCE_COLOR: "1",
        CLICOLOR_FORCE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Drain the long-lived shell's stdout/stderr — anything the *wrapper*
    // emits is captured into temp files; what reaches these handles is just
    // shell startup chatter we don't care about. We still need a `data`
    // listener so the buffer isn't kept around forever.
    const drain = (): void => {
      // intentionally no-op; we just need a listener so streams don't pile up
    };
    child.stdout?.on("data", drain);
    child.stderr?.on("data", drain);
    child.on("exit", () => {
      this.alive = false;
      this.shell = null;
    });
    child.on("error", () => {
      this.alive = false;
      this.shell = null;
    });
    this.shell = child;
    this.alive = true;
  }

  /**
   * Execute one command. Serialised: throws if a previous command is still
   * in flight. The runtime guarantees serial execution per session, so this
   * is a safety net rather than a real constraint.
   */
  async run(command: string, opts: ShellRunOptions): Promise<ShellRunResult> {
    if (this.inFlight) {
      throw new Error("PersistentShell: a command is already in flight");
    }
    this.inFlight = true;
    try {
      return await this.runInternal(command, opts);
    } finally {
      this.inFlight = false;
    }
  }

  private async runInternal(command: string, opts: ShellRunOptions): Promise<ShellRunResult> {
    this.spawnShell();
    const shell = this.shell;
    if (!shell || !shell.stdin) {
      throw new Error("PersistentShell: failed to spawn shell");
    }

    const dir = await mkdtemp(join(tmpdir(), `harness-shell-${randomUUID()}-`));
    const stdoutFile = join(dir, "stdout");
    const stderrFile = join(dir, "stderr");
    const statusFile = join(dir, "status");
    const cwdFile = join(dir, "cwd");
    await Promise.all([
      writeFile(stdoutFile, ""),
      writeFile(stderrFile, ""),
      writeFile(statusFile, ""),
      writeFile(cwdFile, ""),
    ]);

    // The wrapper:
    //   1. Wrap the user command in a subshell `( … )` so a misbehaving
    //      `exit N` inside it can't tear down our long-lived parent shell.
    //   2. Inside the subshell, cd into our tracked cwd, then `trap EXIT`
    //      to write `pwd` to the cwd file no matter how the subshell exits
    //      (success, failure, or `exit`). This keeps cwd-persistence working
    //      across calls even though we don't run user commands in the
    //      parent shell directly.
    //   3. Capture exit code in the parent. Status file is written LAST so
    //      callers can poll its non-emptiness as the "done" signal.
    //
    // Tradeoff: `export FOO=…` doesn't survive across calls (the assignment
    // happens in the subshell). `cd` does survive (captured via the trap).
    // We accept losing env-var persistence to gain crash-resistance.
    const wrapper =
      `( cd ${shellQuote([this.currentCwd])} 2>/dev/null; ` +
      `trap "pwd > ${shellQuote([cwdFile])}" EXIT; ` +
      `eval ${shellQuote([command])} ) ` +
      `< /dev/null > ${shellQuote([stdoutFile])} 2> ${shellQuote([stderrFile])}\n` +
      `__HARNESS_EC=$?\n` +
      `echo $__HARNESS_EC > ${shellQuote([statusFile])}\n`;

    shell.stdin.write(wrapper);

    const startTime = Date.now();
    const inactivityMs = opts.inactivityMs ?? opts.timeoutMs;
    let lastActivity = startTime;
    let stdoutOffset = 0;
    let stderrOffset = 0;
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let timedOut = false;
    let aborted = false;
    let resultCwd = this.currentCwd;

    try {
      while (true) {
        if (opts.abortSignal?.aborted) {
          aborted = true;
          await this.killChildren();
          break;
        }

        // Tail temp files for new output and stream it.
        const [soText, seText] = await Promise.all([
          readFile(stdoutFile, "utf8").catch(() => ""),
          readFile(stderrFile, "utf8").catch(() => ""),
        ]);
        if (soText.length > stdoutOffset) {
          const chunk = soText.slice(stdoutOffset);
          stdoutOffset = soText.length;
          stdout += chunk;
          opts.onChunk?.("stdout", chunk);
          lastActivity = Date.now();
        }
        if (seText.length > stderrOffset) {
          const chunk = seText.slice(stderrOffset);
          stderrOffset = seText.length;
          stderr += chunk;
          opts.onChunk?.("stderr", chunk);
          lastActivity = Date.now();
        }

        // Check completion via status file.
        const statusText = await readFile(statusFile, "utf8").catch(() => "");
        if (statusText.trim() !== "") {
          const parsed = Number.parseInt(statusText.trim(), 10);
          exitCode = Number.isFinite(parsed) ? parsed : null;
          const newCwd = (await readFile(cwdFile, "utf8").catch(() => "")).trim();
          if (newCwd) {
            this.currentCwd = newCwd;
            resultCwd = newCwd;
          }
          // Drain any final output the shell may have flushed *after* we
          // saw the status file populated.
          const [finalOut, finalErr] = await Promise.all([
            readFile(stdoutFile, "utf8").catch(() => ""),
            readFile(stderrFile, "utf8").catch(() => ""),
          ]);
          if (finalOut.length > stdoutOffset) {
            const chunk = finalOut.slice(stdoutOffset);
            stdout += chunk;
            opts.onChunk?.("stdout", chunk);
          }
          if (finalErr.length > stderrOffset) {
            const chunk = finalErr.slice(stderrOffset);
            stderr += chunk;
            opts.onChunk?.("stderr", chunk);
          }
          break;
        }

        const now = Date.now();
        if (now - startTime > opts.timeoutMs) {
          timedOut = true;
          await this.killChildren();
          break;
        }
        if (now - lastActivity > inactivityMs) {
          timedOut = true;
          await this.killChildren();
          break;
        }

        // Detect shell death between polls (e.g. user did `exit` inside it).
        if (!this.alive) {
          break;
        }

        await delay(POLL_INTERVAL_MS);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }

    return {
      exitCode,
      stdout,
      stderr,
      timedOut,
      aborted,
      durationMs: Date.now() - startTime,
      cwd: resultCwd,
    };
  }

  /**
   * Kill direct children of the shell process. Uses `pgrep -P` to enumerate
   * children, sends SIGTERM, waits briefly, then escalates to SIGKILL for
   * anything still alive. The shell process itself is left running so the
   * next `run` can reuse it.
   */
  async killChildren(): Promise<void> {
    if (!this.shell?.pid) return;
    const pid = this.shell.pid;
    let pids: number[] = [];
    try {
      const result = await execa("pgrep", ["-P", String(pid)], {
        reject: false,
        stdin: "ignore",
      });
      pids = (result.stdout ?? "")
        .split("\n")
        .map((s: string) => Number.parseInt(s.trim(), 10))
        .filter((n: number) => Number.isFinite(n) && n > 0);
    } catch {
      // pgrep not available (BSD without coreutils, very minimal containers);
      // skip gracefully — the timeout path will still trigger.
    }
    for (const childPid of pids) {
      try {
        process.kill(childPid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    await delay(200);
    for (const childPid of pids) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  async close(): Promise<void> {
    await this.killChildren().catch(() => undefined);
    if (this.shell) {
      try {
        this.shell.stdin?.end();
      } catch {
        // pipe already closed
      }
      try {
        this.shell.kill("SIGTERM");
      } catch {
        // already exited
      }
    }
    this.alive = false;
    this.shell = null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Per-session registry. The runtime injects sessionId into ToolContext, so
// `run_command` can look up "the persistent shell for this session" without
// passing it around explicitly. `release(sessionId)` is called from
// `SessionEnd`.
// ---------------------------------------------------------------------------

const shellsBySession = new Map<string, PersistentShell>();

export function acquirePersistentShell(sessionId: string, cwd: string): PersistentShell {
  let s = shellsBySession.get(sessionId);
  if (!s) {
    s = new PersistentShell(cwd);
    shellsBySession.set(sessionId, s);
  }
  return s;
}

export async function releasePersistentShell(sessionId: string): Promise<void> {
  const s = shellsBySession.get(sessionId);
  if (!s) return;
  shellsBySession.delete(sessionId);
  await s.close();
}

/** Test helper: drop all shells without closing their underlying processes. */
export function __resetPersistentShells(): void {
  for (const s of shellsBySession.values()) {
    void s.close();
  }
  shellsBySession.clear();
}
