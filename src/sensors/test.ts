import { shellSensor } from "./shell.js";
import type { Sensor } from "./types.js";

/** Runs `vitest run` on the workspace if a vitest config exists. Trigger = final only. */
export const testSensor: Sensor = shellSensor({
  name: "test",
  trigger: "final",
  command: "npx --no-install vitest run",
  marker: "vitest.config.ts",
});
