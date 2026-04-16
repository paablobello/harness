import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { editFileTool } from "../../src/tools/edit-file.js";
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
  root = await mkdtemp(join(tmpdir(), "harness-edit-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("edit_file", () => {
  it("replaces a unique substring", async () => {
    const p = join(root, "a.txt");
    await writeFile(p, "hello world\ngoodbye world");
    const r = await editFileTool.run({ path: "a.txt", old_str: "hello", new_str: "hola" }, ctx());
    expect(r.ok).toBe(true);
    expect(await readFile(p, "utf8")).toBe("hola world\ngoodbye world");
  });

  it("fails when old_str is missing", async () => {
    await writeFile(join(root, "a.txt"), "hi");
    const r = await editFileTool.run({ path: "a.txt", old_str: "nope", new_str: "x" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/not found/);
  });

  it("fails when old_str appears multiple times", async () => {
    await writeFile(join(root, "a.txt"), "foo foo");
    const r = await editFileTool.run({ path: "a.txt", old_str: "foo", new_str: "bar" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/more than once/);
  });

  it("creates a new file when old_str is empty", async () => {
    const r = await editFileTool.run({ path: "new.txt", old_str: "", new_str: "hello" }, ctx());
    expect(r.ok).toBe(true);
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("hello");
  });

  it("refuses to overwrite existing file when old_str is empty", async () => {
    await writeFile(join(root, "a.txt"), "x");
    const r = await editFileTool.run({ path: "a.txt", old_str: "", new_str: "y" }, ctx());
    expect(r.ok).toBe(false);
  });
});
