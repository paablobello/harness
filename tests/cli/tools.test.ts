import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toolsCommand } from "../../src/cli/tools.js";

describe("tools command", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "harness-tools-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("loads harness.config.mjs while allowing MCP connection to be skipped", async () => {
    await writeFile(
      join(root, "harness.config.mjs"),
      `export default {
        mcpServers: [{ name: "fake", command: "definitely-not-run" }]
      };`,
      "utf8",
    );
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    try {
      await toolsCommand().parseAsync(["node", "tools", "--cwd", root, "--no-mcp"]);
    } finally {
      spy.mockRestore();
    }

    const output = logs.join("\n");
    expect(output).toContain("harness.config.mjs");
    expect(output).toContain("read_file");
    expect(output).toContain("7 tools registered");
  });

  it("fails clearly when config shape is invalid", async () => {
    await writeFile(join(root, "harness.config.mjs"), "export default { mcpServers: [{}] };");

    await expect(
      toolsCommand().parseAsync(["node", "tools", "--cwd", root, "--no-mcp"]),
    ).rejects.toThrow(/Invalid harness config/);
  });
});
