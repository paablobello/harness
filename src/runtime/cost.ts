/**
 * Token pricing for common Anthropic + OpenAI models, USD per 1M tokens.
 * Returns `undefined` when the model is not in the table — callers should
 * treat missing cost as "unknown", not zero.
 */

type Pricing = { readonly inputPer1M: number; readonly outputPer1M: number };

const PRICING: Readonly<Record<string, Pricing>> = {
  // Anthropic — Claude 3.5 / 3.7
  "claude-3-5-sonnet-latest": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-5-sonnet-20241022": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-3-5-haiku-latest": { inputPer1M: 0.8, outputPer1M: 4.0 },
  "claude-3-5-haiku-20241022": { inputPer1M: 0.8, outputPer1M: 4.0 },
  "claude-3-7-sonnet-latest": { inputPer1M: 3.0, outputPer1M: 15.0 },
  // Anthropic — Claude 4.x
  "claude-opus-4-5": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-opus-4-6": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-sonnet-4-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-haiku-4-5-20251001": { inputPer1M: 1.0, outputPer1M: 5.0 },
  // OpenAI
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0 },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "gpt-5": { inputPer1M: 5.0, outputPer1M: 20.0 },
};

export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const p = PRICING[model];
  if (!p) return undefined;
  return (inputTokens / 1_000_000) * p.inputPer1M + (outputTokens / 1_000_000) * p.outputPer1M;
}
