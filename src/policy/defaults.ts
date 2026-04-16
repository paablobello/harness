import type { PolicyRule } from "../types.js";

/**
 * Sensible defaults roughly aligned with Claude Code's permission model:
 *   - reads flow freely
 *   - edits ask
 *   - known-safe commands ask; destructive patterns deny; everything else asks
 *   - MCP tools ask
 */
export const defaultPolicy: PolicyRule[] = [
  { match: { tool: "read_file" }, decision: "allow" },
  { match: { tool: "list_files" }, decision: "allow" },
  { match: { tool: "grep_files" }, decision: "allow" },

  { match: { tool: "edit_file" }, decision: "ask" },
  { match: { tool: "apply_patch" }, decision: "ask" },

  {
    match: {
      tool: "run_command",
      pattern: /(^|[\s;&|])(rm\s+-rf|sudo\b|:\(\)\s*\{|curl\b[^|]*\|\s*(sh|bash))/,
    },
    decision: "deny",
    reason: "destructive or exfiltration pattern",
  },
  {
    match: {
      tool: "run_command",
      pattern: /^\s*(git\s+(status|diff|log|show)|ls\b|pwd\b|cat\b|node\b|npm\s+test|pnpm\s+(test|typecheck|lint)|vitest\b)/,
    },
    decision: "ask",
  },
  { match: { tool: "run_command" }, decision: "ask" },

  { match: { tool: "subagent" }, decision: "allow" },
  { match: { tool: /^mcp__/ }, decision: "ask" },
];
