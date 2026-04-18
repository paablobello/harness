import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exitPlanModeTool } from "../../src/tools/exit-plan-mode.js";
import type { AskPlan, PermissionMode, ToolContext } from "../../src/types.js";

let root: string;

function makeCtx(overrides: {
  askPlan?: AskPlan;
  setPermissionMode?: (mode: PermissionMode, source?: "user" | "tool" | "system") => void;
  previousPermissionMode?: PermissionMode;
}): ToolContext {
  return {
    workspaceRoot: root,
    cwd: root,
    signal: new AbortController().signal,
    sessionId: "s",
    runId: "r",
    ...(overrides.askPlan ? { askPlan: overrides.askPlan } : {}),
    ...(overrides.setPermissionMode ? { setPermissionMode: overrides.setPermissionMode } : {}),
    ...(overrides.previousPermissionMode !== undefined
      ? { previousPermissionMode: overrides.previousPermissionMode }
      : {}),
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-exit-plan-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("exit_plan_mode", () => {
  it("fails clearly when no askPlan is wired (non-interactive runtime)", async () => {
    const res = await exitPlanModeTool.run(
      { plan: "# Plan\n\nDo a thing that is long enough to pass validation." },
      makeCtx({}),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toContain("unavailable");
  });

  it("writes plan.md under .harness/plans with a slug derived from the first heading", async () => {
    let calledWith: PermissionMode | undefined;
    const plan =
      "# Refactor Auth Middleware\n\n" +
      "1. Extract helpers\n2. Update tests\n3. Verify type errors cleared";

    const res = await exitPlanModeTool.run(
      { plan },
      makeCtx({
        askPlan: async () => ({ approved: true }),
        setPermissionMode: (mode) => {
          calledWith = mode;
        },
        previousPermissionMode: "acceptEdits",
      }),
    );

    expect(res.ok).toBe(true);
    expect(calledWith).toBe("acceptEdits");

    const dir = join(root, ".harness", "plans");
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const file = files[0];
    expect(file).toBeDefined();
    const name = file as string;
    expect(name).toMatch(/^\d{8}-\d{6}-refactor-auth-middleware\.md$/);

    const body = await readFile(join(dir, name), "utf8");
    expect(body).toContain("Refactor Auth Middleware");
    expect(body.endsWith("\n")).toBe(true);

    const st = await stat(join(dir, name));
    expect(st.isFile()).toBe(true);

    expect(res.meta).toMatchObject({ approved: true, mode: "acceptEdits" });
  });

  it("falls back to 'default' when previousPermissionMode is missing", async () => {
    let calledWith: PermissionMode | undefined;
    await exitPlanModeTool.run(
      { plan: "# A\n\nSome plan body that exceeds the min length requirement." },
      makeCtx({
        askPlan: async () => ({ approved: true }),
        setPermissionMode: (mode) => {
          calledWith = mode;
        },
      }),
    );
    expect(calledWith).toBe("default");
  });

  it("returns ok:false with feedback on rejection and does NOT write any file", async () => {
    const askPlan: AskPlan = async () => ({
      approved: false,
      feedback: "Add migration step before touching middleware.",
    });
    let setModeCalled = false;

    const res = await exitPlanModeTool.run(
      { plan: "# Initial Plan\n\nStep 1\nStep 2\nStep 3 that makes length valid." },
      makeCtx({
        askPlan,
        setPermissionMode: () => {
          setModeCalled = true;
        },
        previousPermissionMode: "default",
      }),
    );

    expect(res.ok).toBe(false);
    expect(res.output).toContain("Add migration step");
    expect(res.meta).toMatchObject({ approved: false });
    expect(setModeCalled).toBe(false);

    const dir = join(root, ".harness", "plans");
    await expect(readdir(dir)).rejects.toThrow();
  });

  it("persists the user-edited plan when askPlan returns editedPlan on approval", async () => {
    const original = "# Original\n\nStep 1\nStep 2\nStep 3 padding text for min length";
    const edited = "# Edited By User\n\nStep 1\nStep 2\nStep 3 — with extra migration note";

    const res = await exitPlanModeTool.run(
      { plan: original },
      makeCtx({
        askPlan: async () => ({ approved: true, editedPlan: edited }),
        setPermissionMode: () => {
          /* no-op */
        },
        previousPermissionMode: "default",
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("user edited the plan");
    expect(res.meta).toMatchObject({ edited: true });

    const files = await readdir(join(root, ".harness", "plans"));
    expect(files).toHaveLength(1);
    const name = files[0] as string;
    expect(name).toMatch(/edited-by-user/);
    const body = await readFile(join(root, ".harness", "plans", name), "utf8");
    expect(body).toContain("Edited By User");
    expect(body).not.toContain("# Original");
  });

  it("falls back to the original plan when editedPlan is empty/whitespace", async () => {
    const original = "# Keep Me\n\nStep 1\nStep 2 that makes the min length pass easily";
    const res = await exitPlanModeTool.run(
      { plan: original },
      makeCtx({
        askPlan: async () => ({ approved: true, editedPlan: "   \n\n  " }),
        setPermissionMode: () => {
          /* no-op */
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.meta).toMatchObject({ edited: false });
    const files = await readdir(join(root, ".harness", "plans"));
    const body = await readFile(join(root, ".harness", "plans", files[0] as string), "utf8");
    expect(body).toContain("# Keep Me");
  });

  it("sanitizes slugs built from plain first-line text (no heading)", async () => {
    await exitPlanModeTool.run(
      { plan: "Plan: do X then Y — with caveats. Ensure minimum length passes." },
      makeCtx({
        askPlan: async () => ({ approved: true }),
        setPermissionMode: () => {
          /* no-op */
        },
      }),
    );

    const files = await readdir(join(root, ".harness", "plans"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-plan-do-x-then-y/);
  });
});
