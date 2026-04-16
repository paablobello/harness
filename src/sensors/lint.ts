import { shellSensor } from "./shell.js";
import type { Sensor } from "./types.js";

/** Runs `eslint .` if the workspace has an eslint config. */
export const lintSensor: Sensor = shellSensor({
  name: "lint",
  trigger: "after_turn",
  command: "npx --no-install eslint .",
  marker: "eslint.config.js",
});
