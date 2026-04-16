import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { composeSystemPrompt } from "../../src/cli/shared.js";

describe("composeSystemPrompt", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "harness-cli-shared-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns the base prompt unchanged when no project guide exists", async () => {
    await expect(composeSystemPrompt("base", root)).resolves.toBe("base");
  });

  it("wraps AGENTS.md content as a project-guide context block", async () => {
    await writeFile(join(root, "AGENTS.md"), "Use tiny commits.");

    const prompt = await composeSystemPrompt("base", root);

    expect(prompt).toContain("base");
    expect(prompt).toContain("<project-guide>");
    expect(prompt).toContain("Use tiny commits.");
    expect(prompt).toContain("</project-guide>");
  });
});
