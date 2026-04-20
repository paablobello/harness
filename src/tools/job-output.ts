import { z } from "zod";

import { getJob, killJob, listJobs } from "../runtime/background-jobs.js";
import type { ToolDefinition } from "../types.js";

const input = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "Background job id returned by `run_command`. Omit to list all live jobs in the session.",
    ),
  tail_lines: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Limit the response to the last N lines of output (default: full buffer)."),
  kill: z
    .boolean()
    .optional()
    .describe("If true, send SIGTERM (then SIGKILL after 200ms) to the job."),
});

export const jobOutputTool: ToolDefinition<z.infer<typeof input>> = {
  name: "job_output",
  description:
    "Inspect or terminate background commands previously started by `run_command`. " +
    "Without `id`, returns a summary of every live job in the session. With `id`, " +
    "returns the job's accumulated stdout/stderr (capped at 256KB total). Pass " +
    "`kill: true` to terminate.",
  inputSchema: input,
  // Listing or reading job output is a read; killing is risk:execute, but the
  // spawning `run_command` already went through policy and the user-facing
  // job is theirs to manage. We mark it `read` so it doesn't pop a confirm
  // dialog every poll; the policy default for `job_output` is `allow`.
  risk: "read",
  source: "builtin",
  async run(args, ctx) {
    if (!args.id) {
      const jobs = listJobs(ctx.sessionId);
      if (jobs.length === 0) return { ok: true, output: "No background jobs." };
      const lines = jobs.map((j) => {
        const status = j.done ? `done(exit=${j.exitCode ?? "null"})` : "running";
        const ageMs = (j.endedAt ?? Date.now()) - j.startedAt;
        return `- ${j.id}  ${status}  ${ageMs}ms  cwd=${j.cwd}  cmd=${truncate(j.command, 80)}`;
      });
      return { ok: true, output: lines.join("\n") };
    }

    if (args.kill) {
      const killed = await killJob(ctx.sessionId, args.id);
      if (!killed) return { ok: false, output: `No such job: ${args.id}` };
      return {
        ok: true,
        output:
          `Killed ${killed.id}.\n` +
          `exit=${killed.exitCode ?? "null"} done=${killed.done} killed=${killed.killed}`,
      };
    }

    const job = getJob(ctx.sessionId, args.id);
    if (!job) return { ok: false, output: `No such job: ${args.id}` };

    const stdout = args.tail_lines ? lastLines(job.stdout, args.tail_lines) : job.stdout;
    const stderr = args.tail_lines ? lastLines(job.stderr, args.tail_lines) : job.stderr;
    const ageMs = (job.endedAt ?? Date.now()) - job.startedAt;
    const status = job.done ? `done(exit=${job.exitCode ?? "null"})` : "running";
    const parts: string[] = [
      `id=${job.id} status=${status} age=${ageMs}ms cwd=${job.cwd}`,
      `cmd: ${job.command}`,
    ];
    if (stdout) parts.push(`--- stdout ---\n${stdout}`);
    if (stderr) parts.push(`--- stderr ---\n${stderr}`);
    if (!stdout && !stderr) parts.push("(no output yet)");
    return {
      ok: job.done ? job.exitCode === 0 : true,
      output: parts.join("\n"),
      meta: {
        done: job.done,
        exitCode: job.exitCode,
        killed: job.killed,
      },
    };
  },
};

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function lastLines(s: string, n: number): string {
  const lines = s.split("\n");
  if (lines.length <= n) return s;
  return lines.slice(-n).join("\n");
}
