/**
 * Background-job registry for `run_command`. Lives per-session.
 *
 * Why this exists: tests, build watchers, dev servers etc. routinely run
 * longer than a model "turn" worth of patience. Crush handles this by
 * auto-backgrounding any command that exceeds a threshold (default 60s),
 * returning a job-id, and exposing a `job_output` tool the model can call
 * later to peek at progress or kill the job.
 *
 * Storage model is intentionally trivial: in-memory map keyed by sessionId,
 * each job owns its own `execa` subprocess and rolling stdout/stderr buffers
 * (capped at 256KB each so a chatty server doesn't OOM us). The session's
 * `SessionEnd` cleanup is responsible for killing every live job — see
 * `releaseSessionJobs`.
 */

import { randomUUID } from "node:crypto";
import { execa } from "execa";

const MAX_BUFFER_BYTES = 256 * 1024;
const KILL_GRACE_MS = 200;

export type BackgroundJob = {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: number;
  done: boolean;
  exitCode: number | null;
  killed: boolean;
  /** Rolling buffer of stdout, capped to `MAX_BUFFER_BYTES` (oldest dropped). */
  stdout: string;
  stderr: string;
  endedAt: number | null;
};

type InternalJob = BackgroundJob & {
  readonly proc: ReturnType<typeof execa>;
};

const jobsBySession = new Map<string, Map<string, InternalJob>>();

export type StartJobOptions = {
  readonly sessionId: string;
  readonly command: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
};

export function startBackgroundJob(opts: StartJobOptions): BackgroundJob {
  const id = randomUUID();
  const proc = execa(opts.command, {
    shell: "/bin/sh",
    cwd: opts.cwd,
    ...(opts.env ? { env: opts.env } : {}),
    stdin: "ignore",
    reject: false,
    all: false,
    buffer: false,
  });

  const job: InternalJob = {
    id,
    command: opts.command,
    cwd: opts.cwd,
    startedAt: Date.now(),
    done: false,
    exitCode: null,
    killed: false,
    stdout: "",
    stderr: "",
    endedAt: null,
    proc,
  };

  proc.stdout?.on("data", (chunk: Buffer | string) => {
    job.stdout = appendCapped(job.stdout, chunk.toString());
  });
  proc.stderr?.on("data", (chunk: Buffer | string) => {
    job.stderr = appendCapped(job.stderr, chunk.toString());
  });

  proc.then((result) => {
    job.done = true;
    job.exitCode = result.exitCode ?? null;
    job.endedAt = Date.now();
  }).catch(() => {
    job.done = true;
    job.endedAt = Date.now();
  });

  let bucket = jobsBySession.get(opts.sessionId);
  if (!bucket) {
    bucket = new Map();
    jobsBySession.set(opts.sessionId, bucket);
  }
  bucket.set(id, job);

  return snapshot(job);
}

export function getJob(sessionId: string, jobId: string): BackgroundJob | null {
  const bucket = jobsBySession.get(sessionId);
  if (!bucket) return null;
  const job = bucket.get(jobId);
  return job ? snapshot(job) : null;
}

export function listJobs(sessionId: string): BackgroundJob[] {
  const bucket = jobsBySession.get(sessionId);
  if (!bucket) return [];
  return [...bucket.values()].map(snapshot);
}

/**
 * Wait up to `ms` for a job to finish. Used by `run_command`'s
 * fast-failure detection (1s wait after starting a background job to catch
 * commands that died immediately).
 */
export async function waitForJob(
  sessionId: string,
  jobId: string,
  ms: number,
): Promise<BackgroundJob | null> {
  const bucket = jobsBySession.get(sessionId);
  if (!bucket) return null;
  const job = bucket.get(jobId);
  if (!job) return null;
  if (job.done) return snapshot(job);
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (job.done) return snapshot(job);
    await delay(20);
  }
  return snapshot(job);
}

export async function killJob(sessionId: string, jobId: string): Promise<BackgroundJob | null> {
  const bucket = jobsBySession.get(sessionId);
  if (!bucket) return null;
  const job = bucket.get(jobId);
  if (!job) return null;
  if (job.done) return snapshot(job);
  job.killed = true;
  try {
    job.proc.kill("SIGTERM");
  } catch {
    // already dead
  }
  await delay(KILL_GRACE_MS);
  if (!job.done) {
    try {
      job.proc.kill("SIGKILL");
    } catch {
      // already dead
    }
  }
  // Give the close handler a tick to mark `done`.
  await delay(20);
  return snapshot(job);
}

/** Called from `SessionEnd`: kill every live job for a session. */
export async function releaseSessionJobs(sessionId: string): Promise<void> {
  const bucket = jobsBySession.get(sessionId);
  if (!bucket) return;
  jobsBySession.delete(sessionId);
  for (const job of bucket.values()) {
    if (job.done) continue;
    job.killed = true;
    try {
      job.proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  await delay(KILL_GRACE_MS);
  for (const job of bucket.values()) {
    if (job.done) continue;
    try {
      job.proc.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

/** Test helper: nuke all sessions. */
export function __resetBackgroundJobs(): void {
  for (const sessionId of [...jobsBySession.keys()]) {
    void releaseSessionJobs(sessionId);
  }
  jobsBySession.clear();
}

function snapshot(job: InternalJob): BackgroundJob {
  return {
    id: job.id,
    command: job.command,
    cwd: job.cwd,
    startedAt: job.startedAt,
    done: job.done,
    exitCode: job.exitCode,
    killed: job.killed,
    stdout: job.stdout,
    stderr: job.stderr,
    endedAt: job.endedAt,
  };
}

function appendCapped(current: string, addition: string): string {
  const merged = current + addition;
  if (merged.length <= MAX_BUFFER_BYTES) return merged;
  // Keep the tail (more useful for debugging than the head).
  return merged.slice(merged.length - MAX_BUFFER_BYTES);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
