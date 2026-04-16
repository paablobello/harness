import type { Sensor } from "./types.js";

/**
 * Inferential sensor stub. In a real setup this would call a model with the
 * diff + the task and return a review summary. Disabled by default to avoid
 * silent spend during normal runs.
 */
export const llmReviewSensor: Sensor = {
  name: "llm_review",
  kind: "inferential",
  trigger: "final",
  async applicable() {
    return false;
  },
  async run() {
    return { ok: true, message: "" };
  },
};
