import { describe, expect, it } from "vitest";

import { isExitInput, isLikelyHarnessInvocation } from "../../src/cli/chat.js";

describe("chat input helpers", () => {
  it("treats bare exit commands as local chat exits", () => {
    expect(isExitInput("exit")).toBe(true);
    expect(isExitInput(" quit ")).toBe(true);
    expect(isExitInput("q")).toBe(true);
    expect(isExitInput("/exit")).toBe(true);
  });

  it("detects accidental shell invocations typed inside chat", () => {
    expect(isLikelyHarnessInvocation("harness --provider openai")).toBe(true);
    expect(isLikelyHarnessInvocation("harness")).toBe(true);
    expect(isLikelyHarnessInvocation("please use harness")).toBe(false);
  });
});
