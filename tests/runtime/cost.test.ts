import { describe, expect, it } from "vitest";

import { computeCost, hasPricing } from "../../src/runtime/cost.js";

describe("hasPricing", () => {
  it("returns true for tabulated Anthropic and OpenAI models", () => {
    expect(hasPricing("claude-sonnet-4-5")).toBe(true);
    expect(hasPricing("gpt-4o")).toBe(true);
  });

  it("returns false for unknown models so the UI can show 'cost n/a'", () => {
    expect(hasPricing("gpt-5.4")).toBe(false);
    expect(hasPricing("mystery-99")).toBe(false);
  });
});

describe("computeCost", () => {
  it("prices tokens per 1M for a tabulated model", () => {
    const cost = computeCost("gpt-4o", 1_000_000, 500_000);
    // 2.5 * 1 + 10 * 0.5
    expect(cost).toBeCloseTo(7.5);
  });

  it("returns undefined when the model is unknown (caller must treat as unknown, not zero)", () => {
    expect(computeCost("mystery-99", 1_000_000, 500_000)).toBeUndefined();
  });
});
