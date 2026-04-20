/**
 * `run_command` — the only tool that turns model intent into shell side-effects.
 *
 * This rewrite folds in techniques from opencode (persistent shell + cwd
 * tracking), continue (segment parser + inactivity timeout + streaming) and
 * crush (auto-background + fast-failure). Sandboxing is intentionally NOT
 * here yet — the next PR will gate execution through `sandbox-exec` (macOS),
 * `bubblewrap` (Linux), or Anthropic's `sandbox-runtime`. See
 * `docs`/AGENTS.md for the security posture this PR delivers.
 */

import { execa } from "execa";
import { z } from "zod";

import {
  adoptBackgroundProcess,
  createManagedBackgroundJob,
  startBackgroundJob,
  waitForJob,
} from "../runtime/background-jobs.js";
import { touchesProtectedPath } from "../runtime/protected-paths.js";
import { resolveWithinWorkspace } from "../runtime/workspace.js";
import type { ToolDefinition } from "../types.js";
import { parseCommand } from "./command-parser.js";
import { acquirePersistentShell, detachPersistentShell, type PersistentShell } from "./persistent-shell.js";

const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = MAX_TIMEOUT_MS;
const MAX_OUTPUT_BYTES = 30 * 1024; // ~30KB, aligned with opencode/crush
const DEFAULT_AUTO_BACKGROUND_MS = 60_000; // crush default
const FAST_FAILURE_WINDOW_MS = 1_000; // crush default

const input = z.object({
  command: z.string().min(1).describe("Shell command to execute. Runs via $SHELL -c."),
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory relative to workspace (default: persistent shell's cwd, or workspace root on first call).",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(
      `Total wall-clock cap (ms). Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
    ),
  inactivity_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(
      "Inactivity timeout (ms). The timer resets on every stdout/stderr chunk, so commands " +
        "that print progress survive arbitrarily long runs. Defaults to `timeout_ms`.",
    ),
  auto_background_after_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `If the command is still running after this many ms, move it to a background ` +
        `job and return its id (poll with \`job_output\`, terminate with \`job_kill\`). ` +
        `Default ${DEFAULT_AUTO_BACKGROUND_MS}.`,
    ),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Start as a background job from the start, returning a job id after a 1s fast-failure window.",
    ),
  use_persistent_shell: z
    .boolean()
    .optional()
    .describe(
      "Reuse the per-session shell so cwd carries across calls. Default: true.",
    ),
});

export const runCommandTool: ToolDefinition<z.infer<typeof input>> = {
  name: "run_command",
  description:
    "Execute a shell command. Output is streamed live and capped at 30KB (tail-biased). " +
    "Long-running commands auto-background after 60s and return a job id; check progress " +
    "with `job_output` or terminate with `job_kill`. Each command is parsed into segments so the policy can " +
    "deny banlist commands hidden behind `&&`/`|`. Sensitive paths (.git, .env, ~/.ssh) " +
    "are blocked filesystem-aware. Stdin is always closed.",
  inputSchema: input,
  risk: "execute",
  source: "builtin",
  async run(args, ctx) {
    const timeout = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const inactivity = args.inactivity_ms ?? timeout;
    const autoBgAfter = args.auto_background_after_ms ?? DEFAULT_AUTO_BACKGROUND_MS;
    const usePersistent = args.use_persistent_shell ?? defaultPersistentShellEnabled();
    const workspaceCwd = await resolveWithinWorkspace(ctx.workspaceRoot, ".");
    const shell = usePersistent ? acquirePersistentShell(ctx.sessionId, workspaceCwd) : null;
    const cwd = args.cwd
      ? await resolveWithinWorkspace(ctx.workspaceRoot, args.cwd)
      : (shell?.cwd ?? workspaceCwd);

    // Parse + protected-path check happen here even though the policy already
    // ran the catastrophic + sensitive checks: paths are filesystem-aware and
    // depend on cwd/home, which the policy doesn't have access to.
    const parsed = parseCommand(args.command);
    const hit = touchesProtectedPath(parsed, { cwd });
    if (hit) {
      return {
        ok: false,
        output:
          `denied: command would touch protected path "${hit.token}" ` +
          `(matched rule \`${hit.rule}\`, via \`${hit.executable}\`).\n` +
          `If this is intentional, narrow the path or use the appropriate dedicated tool.`,
      };
    }

    if (args.run_in_background) {
      return runAsBackground({
        sessionId: ctx.sessionId,
        command: args.command,
        cwd,
        emitOutput: ctx.emitOutput,
      });
    }

    if (usePersistent) {
      return runWithPersistentShell({
        shell: shell!,
        sessionId: ctx.sessionId,
        command: args.command,
        cwd,
        timeout,
        inactivity,
        autoBgAfter,
        signal: ctx.signal,
        emitOutput: ctx.emitOutput,
      });
    }

    return runTransient({
      command: args.command,
      cwd,
      timeout,
      inactivity,
      autoBgAfter,
      signal: ctx.signal,
      sessionId: ctx.sessionId,
      emitOutput: ctx.emitOutput,
    });
  },
};

type RunFgOpts = {
  readonly sessionId: string;
  readonly command: string;
  readonly cwd: string;
  readonly timeout: number;
  readonly inactivity: number;
  readonly autoBgAfter: number;
  readonly signal: AbortSignal;
  readonly emitOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
};

async function runWithPersistentShell(opts: RunFgOpts & { readonly shell: PersistentShell }) {
  const shell = opts.shell;
  if (shell.isBusy()) {
    return runTransient(opts);
  }
  // Ensure the shell knows we're calling from `opts.cwd`; the wrapper
  // `cd`s into shell.cwd which we override here for this call only.
  const wrapped = `cd ${quote(opts.cwd)} 2>/dev/null && { ${opts.command}; }`;

  let stdout = "";
  let stderr = "";
  let managed: ReturnType<typeof createManagedBackgroundJob> | null = null;

  try {
    const runPromise = shell.run(wrapped, {
      timeoutMs: opts.timeout,
      inactivityMs: opts.inactivity,
      abortSignal: opts.signal,
      onChunk: (stream, text) => {
        if (stream === "stdout") stdout += text;
        else stderr += text;
        opts.emitOutput?.({ stream, text });
        managed?.append(stream, text);
      },
    });

    const winner = await Promise.race([
      runPromise.then((result) => ({ kind: "done" as const, result })),
      delay(opts.autoBgAfter).then(() => ({ kind: "background" as const })),
    ]);

    if (winner.kind === "done") {
      return formatForegroundResult(opts.command, winner.result);
    }

    managed = createManagedBackgroundJob({
      sessionId: opts.sessionId,
      command: opts.command,
      cwd: opts.cwd,
      stdout,
      stderr,
      kill: () => shell.killChildren(),
    });
    detachPersistentShell(opts.sessionId, shell);
    runPromise.then((result) => {
      managed?.complete({
        exitCode: result.exitCode,
        killed: result.aborted || result.timedOut,
      });
      void shell.close();
    }).catch(() => {
      managed?.complete({ exitCode: null, killed: true });
      void shell.close();
    });

    return {
      ok: true,
      output:
        `Command auto-backgrounded after ${opts.autoBgAfter}ms.\n` +
        `Background job id: ${managed.job.id}\n` +
        `Use \`job_output({ id: "${managed.job.id}" })\` to check progress.`,
    };
  } catch (err) {
    return { ok: false, output: `Command failed to start: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function runTransient(opts: RunFgOpts) {
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let lastActivity = startedAt;
  let timedOut = false;

  const proc = execa(opts.command, {
    shell: "/bin/sh",
    cwd: opts.cwd,
    stdin: "ignore",
    reject: false,
    all: false,
    buffer: false,
    cancelSignal: opts.signal,
  });

  proc.stdout?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    stdout = appendCapped(stdout, text);
    lastActivity = Date.now();
    opts.emitOutput?.({ stream: "stdout", text });
  });
  proc.stderr?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    stderr = appendCapped(stderr, text);
    lastActivity = Date.now();
    opts.emitOutput?.({ stream: "stderr", text });
  });

  const ticker = setInterval(() => {
    const now = Date.now();
    if (now - startedAt > opts.timeout) {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    } else if (now - lastActivity > opts.inactivity) {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }, 200);

  try {
    const winner = await Promise.race([
      proc.then((result) => ({ kind: "done" as const, result })).catch((err: unknown) => ({
        kind: "error" as const,
        err,
      })),
      delay(opts.autoBgAfter).then(() => ({ kind: "background" as const })),
    ]);

    clearInterval(ticker);

    if (winner.kind === "background") {
      const promoted = adoptBackgroundProcess({
        sessionId: opts.sessionId,
        command: opts.command,
        cwd: opts.cwd,
        proc,
        stdout,
        stderr,
      });
      return {
        ok: true,
        output:
          `Command auto-backgrounded after ${opts.autoBgAfter}ms.\n` +
          `Background job id: ${promoted.id}\n` +
          `Use \`job_output({ id: "${promoted.id}" })\` to check progress.`,
      };
    }

    if (winner.kind === "error") {
      const msg = winner.err instanceof Error ? winner.err.message : String(winner.err);
      return { ok: false, output: `Command failed to start: ${msg}` };
    }

    return formatForegroundResult(opts.command, {
      exitCode: winner.result.exitCode ?? null,
      stdout,
      stderr,
      timedOut,
      aborted: winner.result.isCanceled,
      durationMs: Date.now() - startedAt,
      cwd: opts.cwd,
    });
  } catch (err) {
    clearInterval(ticker);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `Command failed to start: ${msg}` };
  }
}

type RunBgOpts = {
  readonly sessionId: string;
  readonly command: string;
  readonly cwd: string;
  readonly emitOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
};

async function runAsBackground(opts: RunBgOpts) {
  const job = startBackgroundJob({
    sessionId: opts.sessionId,
    command: opts.command,
    cwd: opts.cwd,
  });
  // Fast-failure window: if the command exits within 1s, surface its result
  // directly so the model gets immediate feedback instead of a misleading
  // "running" status.
  const settled = await waitForJob(opts.sessionId, job.id, FAST_FAILURE_WINDOW_MS);
  if (settled?.done) {
    if (opts.emitOutput) {
      if (settled.stdout) opts.emitOutput({ stream: "stdout", text: settled.stdout });
      if (settled.stderr) opts.emitOutput({ stream: "stderr", text: settled.stderr });
    }
    return formatForegroundResult(opts.command, {
      exitCode: settled.exitCode,
      stdout: settled.stdout,
      stderr: settled.stderr,
      timedOut: false,
      aborted: settled.killed,
      durationMs: (settled.endedAt ?? Date.now()) - settled.startedAt,
      cwd: opts.cwd,
    });
  }
  return {
    ok: true,
    output:
      `Started background job: ${job.id}\n` +
      `Use \`job_output({ id: "${job.id}" })\` to read progress, ` +
      `or \`job_kill({ id: "${job.id}" })\` to terminate.`,
  };
}

type ForegroundLike = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  cwd: string;
};

function formatForegroundResult(_command: string, result: ForegroundLike) {
  const stdout = tailTruncate(result.stdout, MAX_OUTPUT_BYTES);
  const stderr = tailTruncate(result.stderr, MAX_OUTPUT_BYTES);
  const parts: string[] = [];
  parts.push(`exit=${result.exitCode ?? "null"}`);
  if (result.timedOut) parts.push("timed_out=true");
  if (result.aborted) parts.push("canceled=true");
  if (result.cwd) parts.push(`cwd=${result.cwd}`);
  if (stdout) parts.push(`--- stdout ---\n${stdout}`);
  if (stderr) parts.push(`--- stderr ---\n${stderr}`);
  if (!stdout && !stderr) parts.push("(no output)");
  return {
    ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
    output: parts.join("\n"),
    meta: {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    },
  };
}

/**
 * Tail-biased truncation: when output runs over the cap, errors and stack
 * traces near the bottom matter more than the boilerplate at the top.
 */
function tailTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const dropped = s.length - max;
  return `[...truncated ${dropped} bytes from head...]\n` + s.slice(s.length - max);
}

function appendCapped(current: string, addition: string): string {
  // Keep an in-memory cap of 4×MAX so the streaming buffer doesn't grow without
  // bound on chatty processes. Final output goes through tailTruncate.
  const merged = current + addition;
  const cap = MAX_OUTPUT_BYTES * 4;
  if (merged.length <= cap) return merged;
  return merged.slice(merged.length - cap);
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Persistent shell on by default on POSIX; off on Windows because pgrep,
 * eval-with-redirection and `$SHELL` aren't reliably present.
 */
function defaultPersistentShellEnabled(): boolean {
  return process.platform !== "win32";
}
