import { lintSensor } from "./lint.js";
import { testSensor } from "./test.js";
import { typecheckSensor } from "./typecheck.js";
import type { Sensor } from "./types.js";

export { llmReviewSensor } from "./llm-review.js";
export { lintSensor, testSensor, typecheckSensor };

export function createBuiltinSensors(): Sensor[] {
  return [typecheckSensor, lintSensor, testSensor];
}
