import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadAgentsMd } from "../../src/config/agents-md.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-agents-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadAgentsMd", () => {
  it("returns null when no AGENTS.md exists", async () => {
    expect(await loadAgentsMd(root)).toBeNull();
  });

  it("loads AGENTS.md from the root", async () => {
    await writeFile(join(root, "AGENTS.md"), "root instructions");
    const content = await loadAgentsMd(root);
    expect(content).toContain("root instructions");
    expect(content).toContain("AGENTS.md");
  });

  it("stitches nested AGENTS.md from root → start", async () => {
    await writeFile(join(root, "AGENTS.md"), "ROOT");
    await mkdir(join(root, "pkg"), { recursive: true });
    await writeFile(join(root, "pkg", "AGENTS.md"), "PKG");
    const content = await loadAgentsMd(root, join(root, "pkg"));
    expect(content).not.toBeNull();
    const lines = content!.split("\n\n");
    const rootIdx = lines.findIndex((l) => l.includes("ROOT"));
    const pkgIdx = lines.findIndex((l) => l.includes("PKG"));
    expect(rootIdx).toBeGreaterThanOrEqual(0);
    expect(pkgIdx).toBeGreaterThan(rootIdx);
  });

  it("accepts CLAUDE.md as a fallback filename", async () => {
    await writeFile(join(root, "CLAUDE.md"), "legacy name");
    const content = await loadAgentsMd(root);
    expect(content).toContain("legacy name");
  });
});
