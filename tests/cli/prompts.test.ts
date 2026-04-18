import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildChatSystemPrompt, buildTaskSystemPrompt } from "../../src/cli/prompts.js";

async function newCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "harness-prompts-"));
}

describe("cli/prompts", () => {
  it("chat prompt includes env info and core guidance", async () => {
    const cwd = await newCwd();
    const prompt = await buildChatSystemPrompt(cwd);
    expect(prompt).toMatch(/You are Harness/);
    expect(prompt).toMatch(/Tone and style/);
    expect(prompt).toMatch(/Tool usage policy/);
    expect(prompt).toMatch(/<env>/);
    expect(prompt).toContain(`working_directory: ${cwd}`);
    expect(prompt).toContain("is_git_repo: no");
  });

  it("chat prompt reports git info when .git is present", async () => {
    const cwd = await newCwd();
    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    const prompt = await buildChatSystemPrompt(cwd);
    expect(prompt).toContain("is_git_repo: yes");
  });

  it("task prompt is shorter and mentions autonomy", async () => {
    const cwd = await newCwd();
    const prompt = await buildTaskSystemPrompt(cwd);
    expect(prompt).toMatch(/autonomous task/);
    expect(prompt).toMatch(/<env>/);
  });
});
