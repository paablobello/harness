import { readFile, writeFile } from "node:fs/promises";

import { z } from "zod";

import { resolveWithinWorkspace } from "../runtime/workspace.js";
import type { ToolDefinition } from "../types.js";

type PatchLine = { kind: " " | "-" | "+"; text: string };
type Hunk = {
  /** 1-based line in the original file, or null when header has no position
   *  (e.g. `@@` without `-N,M +N,M`, which Codex/OpenAI style emits). */
  oldStart: number | null;
  oldLines: number;
  newStart: number | null;
  newLines: number;
  lines: PatchLine[];
};

const input = z.object({
  path: z.string().min(1).describe("Target file, relative to workspace root."),
  unified_diff: z
    .string()
    .min(1)
    .describe(
      "A unified diff body — one or more `@@ ... @@` hunks separating " +
        "blocks of ` `/`-`/`+` lines. Both git-style headers with line " +
        "numbers (`@@ -12,5 +12,7 @@`) and numberless headers (`@@` on a " +
        "line by itself, as emitted by OpenAI's apply_patch) are accepted. " +
        "Context and `-` lines must match the current file exactly.",
    ),
});

export const applyPatchTool: ToolDefinition<z.infer<typeof input>> = {
  name: "apply_patch",
  description:
    "Apply a unified diff to a single file. Accepts both git-style hunk " +
    "headers (`@@ -N,M +N,M @@`) and numberless headers (`@@`). All hunks " +
    "are validated (dry-run) before writing; any mismatch aborts with the " +
    "file unchanged. Prefer `edit_file` for a single contiguous replacement.",
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
    let cursor = 0;
    for (const [hi, h] of hunks.entries()) {
      const result = applyHunk(working, h, offset, cursor);
      if (!result.ok) {
        const where = h.oldStart !== null ? `line ${h.oldStart}` : `hunk #${hi + 1}`;
        return { ok: false, output: `Hunk failed at ${where}: ${result.error}` };
      }
      working = result.lines;
      offset += result.delta;
      cursor = result.cursor;
    }

    const next = working.join("\n");
    await writeFile(abs, next, "utf8");
    const header = `Applied ${hunks.length} hunk(s) to ${args.path}.`;
    return {
      ok: true,
      output: `${header}\n${args.unified_diff.trim()}`,
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
      const parsed = parseHunkHeader(line);
      if (!parsed) throw new Error(`Malformed hunk header: ${line}`);
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
      // Strip a trailing empty context line produced by the final newline of
      // the diff (split("\n") always leaves a "" tail). It would falsely
      // extend the expected block and break context matching for numberless
      // headers; for numbered hunks it was cancelling against the file's own
      // trailing "" by luck.
      if (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === " " && last.text === "") body.pop();
      }
      hunks.push({ ...parsed, lines: body });
      continue;
    }
    i += 1;
  }
  return hunks;
}

/**
 * Accepts three hunk header shapes:
 *  - git-style with line numbers: `@@ -12,5 +12,7 @@` (optionally trailed
 *    by a function-context hint).
 *  - numberless: `@@` on its own line (used by OpenAI's Codex apply_patch).
 *  - numberless with hint: `@@ some context @@`.
 */
function parseHunkHeader(
  line: string,
): Pick<Hunk, "oldStart" | "oldLines" | "newStart" | "newLines"> | null {
  const git = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (git) {
    return {
      oldStart: Number(git[1]),
      oldLines: git[2] !== undefined ? Number(git[2]) : 1,
      newStart: Number(git[3]),
      newLines: git[4] !== undefined ? Number(git[4]) : 1,
    };
  }
  if (/^@@(\s.*@@)?\s*$/.test(line) || /^@@\s+.+\s+@@\s*$/.test(line)) {
    return { oldStart: null, oldLines: 0, newStart: null, newLines: 0 };
  }
  return null;
}

function applyHunk(
  lines: string[],
  hunk: Hunk,
  offset: number,
  cursor: number,
):
  | { ok: true; lines: string[]; delta: number; cursor: number }
  | { ok: false; error: string } {
  const expected = hunk.lines.filter((l) => l.kind !== "+").map((l) => l.text);
  const replacement = hunk.lines.filter((l) => l.kind !== "-").map((l) => l.text);

  let start: number;
  if (hunk.oldStart !== null) {
    start = hunk.oldStart - 1 + offset;
    for (let j = 0; j < expected.length; j += 1) {
      if (lines[start + j] !== expected[j]) {
        return {
          ok: false,
          error: formatDivergence(lines, start + j, expected[j] ?? ""),
        };
      }
    }
  } else {
    if (expected.length === 0) {
      return {
        ok: false,
        error:
          "numberless hunk has no context or removed lines to locate it; include at " +
          "least one unchanged ` ` or `-` line or use a `@@ -N,M +N,M @@` header.",
      };
    }
    const found = findSubsequence(lines, expected, cursor);
    if (found < 0) {
      // Second pass: find an anchor line (first non-empty in `expected`) and
      // walk forward to pinpoint the exact line where the file diverges from
      // the hunk. This gives the model an actionable diff instead of just
      // "could not locate".
      const anchorLocal = expected.findIndex((l) => l !== "");
      const anchorText = anchorLocal >= 0 ? expected[anchorLocal]! : expected[0]!;
      let anchorIdx = -1;
      for (let i = Math.max(0, cursor); i < lines.length; i += 1) {
        if (lines[i] === anchorText) {
          anchorIdx = i;
          break;
        }
      }
      if (anchorIdx < 0) {
        return {
          ok: false,
          error:
            `could not locate hunk context in file (searched from line ${cursor + 1}). ` +
            `Anchor line not found: ${JSON.stringify(anchorText)}. ` +
            "Re-read the file and regenerate the hunk, or use a header with line numbers.",
        };
      }
      const base = anchorIdx - Math.max(0, anchorLocal);
      for (let j = 0; j < expected.length; j += 1) {
        if (lines[base + j] !== expected[j]) {
          return {
            ok: false,
            error: formatDivergence(lines, base + j, expected[j] ?? ""),
          };
        }
      }
      // Shouldn't reach here: findSubsequence said no but anchor-walk says yes.
      start = base;
    } else {
      start = found;
    }
  }
  const next = [...lines.slice(0, start), ...replacement, ...lines.slice(start + expected.length)];
  return {
    ok: true,
    lines: next,
    delta: replacement.length - expected.length,
    // Advance cursor past the edited region but allow the next numberless
    // hunk to anchor on the last line of this one (hunks frequently share a
    // context line at their boundary).
    cursor: start + Math.max(1, replacement.length - 1),
  };
}

function findSubsequence(haystack: string[], needle: string[], from: number): number {
  if (needle.length === 0) return -1;
  const max = haystack.length - needle.length;
  outer: for (let i = Math.max(0, from); i <= max; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Build a multi-line error that shows both the divergence and ±2 lines of
 * surrounding context so the model (or a human) can correct the hunk on the
 * next attempt without re-reading the file from scratch.
 */
function formatDivergence(lines: string[], divergeIdx: number, expectedLine: string): string {
  const got = divergeIdx < lines.length ? lines[divergeIdx]! : "<end of file>";
  const out: string[] = [
    `context matches until line ${divergeIdx + 1} but diverges there:`,
    `  expected: ${JSON.stringify(expectedLine)}`,
    `  got:      ${JSON.stringify(got)}`,
    "context around the divergence:",
  ];
  const lo = Math.max(0, divergeIdx - 2);
  const hi = Math.min(lines.length - 1, divergeIdx + 1);
  for (let i = lo; i <= hi; i += 1) {
    const marker = i === divergeIdx ? "  <-- divergence" : "";
    const n = String(i + 1).padStart(4);
    out.push(`  ${n} | ${lines[i] ?? ""}${marker}`);
  }
  return out.join("\n");
}
