import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { z } from "zod";

import { resolveWithinWorkspace } from "../runtime/workspace.js";
import type { ToolDefinition } from "../types.js";

const MAX_MATCHES = 200;
const MAX_BYTES_PER_FILE = 2 * 1024 * 1024;
const IGNORE_DIRS = new Set([".git", "node_modules", ".harness", "dist", "coverage", ".next"]);

const input = z.object({
  pattern: z.string().min(1).describe("Regex pattern to search for."),
  path: z.string().optional().describe("Directory to search (default: workspace root)."),
  case_insensitive: z.boolean().optional().describe("Case-insensitive match."),
  include_hidden: z.boolean().optional(),
});

export const grepFilesTool: ToolDefinition<z.infer<typeof input>> = {
  name: "grep_files",
  description: "Search for a regex pattern across files. Returns path:line:match lines.",
  inputSchema: input,
  risk: "read",
  source: "builtin",
  async run(args, ctx) {
    const realRoot = await realpath(ctx.workspaceRoot);
    const base = await resolveWithinWorkspace(ctx.workspaceRoot, args.path ?? ".");
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, args.case_insensitive ? "i" : "");
    } catch (err) {
      return { ok: false, output: `Invalid regex: ${(err as Error).message}` };
    }
    const includeHidden = args.include_hidden ?? false;
    const matches: string[] = [];

    async function search(file: string): Promise<void> {
      if (matches.length >= MAX_MATCHES) return;
      const st = await stat(file);
      if (st.size > MAX_BYTES_PER_FILE) return;
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch {
        return;
      }
      const rel = relative(realRoot, file) || file;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (matches.length >= MAX_MATCHES) return;
        const line = lines[i]!;
        if (regex.test(line)) {
          const trimmed = line.length > 400 ? line.slice(0, 400) + "…" : line;
          matches.push(`${rel}:${i + 1}:${trimmed}`);
        }
      }
    }

    async function walk(dir: string): Promise<void> {
      if (matches.length >= MAX_MATCHES) return;
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (matches.length >= MAX_MATCHES) return;
        if (!includeHidden && ent.name.startsWith(".")) continue;
        if (ent.isDirectory() && IGNORE_DIRS.has(ent.name)) continue;
        const abs = join(dir, ent.name);
        if (ent.isDirectory()) await walk(abs);
        else if (ent.isFile()) await search(abs);
      }
    }

    let baseStat;
    try {
      baseStat = await stat(base);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { ok: false, output: `Path not found: ${args.path ?? "."}` };
      }
      if (code === "EACCES" || code === "EPERM") {
        return { ok: false, output: `Permission denied: ${args.path ?? "."}` };
      }
      throw err;
    }
    if (baseStat.isFile()) await search(base);
    else await walk(base);

    const truncated = matches.length >= MAX_MATCHES;
    const body = matches.length > 0 ? matches.join("\n") : "(no matches)";
    const suffix = truncated ? `\n[...truncated at ${MAX_MATCHES} matches...]` : "";
    return { ok: true, output: body + suffix, meta: { count: matches.length, truncated } };
  },
};
