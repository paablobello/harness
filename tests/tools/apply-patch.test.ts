import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyPatchTool } from "../../src/tools/apply-patch.js";
import type { ToolContext } from "../../src/types.js";

let root: string;
const ctx = (): ToolContext => ({
  workspaceRoot: root,
  cwd: root,
  signal: new AbortController().signal,
  sessionId: "s",
  runId: "r",
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-patch-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("apply_patch", () => {
  it("applies a simple hunk", async () => {
    const p = join(root, "a.txt");
    await writeFile(p, "one\ntwo\nthree\n");
    const diff = `@@ -1,3 +1,3 @@
 one
-two
+dos
 three
`;
    const r = await applyPatchTool.run({ path: "a.txt", unified_diff: diff }, ctx());
    expect(r.ok).toBe(true);
    expect(await readFile(p, "utf8")).toBe("one\ndos\nthree\n");
  });

  it("fails cleanly on context mismatch", async () => {
    await writeFile(join(root, "a.txt"), "one\ntwo\n");
    const diff = `@@ -1,2 +1,2 @@
 one
-WRONG
+X
`;
    const r = await applyPatchTool.run({ path: "a.txt", unified_diff: diff }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/context mismatch/);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\ntwo\n");
  });

  it("applies multiple hunks in order", async () => {
    const p = join(root, "a.txt");
    await writeFile(p, "1\n2\n3\n4\n5\n");
    const diff = `@@ -1,2 +1,2 @@
-1
+one
 2
@@ -4,2 +4,2 @@
-4
+four
 5
`;
    const r = await applyPatchTool.run({ path: "a.txt", unified_diff: diff }, ctx());
    expect(r.ok).toBe(true);
    expect(await readFile(p, "utf8")).toBe("one\n2\n3\nfour\n5\n");
  });
});
