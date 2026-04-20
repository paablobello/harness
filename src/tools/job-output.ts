import { z } from "zod";

import { getJob, listJobs } from "../runtime/background-jobs.js";
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
});

export const jobOutputTool: ToolDefinition<z.infer<typeof input>> = {
  name: "job_output",
  description:
    "Inspect or terminate background commands previously started by `run_command`. " +
    "Without `id`, returns a summary of every live job in the session. With `id`, " +
    "returns the job's accumulated stdout/stderr (capped at 256KB total). Use " +
    "`job_kill` to terminate a job.",
  inputSchema: input,
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
