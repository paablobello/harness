import { readFile, writeFile } from "node:fs/promises";

import { z } from "zod";

import { resolveWithinWorkspace } from "../runtime/workspace.js";
import type { ToolDefinition } from "../types.js";

type PatchLine = { kind: " " | "-" | "+"; text: string };
type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: PatchLine[];
};

const input = z.object({
  path: z.string().min(1).describe("Target file, relative to workspace root."),
  unified_diff: z
    .string()
    .min(1)
    .describe(
      "A unified diff body for the file — one or more `@@ ... @@` hunks. " +
        "Context/minus lines must match the current file exactly.",
    ),
});

export const applyPatchTool: ToolDefinition<z.infer<typeof input>> = {
  name: "apply_patch",
  description:
    "Apply a unified diff to a single file. All hunks are validated (dry-run) before " +
    "writing; any mismatch aborts with the file unchanged.",
  inputSchema: input,
  risk: "write",
  source: "builtin",
  async run(args, ctx) {
    const abs = await resolveWithinWorkspace(ctx.workspaceRoot, args.path);

    let original: string;
    try {
      original = await readFile(abs, "utf8");
    } catch {
      return { ok: false, output: `File not found: ${args.path}` };
    }

    let hunks: Hunk[];
    try {
      hunks = parseHunks(args.unified_diff);
    } catch (err) {
      return { ok: false, output: `Invalid unified diff: ${(err as Error).message}` };
    }
    if (hunks.length === 0) {
      return { ok: false, output: "No hunks found in unified_diff." };
    }

    const originalLines = original.split("\n");
    let working = originalLines;
    let offset = 0;
    for (const h of hunks) {
      const result = applyHunk(working, h, offset);
      if (!result.ok) {
        return { ok: false, output: `Hunk failed at line ${h.oldStart}: ${result.error}` };
      }
      working = result.lines;
      offset += result.delta;
    }

    const next = working.join("\n");
    await writeFile(abs, next, "utf8");
    return {
      ok: true,
      output: `Applied ${hunks.length} hunk(s) to ${args.path}.`,
      meta: { hunks: hunks.length, bytesBefore: original.length, bytesAfter: next.length },
    };
  },
};

function parseHunks(diff: string): Hunk[] {
  const lines = diff.split("\n");
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("---") || line.startsWith("+++") || line === "") {
      i += 1;
      continue;
    }
    if (line.startsWith("@@")) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!header) throw new Error(`Malformed hunk header: ${line}`);
      const oldStart = Number(header[1]);
      const oldLines = header[2] !== undefined ? Number(header[2]) : 1;
      const newStart = Number(header[3]);
      const newLines = header[4] !== undefined ? Number(header[4]) : 1;
      const body: PatchLine[] = [];
      i += 1;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.startsWith("@@") || l.startsWith("---") || l.startsWith("+++")) break;
        if (l === "") {
          body.push({ kind: " ", text: "" });
          i += 1;
          continue;
        }
        const kind = l[0];
        if (kind !== " " && kind !== "-" && kind !== "+" && kind !== "\\") {
          break;
        }
        if (kind === "\\") {
          i += 1;
          continue;
        }
        body.push({ kind, text: l.slice(1) });
        i += 1;
      }
      hunks.push({ oldStart, oldLines, newStart, newLines, lines: body });
      continue;
    }
    i += 1;
  }
  return hunks;
}

function applyHunk(
  lines: string[],
  hunk: Hunk,
  offset: number,
): { ok: true; lines: string[]; delta: number } | { ok: false; error: string } {
  const expected = hunk.lines.filter((l) => l.kind !== "+").map((l) => l.text);
  const replacement = hunk.lines.filter((l) => l.kind !== "-").map((l) => l.text);
  const start = hunk.oldStart - 1 + offset;
  for (let j = 0; j < expected.length; j += 1) {
    if (lines[start + j] !== expected[j]) {
      return {
        ok: false,
        error: `context mismatch at ${start + j + 1}: expected ${JSON.stringify(
          expected[j],
        )}, got ${JSON.stringify(lines[start + j])}`,
      };
    }
  }
  const next = [...lines.slice(0, start), ...replacement, ...lines.slice(start + expected.length)];
  return { ok: true, lines: next, delta: replacement.length - expected.length };
}
