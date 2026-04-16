import { shellSensor } from "./shell.js";
import type { Sensor } from "./types.js";

/** Runs `tsc --noEmit` if the workspace has a tsconfig.json. */
export const typecheckSensor: Sensor = shellSensor({
  name: "typecheck",
  trigger: "after_turn",
  command: "npx --no-install tsc --noEmit",
  marker: "tsconfig.json",
});
