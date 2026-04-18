import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { ToolDefinition } from "../types.js";

const input = z.object({
  plan: z
    .string()
    .min(20)
    .describe(
      "The full implementation plan in Markdown. Should include: affected files " +
        "with paths, concrete ordered steps, dependencies between steps, risks / " +
        "edge cases, and how the change will be verified.",
    ),
  allowed_tools: z
    .array(z.string())
    .optional()
    .describe(
      "Optional list of tool names that should be pre-approved when the plan is " +
        "accepted, so implementation does not repeatedly ask for permission. Not " +
        "yet wired to the policy engine — reserved for future use.",
    ),
});

type Input = z.infer<typeof input>;

/**
 * Present the accumulated plan to the user for approval. On approval:
 *   - writes `<cwd>/.harness/plans/<timestamp>-<slug>.md` with the plan text
 *   - transitions the policy engine from `plan` back to the previous permission
 *     mode so the model may now edit/execute
 *   - returns `ok: true` with the artifact path
 *
 * On rejection:
 *   - keeps the policy engine in plan mode
 *   - returns `ok: false` with the user's feedback so the model can iterate
 *
 * Marked `risk: "read"` on purpose: in plan mode the `PolicyEngine` denies any
 * tool whose risk is not `"read"`. This tool *does* write a file, but only
 * after the user explicitly approves the plan via the UI — it's the approval
 * itself, not a silent write, so treating it as a read-class tool lets the
 * model call it from inside plan mode without friction.
 */
export const exitPlanModeTool: ToolDefinition<Input> = {
  name: "exit_plan_mode",
  description:
    "Submit your implementation plan to the user for approval. Call this ONLY " +
    "from plan mode, after you have finished exploring the codebase and have a " +
    "concrete, ordered implementation strategy. The user will see the full plan " +
    "in a dialog and choose to approve (you may then edit files) or reject with " +
    "feedback (plan mode stays on, revise and try again).",
  inputSchema: input,
  risk: "read",
  source: "builtin",
  async run(args, ctx) {
    if (!ctx.askPlan) {
      return {
        ok: false,
        output:
          "exit_plan_mode unavailable: this runtime does not expose a plan-approval UI. " +
          "Plans can only be submitted when running in the interactive chat.",
      };
    }

    const decision = await ctx.askPlan({
      plan: args.plan,
      ...(args.allowed_tools ? { allowedTools: args.allowed_tools } : {}),
    });

    if (!decision.approved) {
      // Session layer does not inject a reminder here — we surface the user's
      // feedback as the tool result so the model reads it on its next turn.
      return {
        ok: false,
        output: `Plan rejected by user. Feedback:\n\n${decision.feedback || "(no feedback given)"}\n\nPlan mode is still active. Revise the plan and call exit_plan_mode again.`,
        meta: { approved: false },
      };
    }

    const finalPlan = decision.editedPlan?.trim() ? decision.editedPlan : args.plan;
    const edited = finalPlan !== args.plan;
    const { path, filename } = await writePlanFile(ctx.cwd, finalPlan);

    // Switch back to the mode we were in before plan mode (default / acceptEdits).
    const nextMode = ctx.previousPermissionMode ?? "default";
    ctx.setPermissionMode?.(nextMode, "tool");

    const editedNote = edited
      ? " The user edited the plan before approving — treat the saved file as the source of truth."
      : "";
    return {
      ok: true,
      output: `Plan approved. Wrote ${filename}.${editedNote} Permission mode is now "${nextMode}"; you may edit files and execute commands to implement the plan.`,
      meta: { approved: true, planPath: path, mode: nextMode, edited },
    };
  },
};

async function writePlanFile(cwd: string, plan: string): Promise<{ path: string; filename: string }> {
  const dir = join(cwd, ".harness", "plans");
  await mkdir(dir, { recursive: true });
  const stamp = timestampSlug();
  const slug = extractSlug(plan);
  const filename = `${stamp}-${slug}.md`;
  const path = join(dir, filename);
  await writeFile(path, plan.endsWith("\n") ? plan : `${plan}\n`, "utf8");
  return { path, filename };
}

function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number, w = 2): string => n.toString().padStart(w, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function extractSlug(plan: string): string {
  const firstHeading = plan.match(/^\s*#+\s+(.+)$/m)?.[1];
  const firstLine = plan.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "plan";
  const source = firstHeading ?? firstLine;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "plan";
}
