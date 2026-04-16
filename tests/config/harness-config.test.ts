import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findHarnessConfig, loadHarnessConfig } from "../../src/config/harness-config.js";

describe("harness config loader", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "harness-config-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns an empty config when no file exists", async () => {
    await expect(findHarnessConfig(root)).resolves.toBeNull();
    await expect(loadHarnessConfig(root)).resolves.toEqual({ path: null, config: {} });
  });

  it("loads a default export from harness.config.mjs", async () => {
    await writeFile(
      join(root, "harness.config.mjs"),
      'export default { system: "from config", maxToolsPerUserTurn: 3 };',
      "utf8",
    );

    const loaded = await loadHarnessConfig(root);

    expect(loaded.path).toMatch(/harness\.config\.mjs$/);
    expect(loaded.config.system).toBe("from config");
    expect(loaded.config.maxToolsPerUserTurn).toBe(3);
  });

  it("loads a named config export", async () => {
    await writeFile(join(root, "harness.config.mjs"), 'export const config = { system: "named" };');

    const loaded = await loadHarnessConfig(root);

    expect(loaded.config.system).toBe("named");
  });

  it("fails clearly for TypeScript config files", async () => {
    await writeFile(join(root, "harness.config.ts"), "export default {};");

    await expect(loadHarnessConfig(root)).rejects.toThrow(/JavaScript config files only/);
  });
});
