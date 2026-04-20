import type { PolicyRule } from "../types.js";

/**
 * Sensible defaults roughly aligned with Claude Code's permission model:
 *   - reads flow freely
 *   - edits ask
 *   - run_command is evaluated PER SEGMENT inside the engine via
 *     `evaluateRunCommand` (`src/policy/run-command-policy.ts`), so we don't
 *     list a flat regex here anymore — that approach was trivially bypassed
 *     by `&&`, `;`, `|` and friends.
 *   - MCP tools ask
 */
export const defaultPolicy: PolicyRule[] = [
  { match: { tool: "read_file" }, decision: "allow" },
  { match: { tool: "list_files" }, decision: "allow" },
  { match: { tool: "grep_files" }, decision: "allow" },
  // Plan-mode exit: the "approval" itself is the UI dialog spawned inside the
  // tool, so we allow the tool call unconditionally — denying here would make
  // the model unable to surface the plan at all.
  { match: { tool: "exit_plan_mode" }, decision: "allow" },

  { match: { tool: "edit_file" }, decision: "ask" },
  { match: { tool: "apply_patch" }, decision: "ask" },

  // Background job inspection is read-only output retrieval.
  { match: { tool: "job_output" }, decision: "allow" },

  // Note: no `run_command` rules here. The engine special-cases that tool
  // and runs `evaluateRunCommand` on the parsed segments.

  { match: { tool: "subagent" }, decision: "allow" },
  { match: { tool: /^mcp__/ }, decision: "ask" },
];
