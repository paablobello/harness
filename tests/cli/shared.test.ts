import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPolicy, buildToolSurface, composeSystemPrompt } from "../../src/cli/shared.js";
import { createBuiltinRegistry } from "../../src/tools/builtin.js";

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

describe("CLI shared builders", () => {
  it("builds the default tool surface when config does not override it", async () => {
    const surface = await buildToolSurface({}, { toolsEnabled: true, mcpEnabled: false });
    try {
      expect(surface.tools?.get("read_file")).toBeDefined();
      expect(surface.tools?.get("run_command")).toBeDefined();
    } finally {
      await surface.close();
    }
  });

  it("can disable tools entirely", async () => {
    const surface = await buildToolSurface({}, { toolsEnabled: false, mcpEnabled: false });
    await expect(surface.close()).resolves.toBeUndefined();
    expect(surface.tools).toBeUndefined();
  });

  it("builds policy from config policyRules", async () => {
    const tool = createBuiltinRegistry().get("read_file");
    expect(tool).toBeDefined();
    const policy = buildPolicy("default", async () => true, {
      policyRules: [{ match: { tool: "read_file" }, decision: "deny", reason: "no reads" }],
    });

    const decision = await policy.decide({ tool: tool!, input: { path: "x" } });

    expect(decision).toEqual({ decision: "deny", reason: "no reads" });
  });
});
