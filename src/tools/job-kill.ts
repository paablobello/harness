import { z } from "zod";

import { killJob } from "../runtime/background-jobs.js";
import type { ToolDefinition } from "../types.js";

const input = z.object({
  id: z.string().min(1).describe("Background job id returned by `run_command`."),
});

export const jobKillTool: ToolDefinition<z.infer<typeof input>> = {
  name: "job_kill",
  description:
    "Terminate a background command previously started by `run_command`. Sends SIGTERM, " +
    "then SIGKILL after a short grace period if needed.",
  inputSchema: input,
  risk: "execute",
  source: "builtin",
  async run(args, ctx) {
    const killed = await killJob(ctx.sessionId, args.id);
    if (!killed) return { ok: false, output: `No such job: ${args.id}` };
    return {
      ok: true,
      output:
        `Killed ${killed.id}.\n` +
        `exit=${killed.exitCode ?? "null"} done=${killed.done} killed=${killed.killed}`,
    };
  },
};
