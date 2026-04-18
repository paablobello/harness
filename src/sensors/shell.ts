import { access } from "node:fs/promises";
import { join } from "node:path";

import { execa } from "execa";

import type { Sensor, SensorContext, SensorResult } from "./types.js";

const TIMEOUT_MS = 120_000;
const MAX_OUT = 8 * 1024;

/**
 * Generic "run a shell command and report" sensor used by the three computational
 * builtins (typecheck, lint, test). Skips via `applicable` if the marker file is absent.
 */
export function shellSensor(opts: {
  name: string;
  trigger: Sensor["trigger"];
  command: string;
  marker: string;
}): Sensor {
  return {
    name: opts.name,
    kind: "computational",
    trigger: opts.trigger,
    async applicable(ctx) {
      if ((opts.trigger === "after_turn" || opts.trigger === "final") && !ctx.workspaceChanged) {
        return false;
      }
      try {
        await access(join(ctx.workspaceRoot, opts.marker));
        return true;
      } catch {
        return false;
      }
    },
    async run(ctx: SensorContext): Promise<SensorResult> {
      try {
        const result = await execa(opts.command, {
          shell: "/bin/sh",
          cwd: ctx.cwd,
          timeout: TIMEOUT_MS,
          reject: false,
          stdin: "ignore",
          cancelSignal: ctx.signal,
        });
        const combined = (result.stdout ?? "") + "\n" + (result.stderr ?? "");
        const truncated =
          combined.length > MAX_OUT ? combined.slice(0, MAX_OUT) + "\n[...truncated...]" : combined;
        const ok = result.exitCode === 0;
        const message = ok
          ? `[${opts.name}] passed`
          : `[${opts.name}] FAILED (exit ${result.exitCode ?? "null"}):\n${truncated.trim()}`;
        return { ok, message, meta: { exitCode: result.exitCode } };
      } catch (err) {
        return {
          ok: false,
          message: `[${opts.name}] error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
