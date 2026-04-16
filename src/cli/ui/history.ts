import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HISTORY_PATH = join(homedir(), ".harness", "history");
const MAX_HISTORY = 1000;

/**
 * Read past user inputs, newest first, deduplicated (preserving last occurrence).
 * The file format is JSONL with `{t, text}` objects. Corrupt lines are skipped.
 */
export async function loadHistory(): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(HISTORY_PATH, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { text?: unknown };
      if (typeof parsed.text !== "string") continue;
      if (seen.has(parsed.text)) continue;
      seen.add(parsed.text);
      out.push(parsed.text);
      if (out.length >= MAX_HISTORY) break;
    } catch {
      // skip malformed line
    }
  }
  return out;
}

export async function appendHistory(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    await mkdir(dirname(HISTORY_PATH), { recursive: true });
    await appendFile(HISTORY_PATH, JSON.stringify({ t: Date.now(), text: trimmed }) + "\n");
  } catch {
    // Best effort: failure to persist history must never crash the session.
  }
}

export function getHistoryPath(): string {
  return HISTORY_PATH;
}
