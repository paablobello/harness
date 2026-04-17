import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PREFS_PATH = join(homedir(), ".harness", "preferences.json");

export type UiPreferences = {
  theme?: string;
};

export async function loadPreferences(): Promise<UiPreferences> {
  try {
    const raw = await readFile(PREFS_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const theme = typeof obj["theme"] === "string" ? obj["theme"] : undefined;
      return theme !== undefined ? { theme } : {};
    }
    return {};
  } catch {
    return {};
  }
}

export async function savePreferences(prefs: UiPreferences): Promise<void> {
  try {
    await mkdir(dirname(PREFS_PATH), { recursive: true });
    await writeFile(PREFS_PATH, JSON.stringify(prefs, null, 2) + "\n");
  } catch {
    // Best effort: do not throw if the prefs file cannot be written.
  }
}

/**
 * Guesses whether the terminal has a dark or light background.
 *
 * Reads COLORFGBG (e.g. "15;0" = white text on black bg; "0;15" = black on white)
 * which is set by most modern terminals (xterm, iTerm2, VTE-based). Falls back to
 * "dark" when undetectable because that's the overwhelmingly common case.
 */
export function detectTerminalTheme(): "dark" | "light" {
  const raw = process.env["COLORFGBG"];
  if (!raw) return "dark";
  const parts = raw.split(";");
  const bg = parts[parts.length - 1];
  if (!bg) return "dark";
  const n = Number.parseInt(bg, 10);
  if (Number.isNaN(n)) return "dark";
  // ANSI palette: 0-6 and 8 are dark shades; 7 and 9-15 are light.
  return n === 7 || n >= 9 ? "light" : "dark";
}
