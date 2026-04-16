import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { resolveWithinWorkspace } from "../runtime/workspace.js";
import type { ToolDefinition } from "../types.js";

const input = z.object({
  path: z.string().min(1).describe("Path to the file to edit, relative to workspace root."),
  old_str: z
    .string()
    .describe(
      "Exact substring to replace. Must appear exactly once in the file. " +
        "Leave empty to create a new file with `new_str` as contents.",
    ),
  new_str: z.string().describe("Replacement text."),
});

export const editFileTool: ToolDefinition<z.infer<typeof input>> = {
  name: "edit_file",
  description:
    "Edit a file by replacing a unique substring. Fails if `old_str` appears 0 or >1 times. " +
    "When `old_str` is empty, creates a new file with `new_str` as contents.",
  inputSchema: input,
  risk: "write",
  source: "builtin",
  async run(args, ctx) {
    const abs = await resolveWithinWorkspace(ctx.workspaceRoot, args.path);

    if (args.old_str === "") {
      try {
        await readFile(abs, "utf8");
        return {
          ok: false,
          output: `File already exists: ${args.path}. Use a non-empty old_str to edit.`,
        };
      } catch {
        // not found → create
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, args.new_str, "utf8");
      return { ok: true, output: `Created ${args.path} (${args.new_str.length} chars).` };
    }

    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      return { ok: false, output: `File not found: ${args.path}` };
    }

    const idx = content.indexOf(args.old_str);
    if (idx === -1) {
      return {
        ok: false,
        output: `old_str not found in ${args.path}. Read the file first to get exact text (including whitespace).`,
      };
    }
    const second = content.indexOf(args.old_str, idx + args.old_str.length);
    if (second !== -1) {
      return {
        ok: false,
        output: `old_str appears more than once in ${args.path}. Include more surrounding context to make it unique.`,
      };
    }

    const next = content.slice(0, idx) + args.new_str + content.slice(idx + args.old_str.length);
    await writeFile(abs, next, "utf8");
    const before = content.split("\n").length;
    const after = next.split("\n").length;
    return {
      ok: true,
      output: `Edited ${args.path}: ${before} → ${after} lines.`,
      meta: { bytesBefore: content.length, bytesAfter: next.length },
    };
  },
};
