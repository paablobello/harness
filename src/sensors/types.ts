/**
 * Sensors are the "feedback" half of a Fowler-style harness: they observe the
 * workspace after an action (or a turn) and return evidence the model should
 * consider before its next step.
 *
 * - `computational` sensors are deterministic and cheap (typecheck, lint, tests)
 * - `inferential` sensors use another LLM call (llm-review) — opt-in.
 *
 * Sensor output is injected as a `<sensor-feedback>` user message before the
 * next model turn, so the model sees it just like tool results.
 */

export type SensorKind = "computational" | "inferential";
export type SensorTrigger = "after_tool" | "after_turn" | "final";

export type SensorContext = {
  workspaceRoot: string;
  cwd: string;
  /** Tool just executed (if trigger === "after_tool"). */
  lastTool?: { name: string; input: unknown; ok: boolean; output: string };
  signal: AbortSignal;
};

export type SensorResult = {
  ok: boolean;
  /** Optional text appended to the next turn's context. Empty → skip injection. */
  message: string;
  meta?: Record<string, unknown>;
};

export type Sensor = {
  name: string;
  kind: SensorKind;
  trigger: SensorTrigger;
  /** Return false to skip this sensor for the given context (e.g. project has no tsconfig). */
  applicable?(ctx: SensorContext): Promise<boolean> | boolean;
  run(ctx: SensorContext): Promise<SensorResult>;
};
