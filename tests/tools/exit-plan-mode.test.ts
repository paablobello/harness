import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exitPlanModeTool } from "../../src/tools/exit-plan-mode.js";
import type { AskPlan, PermissionMode, ToolContext } from "../../src/types.js";

let root: string;

/** A plan that clears the `exit_plan_mode` soft-validation checks. Tests that
 *  care about the happy path use this (or a derivative) so we're not coupling
 *  every single test to the exact threshold numbers. */
function validPlan(title = "Refactor Auth Middleware"): string {
  return (
    `# ${title}\n\n` +
    "## Objective\n" +
    "Extract auth logic from the Express middleware chain so we can reuse it " +
    "from tRPC handlers without duplicating session validation.\n\n" +
    "## Affected files\n" +
    "- src/auth/middleware.ts — split into checker + adapter\n" +
    "- src/auth/session.ts — expose the checker directly\n" +
    "- tests/auth/middleware.test.ts — keep coverage on the express path\n\n" +
    "## Steps\n" +
    "1. Introduce `verifySession()` in src/auth/session.ts\n" +
    "2. Rewrite src/auth/middleware.ts to wrap the new helper\n" +
    "3. Update tests/auth/middleware.test.ts and add a tRPC-facing case\n\n" +
    "## Risks and edge cases\n" +
    "Cookie parsing order matters; token refresh during the same request " +
    "could race. Plan: gate on a request-scoped cache.\n\n" +
    "## Verification\n" +
    "Run `pnpm test auth/` and `pnpm typecheck`. Manual smoke via /login then /me."
  );
}

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
    const res = await exitPlanModeTool.run({ plan: validPlan() }, makeCtx({}));
    expect(res.ok).toBe(false);
    expect(res.output).toContain("unavailable");
  });

  it("writes plan.md under .harness/plans with a slug derived from the first heading", async () => {
    let calledWith: PermissionMode | undefined;
    const res = await exitPlanModeTool.run(
      { plan: validPlan() },
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
      { plan: validPlan("A") },
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
      { plan: validPlan("Initial Plan") },
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
    const original = validPlan("Original");
    const edited = validPlan("Edited By User").replace(
      "## Verification",
      "## Verification (revised by user)",
    );

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
    expect(body).toContain("revised by user");
    expect(body).not.toContain("# Original");
  });

  it("falls back to the original plan when editedPlan is empty/whitespace", async () => {
    const original = validPlan("Keep Me");
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
    // No heading — plan body is plain-prose but still hits the quality bar.
    const plan =
      "Plan: do X then Y — with caveats. " +
      "Objective is to migrate src/a.ts and src/b.ts to the new API while " +
      "keeping tests/a.test.ts green.\n\n" +
      "Steps:\n1. Patch src/a.ts\n2. Patch src/b.ts\n3. Run tests\n\n" +
      "Risks: the adapter cache may invalidate. " +
      "Verification: pnpm test and pnpm typecheck must pass.";
    await exitPlanModeTool.run(
      { plan },
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

  it("auto-rejects thin plans before reaching the user (soft validation)", async () => {
    let askCalled = false;
    const thinPlan = "# Plan\n\n1. Fix it\n2. Ship";
    const res = await exitPlanModeTool.run(
      { plan: thinPlan },
      makeCtx({
        askPlan: async () => {
          askCalled = true;
          return { approved: true };
        },
        setPermissionMode: () => {
          /* no-op */
        },
      }),
    );
    expect(res.ok).toBe(false);
    expect(askCalled).toBe(false);
    expect(res.output).toMatch(/quality checks/i);
    expect(res.meta).toMatchObject({ autoRejected: true });
    // No file written.
    await expect(readdir(join(root, ".harness", "plans"))).rejects.toThrow();
  });
});
