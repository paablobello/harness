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
