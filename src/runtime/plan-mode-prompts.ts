/**
 * System-reminders injected into the model's next turn when plan mode is
 * entered or exited. Plan mode is enforced at two layers:
 *
 *  1. Hard policy enforcement — `PolicyEngine` denies any tool whose
 *     `risk !== "read"` while `mode === "plan"`. This is *technical*: the
 *     model cannot write or exec even if it tries.
 *  2. Prompt contract — these reminders tell the model what the mode means,
 *     how it should behave, and how to surface the final plan for approval.
 *
 * Keeping the two layers aligned reduces wasted turns: the model understands
 * *why* writes fail and produces a plan via `exit_plan_mode` instead of
 * flailing.
 *
 * The structure of the entry reminder is distilled from Claude Code's
 * reverse-engineered plan-mode `tool_result` payload (articles.gg) and
 * AgentPatterns' four-phase Explore → Plan → Implement → Verify workflow.
 */

export const PLAN_ENTRY_REMINDER = `<system-reminder>
Plan mode is now active. The user wants you to think and propose before acting.

You MUST NOT edit files, create files, or execute shell commands. Any such
tool call will be denied by policy — do not attempt them. Your job in this
mode is to:

1. Explore the codebase with read-only tools (read_file, list_files, grep_files)
   to understand existing patterns and scope.
2. Consider multiple approaches and their trade-offs — do not commit to the
   first viable one.
3. If scope is ambiguous, surface the ambiguity in your response so the user
   can clarify before you plan further.
4. When you have a concrete implementation strategy, call the \`exit_plan_mode\`
   tool with the full plan as its \`plan\` argument. The user will review and
   approve before any implementation happens.

Do NOT announce the plan in regular assistant text — put it inside
\`exit_plan_mode\` so the user gets a proper approval prompt. Do NOT call
\`exit_plan_mode\` until you have actually explored the relevant code.

A good plan identifies: affected files with paths, concrete steps in order,
dependencies between steps, risks/edge cases, and how the change will be
verified (tests, typecheck, manual checks).
</system-reminder>`;

export const PLAN_EXIT_REMINDER = `<system-reminder>
Plan mode is now off. The user has approved the plan and you may now edit
files and execute commands as needed to implement it. Follow the plan you
proposed; deviate only when you discover the plan was wrong, and flag the
deviation in your response.
</system-reminder>`;

export const PLAN_REJECTED_REMINDER = `<system-reminder>
The user rejected the plan. Plan mode is still active. Read their feedback
in the last tool result, revise your plan accordingly, and call
\`exit_plan_mode\` again with the updated plan when ready.
</system-reminder>`;
