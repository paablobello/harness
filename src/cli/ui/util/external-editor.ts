import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Open `$EDITOR` (fallback: `$VISUAL`, then `nano`) on a temp file seeded with
 * `initial`. Resolves with the (trimmed) contents after the editor exits.
 *
 * Same pattern as `git commit --edit`: we drop Ink's raw-mode handle before
 * spawning so the editor owns the TTY, then restore it on return. Callers pass
 * `pauseInk` / `resumeInk` — typically `() => isRawModeSupported && setRawMode(...)`
 * from `useStdin()`.
 *
 * The temp file is always unlinked on exit, including errors; we swallow
 * cleanup failures because the OS will GC the tmp dir anyway.
 */
export type OpenEditorOptions = {
  readonly initial: string;
  /** Filename (inside the tmp dir) — helps editors pick the right syntax mode. */
  readonly filename?: string;
  readonly pauseInk?: () => void;
  readonly resumeInk?: () => void;
};

export async function openInExternalEditor(opts: OpenEditorOptions): Promise<string> {
  const editor = process.env["EDITOR"] || process.env["VISUAL"] || "nano";
  const dir = mkdtempSync(join(tmpdir(), "harness-editor-"));
  const file = join(dir, opts.filename ?? "message.md");
  writeFileSync(file, opts.initial, "utf8");

  try {
    opts.pauseInk?.();
    clearTerminalForEditor();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(editor, [file], { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", () => resolve());
    });
    return readFileSync(file, "utf8").replace(/\s+$/, "");
  } finally {
    clearTerminalForEditor();
    opts.resumeInk?.();
    try {
      unlinkSync(file);
    } catch {
      // best-effort tmp cleanup
    }
  }
}

function clearTerminalForEditor(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\x1b[0m\x1b[?25h\x1b[2J\x1b[H");
}
