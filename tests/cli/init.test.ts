import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initCommand } from "../../src/cli/init.js";

describe("init command", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "harness-init-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("scaffolds an import-free harness.config.mjs", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await initCommand().parseAsync(["node", "init", "--cwd", root]);
    } finally {
      spy.mockRestore();
    }

    const config = await readFile(join(root, "harness.config.mjs"), "utf8");
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    const ignore = await readFile(join(root, ".harness", "runs", ".gitignore"), "utf8");

    expect(config).toContain("export default");
    expect(config).not.toContain('from "harness-lab"');
    expect(config).toContain("mcpServers");
    expect(agents).toContain("Project guide");
    expect(ignore).toContain("Harness run logs");
  });
});
