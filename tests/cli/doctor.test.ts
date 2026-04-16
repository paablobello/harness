import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkHarnessConfig } from "../../src/cli/doctor.js";

describe("doctor harness config check", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "harness-doctor-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("treats missing config as an optional warning", async () => {
    const check = await checkHarnessConfig(root, true);

    expect(check.ok).toBe(false);
    expect(check.required).toBe(false);
    expect(check.detail).toMatch(/none found/);
  });

  it("validates a JavaScript config without connecting MCP servers", async () => {
    await writeFile(
      join(root, "harness.config.mjs"),
      `export default {
        system: "doctor test",
        mcpServers: [{ name: "fake", command: "definitely-not-run" }]
      };`,
      "utf8",
    );

    const check = await checkHarnessConfig(root, true);

    expect(check.ok).toBe(true);
    expect(check.detail).toContain("system");
    expect(check.detail).toContain("1 MCP server(s)");
  });

  it("fails invalid config as a required check", async () => {
    await writeFile(join(root, "harness.config.mjs"), "export default { mcpServers: [{}] };");

    const check = await checkHarnessConfig(root, true);

    expect(check.ok).toBe(false);
    expect(check.required).toBe(true);
    expect(check.detail).toMatch(/mcpServers\[0\]\.name/);
  });

  it("can skip config validation", async () => {
    await writeFile(join(root, "harness.config.ts"), "export default {};");

    const check = await checkHarnessConfig(root, false);

    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/skipped/);
  });
});
