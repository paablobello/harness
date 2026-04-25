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

    const shortfall = assessPlanQuality(args.plan);
    if (shortfall) {
      // Reject BEFORE bothering the user. Plan mode stays on, the model reads
      // this as a tool_result and iterates. This is the "soft validation" that
      // prevents drive-by plans in small repos.
      return {
        ok: false,
        output:
          `exit_plan_mode rejected the plan automatically (not shown to the user).\n\n${shortfall}\n\n` +
          "Do more exploration (read_file / list_files / grep_files on the files you will " +
          "touch), then call exit_plan_mode again with the missing sections filled in.",
        meta: { approved: false, autoRejected: true },
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

async function writePlanFile(
  cwd: string,
  plan: string,
): Promise<{ path: string; filename: string }> {
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

/**
 * Soft validation: returns a human-readable reason if the plan is too thin,
 * or `null` if it looks acceptable. Deliberately lenient — we only want to
 * catch obvious drive-bys (one-paragraph plans, no file paths, zero steps).
 *
 * Thresholds picked empirically from looking at Claude Code plan outputs:
 * real plans for non-trivial changes routinely hit 200+ words, 3+ file refs,
 * and 4+ numbered steps. The prompt describes a full 5-section shape, so
 * anything obviously missing more than 2 of those dimensions gets kicked.
 */
function assessPlanQuality(plan: string): string | null {
  const issues: string[] = [];
  const words = plan.trim().split(/\s+/).filter(Boolean).length;
  if (words < 120) issues.push(`plan is ${words} words — needs ~120+ for real depth`);

  const pathRe =
    /\b(?:[\w.@-]+\/)+[\w.@-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|ya?ml|toml|py|rs|go|sh|css|html?)\b/g;
  const paths = new Set<string>();
  for (const m of plan.matchAll(pathRe)) paths.add(m[0]);
  if (paths.size < 2)
    issues.push(
      `only ${paths.size} file path${paths.size === 1 ? "" : "s"} referenced — list the concrete files you will touch`,
    );

  const numberedSteps = (plan.match(/^\s*\d+\.\s+\S/gm) ?? []).length;
  const bulletSteps = (plan.match(/^\s*[-*]\s+\S/gm) ?? []).length;
  const steps = numberedSteps > 0 ? numberedSteps : bulletSteps;
  if (steps < 3)
    issues.push(`only ${steps} step${steps === 1 ? "" : "s"} — break the work down further`);

  const lower = plan.toLowerCase();
  const missingSections: string[] = [];
  if (!/objective|goal/.test(lower)) missingSections.push("Objective");
  if (!/verify|verification|test|typecheck/.test(lower)) missingSections.push("Verification");
  if (!/risk|edge case|failure|concurrency|breaking/.test(lower))
    missingSections.push("Risks / edge cases");
  if (missingSections.length > 0)
    issues.push(`no sign of section(s): ${missingSections.join(", ")}`);

  if (issues.length < 2) return null; // Be lenient — require at least 2 smells.
  return `Plan failed quality checks:\n- ${issues.join("\n- ")}`;
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
