import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { minimatch } from "minimatch";
import { z } from "zod";

import { resolveWithinWorkspace } from "../runtime/workspace.js";
import type { ToolDefinition } from "../types.js";

const MAX_ENTRIES = 2000;
const IGNORE_DIRS = new Set([".git", "node_modules", ".harness", "dist", "coverage", ".next"]);

const input = z.object({
  path: z.string().optional().describe("Directory to list (default: workspace root)."),
  glob: z.string().optional().describe('Optional glob filter, e.g. "**/*.ts".'),
  include_hidden: z.boolean().optional().describe("Include dotfiles. Default false."),
});

export const listFilesTool: ToolDefinition<z.infer<typeof input>> = {
  name: "list_files",
  description:
    "List files under a directory (recursive). Skips common vendor dirs (.git, node_modules, dist).",
  inputSchema: input,
  risk: "read",
  source: "builtin",
  async run(args, ctx) {
    const realRoot = await realpath(ctx.workspaceRoot);
    const base = await resolveWithinWorkspace(ctx.workspaceRoot, args.path ?? ".");
    const results: string[] = [];
    const includeHidden = args.include_hidden ?? false;
    const glob = args.glob;

    async function walk(dir: string): Promise<void> {
      if (results.length >= MAX_ENTRIES) return;
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (results.length >= MAX_ENTRIES) return;
        if (!includeHidden && ent.name.startsWith(".")) continue;
        if (ent.isDirectory() && IGNORE_DIRS.has(ent.name)) continue;
        const abs = join(dir, ent.name);
        const rel = relative(realRoot, abs) || ent.name;
        if (ent.isDirectory()) {
          await walk(abs);
        } else if (ent.isFile()) {
          if (!glob || minimatch(rel, glob, { dot: includeHidden })) {
            results.push(rel);
          }
        }
      }
    }

    const st = await stat(base);
    if (st.isFile()) return { ok: true, output: relative(realRoot, base) || base };
    await walk(base);
    const truncated = results.length >= MAX_ENTRIES;
    const body = results.join("\n");
    const suffix = truncated ? `\n[...truncated at ${MAX_ENTRIES} entries...]` : "";
    return { ok: true, output: body + suffix, meta: { count: results.length, truncated } };
  },
};
