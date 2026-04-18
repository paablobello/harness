/**
 * Approximate context-window sizes (in tokens) for the models Harness knows
 * about. Returns `undefined` when the model is not in the table — callers
 * should treat that as "unknown" and degrade the UI accordingly, not guess.
 *
 * Update this table as providers ship new models. Values are taken from the
 * official provider docs at the time of writing and are meant as ceilings
 * for progress-bar style visualisations, not billing.
 */

const CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  // Anthropic — Claude 3.x
  "claude-3-5-sonnet-latest": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-haiku-latest": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
  "claude-3-7-sonnet-latest": 200_000,
  // Anthropic — Claude 4.x
  "claude-opus-4-5": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  // OpenAI
  "gpt-4o-mini": 128_000,
  "gpt-4o": 128_000,
  "gpt-4.1": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-5": 400_000,
  "gpt-5.4": 400_000,
};

export function contextWindowFor(model: string): number | undefined {
  return CONTEXT_WINDOWS[model];
}

/** Defaults used across runtime + UI if the harness config does not override them. */
export const DEFAULT_CONTEXT_THRESHOLDS = Object.freeze({
  warn: 0.8,
  compact: 0.9,
});

export type ContextZone = "ok" | "warn" | "critical" | "unknown";

export type ContextState = {
  /** Tokens consumed by the last input (source of truth: provider Usage event). */
  readonly lastInputTokens: number;
  /** Total context window for the model, if known. */
  readonly contextWindow: number | undefined;
  /** lastInputTokens / contextWindow, clamped to [0, 1]. Undefined when window is unknown. */
  readonly ratio: number | undefined;
  /** Classification against the configured thresholds. */
  readonly zone: ContextZone;
};

/**
 * Classify how full the context window is based on the last reported input tokens.
 * When the model has no known window, we return `zone: "unknown"` so callers can
 * hide the indicator instead of rendering a misleading 0%.
 */
export function classifyContext(
  lastInputTokens: number,
  model: string,
  thresholds: { readonly warn: number; readonly compact: number } = DEFAULT_CONTEXT_THRESHOLDS,
): ContextState {
  const contextWindow = contextWindowFor(model);
  if (contextWindow === undefined || contextWindow <= 0) {
    return { lastInputTokens, contextWindow: undefined, ratio: undefined, zone: "unknown" };
  }
  const raw = lastInputTokens / contextWindow;
  const ratio = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
  let zone: ContextZone = "ok";
  if (ratio >= thresholds.compact) zone = "critical";
  else if (ratio >= thresholds.warn) zone = "warn";
  return { lastInputTokens, contextWindow, ratio, zone };
}
