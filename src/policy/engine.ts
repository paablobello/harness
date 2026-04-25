import { parseCommand } from "../tools/command-parser.js";
import type { PermissionMode, PolicyDecision, PolicyRule, ToolDefinition } from "../types.js";
import { evaluateRunCommand } from "./run-command-policy.js";

export type AskPrompt = (req: {
  tool: string;
  input: unknown;
  reason?: string;
}) => Promise<boolean>;

export type PolicyEngineOptions = {
  rules: PolicyRule[];
  mode?: PermissionMode;
  ask?: AskPrompt;
};

export class PolicyEngine {
  private readonly rules: PolicyRule[];
  private mode: PermissionMode;
  private readonly ask: AskPrompt;
  private readonly stickyAllow = new Set<string>();

  constructor(opts: PolicyEngineOptions) {
    // Copy so runtime mutations (addRule from "always allow") don't leak into
    // the caller's array — defaultPolicy is a module-level const shared across
    // engine instances.
    this.rules = [...opts.rules];
    this.mode = opts.mode ?? "default";
    this.ask = opts.ask ?? (async () => false);
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  /**
   * Add a rule at runtime, ahead of the existing rules so it takes precedence.
   * Used by the TUI's "always allow for session" affordance: when the user
   * approves a tool with `a`, the dialog calls this to register a session-wide
   * allow rule for that tool name.
   */
  addRule(rule: PolicyRule, position: "first" | "last" = "first"): void {
    if (position === "first") this.rules.unshift(rule);
    else this.rules.push(rule);
  }

  /**
   * Decide whether a tool invocation should proceed.
   *
   * Permission modes short-circuit matching:
   *  - explicit deny     → always deny (catastrophic run_command included)
   *  - bypassPermissions → allow everything else
   *  - plan              → deny all write/execute ("planned only")
   *  - acceptEdits       → allow write, ask still applies to execute
   *  - default           → rule matching + run_command segment eval
   */
  async decide(req: { tool: ToolDefinition; input: unknown }): Promise<PolicyDecision> {
    const { tool, input } = req;

    // Run the per-segment evaluator first so catastrophic patterns
    // (`rm -rf /`, fork bombs, `curl … | sh`) deny even when a runtime rule
    // would have allowed run_command wholesale.
    const segDecision = this.runCommandSegmentDecision(tool, input);
    if (segDecision?.decision === "deny") return segDecision;

    const match = this.firstMatch(tool.name, input);
    if (match?.decision === "deny") {
      return { decision: "deny", reason: match.reason ?? "denied by policy" };
    }

    if (this.mode === "bypassPermissions") return { decision: "allow" };
    if (this.mode === "plan" && tool.risk !== "read") {
      return { decision: "deny", reason: "plan mode: no writes or command execution" };
    }
    if (this.mode === "acceptEdits" && tool.risk === "write") {
      return { decision: "allow" };
    }

    // Compose the base decision. Order of precedence:
    //   1. Explicit allow rule wins over a segment "ask" — this lets the
    //      "always allow for session" affordance and user-defined rules
    //      bypass safe-prefix limits.
    //   2. Segment "allow" only fires when no rule said anything stronger.
    //   3. Otherwise fall back to the rule decision, then segment, then "ask".
    let baseDecision: "allow" | "ask" = "ask";
    let baseReason: string | undefined;
    if (match?.decision === "allow") {
      baseDecision = "allow";
    } else if (segDecision?.decision === "allow") {
      baseDecision = "allow";
    } else if (segDecision?.decision === "ask") {
      baseDecision = "ask";
      baseReason = segDecision.reason;
    } else if (match?.decision === "ask") {
      baseDecision = "ask";
      baseReason = match.reason;
    }

    if (baseDecision === "allow") return { decision: "allow" };

    const stickyKey = this.stickyKey(tool.name, input);
    if (this.stickyAllow.has(stickyKey)) return { decision: "allow" };

    const approved = await this.ask({
      tool: tool.name,
      input,
      ...(baseReason ? { reason: baseReason } : {}),
    });
    if (approved) {
      this.stickyAllow.add(stickyKey);
      return { decision: "allow" };
    }
    return { decision: "deny", reason: "user declined" };
  }

  private runCommandSegmentDecision(tool: ToolDefinition, input: unknown): PolicyDecision | null {
    if (tool.name !== "run_command") return null;
    if (!input || typeof input !== "object") return null;
    const cmd = (input as { command?: unknown }).command;
    if (typeof cmd !== "string" || cmd.length === 0) return null;
    return evaluateRunCommand(parseCommand(cmd));
  }

  private firstMatch(toolName: string, input: unknown): PolicyRule | undefined {
    for (const rule of this.rules) {
      const nameMatch =
        typeof rule.match.tool === "string"
          ? rule.match.tool === toolName
          : rule.match.tool.test(toolName);
      if (!nameMatch) continue;
      if (rule.match.pattern) {
        const subject = this.matchSubject(toolName, input);
        if (!rule.match.pattern.test(subject)) continue;
      }
      return rule;
    }
    return undefined;
  }

  private matchSubject(toolName: string, input: unknown): string {
    if (toolName === "run_command" && input && typeof input === "object") {
      const cmd = (input as { command?: unknown }).command;
      if (typeof cmd === "string") return cmd;
    }
    try {
      return JSON.stringify(input);
    } catch {
      return String(input);
    }
  }

  private stickyKey(toolName: string, input: unknown): string {
    return `${toolName}::${this.matchSubject(toolName, input)}`;
  }
}
