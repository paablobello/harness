import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveWithinWorkspace } from "../../src/runtime/workspace.js";

describe("resolveWithinWorkspace", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "harness-ws-"));
    outside = await mkdtemp(join(tmpdir(), "harness-out-"));
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "a.txt"), "hi");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("resolves relative paths inside root", async () => {
    const abs = await resolveWithinWorkspace(root, "sub/a.txt");
    expect(abs.endsWith("sub/a.txt")).toBe(true);
  });

  it("accepts non-existent paths under an existing parent", async () => {
    const abs = await resolveWithinWorkspace(root, "sub/new.txt");
    expect(abs.endsWith("sub/new.txt")).toBe(true);
  });

  it("rejects absolute paths outside root", async () => {
    await expect(resolveWithinWorkspace(root, join(outside, "x"))).rejects.toThrow(
      /escapes workspace/,
    );
  });

  it("rejects ../ traversal", async () => {
    await expect(resolveWithinWorkspace(root, "../outside")).rejects.toThrow(
      /escapes workspace/,
    );
  });

  it("defeats symlink escapes", async () => {
    await symlink(outside, join(root, "link-out"));
    await expect(resolveWithinWorkspace(root, "link-out/file")).rejects.toThrow(
      /escapes workspace/,
    );
  });
});
