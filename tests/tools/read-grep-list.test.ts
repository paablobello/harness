import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { grepFilesTool } from "../../src/tools/grep-files.js";
import { listFilesTool } from "../../src/tools/list-files.js";
import { readFileTool } from "../../src/tools/read-file.js";
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
  root = await mkdtemp(join(tmpdir(), "harness-ro-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), "export const foo = 1;\n");
  await writeFile(join(root, "src", "b.ts"), "export const bar = 2;\n");
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "foo");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("read_file", () => {
  it("reads a file and returns contents", async () => {
    const r = await readFileTool.run({ path: "src/a.ts" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("export const foo");
  });

  it("truncates when max_bytes is hit", async () => {
    await writeFile(join(root, "big.txt"), "a".repeat(5000));
    const r = await readFileTool.run({ path: "big.txt", max_bytes: 100 }, ctx());
    expect(r.output).toMatch(/truncated/);
    expect(r.meta?.["truncated"]).toBe(true);
  });

  it("returns a friendly error on missing file", async () => {
    const r = await readFileTool.run({ path: "missing.ts" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toBe("File not found: missing.ts");
  });

  it("returns a friendly error when path is a directory", async () => {
    const r = await readFileTool.run({ path: "src" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/is a directory/);
  });
});

describe("list_files", () => {
  it("lists files and skips node_modules", async () => {
    const r = await listFilesTool.run({}, ctx());
    expect(r.output).toContain("src/a.ts");
    expect(r.output).toContain("src/b.ts");
    expect(r.output).not.toContain("node_modules");
  });

  it("filters by glob", async () => {
    const r = await listFilesTool.run({ glob: "src/*.ts" }, ctx());
    expect(r.output.split("\n").sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns a friendly error on missing path", async () => {
    const r = await listFilesTool.run({ path: "no/such/dir" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toBe("Path not found: no/such/dir");
  });
});

describe("grep_files", () => {
  it("finds matching lines with path:line:text format", async () => {
    const r = await grepFilesTool.run({ pattern: "foo" }, ctx());
    expect(r.output).toMatch(/src\/a\.ts:1:.*foo/);
    expect(r.output).not.toMatch(/node_modules/);
  });

  it("returns no matches message when nothing hits", async () => {
    const r = await grepFilesTool.run({ pattern: "zzznomatch" }, ctx());
    expect(r.output).toBe("(no matches)");
  });

  it("returns a friendly error on missing path", async () => {
    const r = await grepFilesTool.run({ pattern: "foo", path: "no/such/dir" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toBe("Path not found: no/such/dir");
  });
});
