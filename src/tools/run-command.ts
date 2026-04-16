import { execa } from "execa";
import { z } from "zod";

import { resolveWithinWorkspace } from "../runtime/workspace.js";
import type { ToolDefinition } from "../types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024;

const input = z.object({
  command: z.string().min(1).describe("Shell command to execute. Runs via /bin/sh -c."),
  cwd: z.string().optional().describe("Working directory relative to workspace (default: root)."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
});

export const runCommandTool: ToolDefinition<z.infer<typeof input>> = {
  name: "run_command",
  description:
    "Run a shell command inside the workspace. Stdin is closed; stdout/stderr are captured " +
    "and truncated. Times out after 30s by default. Policy defaults deny destructive patterns.",
  inputSchema: input,
  risk: "execute",
  source: "builtin",
  async run(args, ctx) {
    const cwd = await resolveWithinWorkspace(ctx.workspaceRoot, args.cwd ?? ".");
    const timeout = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    try {
      const result = await execa(args.command, {
        shell: "/bin/sh",
        cwd,
        timeout,
        stdin: "ignore",
        reject: false,
        all: false,
        maxBuffer: MAX_OUTPUT_BYTES * 4,
        cancelSignal: ctx.signal,
      });

      const stdout = truncate(result.stdout ?? "", MAX_OUTPUT_BYTES);
      const stderr = truncate(result.stderr ?? "", MAX_OUTPUT_BYTES);
      const parts: string[] = [];
      parts.push(`exit=${result.exitCode ?? "null"}`);
      if (result.timedOut) parts.push("timed_out=true");
      if (result.isCanceled) parts.push("canceled=true");
      if (stdout) parts.push(`--- stdout ---\n${stdout}`);
      if (stderr) parts.push(`--- stderr ---\n${stderr}`);
      if (!stdout && !stderr) parts.push("(no output)");

      return {
        ok: result.exitCode === 0,
        output: parts.join("\n"),
        meta: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `Command failed to start: ${msg}` };
    }
  },
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n[...truncated ${s.length - max} bytes...]`;
}
