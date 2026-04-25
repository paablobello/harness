import { execa } from "execa";

/**
 * Best-effort: copy `text` to the OS clipboard. Returns false silently when
 * the platform tool is missing (xclip not installed, etc.) — callers in the
 * UI use this for /status and /usage hotkeys where failure is non-fatal.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const cmd =
    process.platform === "darwin"
      ? { file: "pbcopy", args: [] as string[] }
      : process.platform === "win32"
        ? { file: "clip", args: [] as string[] }
        : { file: "xclip", args: ["-selection", "clipboard"] };
  try {
    await execa(cmd.file, cmd.args, { input: text });
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort: open `path` with the OS handler. Detached + ignored stdio so
 * the spawned editor doesn't try to share our TTY.
 */
export async function openInOs(path: string): Promise<boolean> {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    await execa(cmd, [path], { detached: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
