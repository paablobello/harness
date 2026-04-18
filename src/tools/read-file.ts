import { readFile, stat } from "node:fs/promises";

import { z } from "zod";

import { resolveWithinWorkspace } from "../runtime/workspace.js";
import type { ToolDefinition } from "../types.js";

const MAX_BYTES = 256 * 1024;

const input = z.object({
  path: z.string().min(1).describe("Path to read, relative to workspace root or absolute."),
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(MAX_BYTES)
    .optional()
    .describe(`Truncate after this many bytes (default ${MAX_BYTES}).`),
});

export const readFileTool: ToolDefinition<z.infer<typeof input>> = {
  name: "read_file",
  description: "Read a UTF-8 text file from the workspace. Returns file contents.",
  inputSchema: input,
  risk: "read",
  source: "builtin",
  async run(args, ctx) {
    const abs = await resolveWithinWorkspace(ctx.workspaceRoot, args.path);
    let st;
    try {
      st = await stat(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { ok: false, output: `File not found: ${args.path}` };
      }
      if (code === "EACCES" || code === "EPERM") {
        return { ok: false, output: `Permission denied: ${args.path}` };
      }
      throw err;
    }
    if (st.isDirectory()) {
      return {
        ok: false,
        output: `${args.path} is a directory. Use list_files to list its contents.`,
      };
    }
    if (!st.isFile()) {
      return { ok: false, output: `Not a regular file: ${args.path}` };
    }
    const limit = args.max_bytes ?? MAX_BYTES;
    const raw = await readFile(abs);
    const truncated = raw.byteLength > limit;
    const text = raw.slice(0, limit).toString("utf8");
    const suffix = truncated ? `\n[...truncated ${raw.byteLength - limit} bytes...]` : "";
    return {
      ok: true,
      output: text + suffix,
      meta: { bytes: raw.byteLength, truncated },
    };
  },
};
