import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkAssertions, type Fixture } from "../../src/cli/eval.js";

async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-test-"));
  for (const [rel, body] of Object.entries(files)) {
    await writeFile(join(dir, rel), body, "utf8");
  }
  return dir;
}

describe("eval checkAssertions", () => {
  it("passes when all assertions hold", async () => {
    const dir = await workspace({ "fizzbuzz.js": 'console.log("Fizz", "Buzz", "FizzBuzz");' });
    try {
      const fixture: Fixture = {
        name: "fizzbuzz",
        task: "stub",
        assertions: {
          filesExist: ["fizzbuzz.js"],
          fileContains: [{ path: "fizzbuzz.js", matches: ["Fizz", "Buzz", "FizzBuzz"] }],
          command: { cmd: "node fizzbuzz.js", stdoutContains: ["FizzBuzz"] },
          maxToolCalls: 5,
        },
      };
      const failures: string[] = [];
      await checkAssertions(dir, fixture, 3, failures);
      expect(failures).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports missing files, missing substrings, bad exit, and excess tool calls", async () => {
    const dir = await workspace({ "exists.txt": "hello" });
    try {
      const fixture: Fixture = {
        name: "negative",
        task: "stub",
        assertions: {
          filesExist: ["missing.txt"],
          fileContains: [{ path: "exists.txt", matches: ["world"] }],
          command: { cmd: "false", exitCode: 0 },
          maxToolCalls: 2,
        },
      };
      const failures: string[] = [];
      await checkAssertions(dir, fixture, 5, failures);

      expect(failures.some((f) => f.includes("missing.txt"))).toBe(true);
      expect(failures.some((f) => f.includes("missing substring: world"))).toBe(true);
      expect(failures.some((f) => f.includes("command exit="))).toBe(true);
      expect(failures.some((f) => f.includes("tool calls 5"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats absent assertions as a no-op", async () => {
    const dir = await workspace({});
    try {
      const failures: string[] = [];
      await checkAssertions(dir, { name: "empty", task: "stub" }, 0, failures);
      expect(failures).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
