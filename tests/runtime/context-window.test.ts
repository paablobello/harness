import { describe, expect, it } from "vitest";

import { contextWindowFor } from "../../src/runtime/context-window.js";

describe("contextWindowFor", () => {
  it("returns a window for known Anthropic models", () => {
    expect(contextWindowFor("claude-sonnet-4-5")).toBe(200_000);
    expect(contextWindowFor("claude-3-5-sonnet-latest")).toBe(200_000);
  });

  it("returns a window for known OpenAI models", () => {
    expect(contextWindowFor("gpt-5")).toBe(400_000);
    expect(contextWindowFor("gpt-4o")).toBe(128_000);
    expect(contextWindowFor("gpt-4.1")).toBe(1_000_000);
  });

  it("returns undefined for unknown models so callers can degrade the UI", () => {
    expect(contextWindowFor("mystery-model-v99")).toBeUndefined();
  });
});
