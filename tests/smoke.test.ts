import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("scaffold", () => {
  it("exports a semver-shaped version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
