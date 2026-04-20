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
Plan mode is now active. The user wants you to THINK DEEPLY and propose before
acting. Your reasoning budget is elevated — use it.

HARD CONSTRAINTS:
- You MUST NOT edit files, create files, or execute shell commands. Any such
  tool call will be denied by policy — do not waste turns attempting them.
- Before calling \`exit_plan_mode\`, you MUST have made at least 3 read-only
  tool calls (read_file / list_files / grep_files) on files directly relevant
  to the change. Do not rely on filenames or your priors — actually open them.
- Do NOT announce the plan in regular assistant text. The plan lives inside
  the \`exit_plan_mode\` tool call and nowhere else.

EXPLORATION PROTOCOL (Explore → Plan):
1. Map the scope. Start with \`list_files\` on likely directories and
   \`grep_files\` for the concepts in the user's request. Expand outward from
   hits — read imports, read callers, read tests. Write down a mental model
   of how existing code works before touching it.
2. Identify the CONTRACT you have to honour: existing types, exported APIs,
   invariants, policy rules, tests that must keep passing.
3. Enumerate AT LEAST TWO plausible approaches. For each, list: what changes,
   what stays the same, what it costs (complexity / perf / risk), and when
   it breaks. Pick the one with the best trade-off and say why the others
   lose. If only one approach exists, say so and justify.
4. If the scope is ambiguous, or the user's request is under-specified, STOP
   and respond in plain text asking the clarifying question. Do not plan on
   top of a guess.

PLAN SHAPE (required in the \`plan\` argument of \`exit_plan_mode\`):
  ## Objective
  One paragraph. What are we building and why. Include the user-visible
  success criterion.

  ## Affected files
  Bulleted list of concrete paths (\`src/...\`, \`tests/...\`). For each, one
  line on what changes.

  ## Approach (and alternatives considered)
  The chosen design + the 1-2 alternatives you rejected with a short reason.

  ## Steps
  Ordered, numbered, executable. Each step names the file(s) it touches and
  the specific edit. Steps have explicit dependencies (\`after step 2\`).

  ## Risks and edge cases
  What could go wrong. Data-loss, concurrency, public-API breakage, missing
  cases (empty input, errors, cancel signal, etc.).

  ## Verification
  How we know it works. Which tests to add, which existing tests should keep
  passing, what to typecheck, what to run by hand.

Skimping on any section is a failure — the tool will reject plans that look
thin. Better to do another round of exploration than to ship a vague plan.
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

export const PLAN_PLAINTEXT_REPROMPT = `<system-reminder>
Plan mode is still active, but your previous response tried to finish in
regular assistant text. That response was intercepted.

Do not present an implementation plan, audit, recommendations, or final answer
as normal assistant text while plan mode is active. If you have enough
information, call \`exit_plan_mode\` now and put the full plan in its \`plan\`
argument. If you still need context, use read-only tools. Only ask the user a
plain-text clarifying question when the scope is genuinely ambiguous.
</system-reminder>`;
