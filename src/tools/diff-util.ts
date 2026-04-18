import { createTwoFilesPatch } from "diff";

/**
 * Produces a compact unified diff suitable for the UI's DiffView. Uses the
 * `diff` package so hunk headers and context lines follow the standard
 * `@@ -a,b +c,d @@` format (`DiffView` and `apply_patch` understand it).
 */
export function toUnifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  const raw = createTwoFilesPatch(path, path, before, after, "", "", { context: 2 });
  // Drop the first two lines the library emits ("Index: …" is not emitted
  // here, but the "--- a.ts\n+++ a.ts" pair is noisy in a tool result
  // because the user already sees the tool header with the file path).
  const lines = raw.split("\n");
  const hunkStart = lines.findIndex((l) => l.startsWith("@@"));
  if (hunkStart < 0) return raw.trim();
  return lines.slice(hunkStart).join("\n").trim();
}
