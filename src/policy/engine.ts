import type { PermissionMode, PolicyDecision, PolicyRule, ToolDefinition } from "../types.js";

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
    this.rules = opts.rules;
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
   * Decide whether a tool invocation should proceed.
   *
   * Permission modes short-circuit matching:
   *  - bypassPermissions → always allow
   *  - plan              → deny all write/execute ("planned only")
   *  - acceptEdits       → allow write, ask still applies to execute
   *  - default           → rule matching
   */
  async decide(req: {
    tool: ToolDefinition;
    input: unknown;
  }): Promise<PolicyDecision> {
    const { tool, input } = req;

    if (this.mode === "bypassPermissions") return { decision: "allow" };
    if (this.mode === "plan" && tool.risk !== "read") {
      return { decision: "deny", reason: "plan mode: no writes or command execution" };
    }
    if (this.mode === "acceptEdits" && tool.risk === "write") {
      return { decision: "allow" };
    }

    const match = this.firstMatch(tool.name, input);
    const base: PolicyDecision =
      match?.decision === "allow"
        ? { decision: "allow" }
        : match?.decision === "deny"
          ? { decision: "deny", reason: match.reason ?? "denied by policy" }
          : match?.decision === "ask"
            ? { decision: "ask", ...(match.reason ? { reason: match.reason } : {}) }
            : { decision: "ask" };

    if (base.decision !== "ask") return base;

    const stickyKey = this.stickyKey(tool.name, input);
    if (this.stickyAllow.has(stickyKey)) return { decision: "allow" };

    const approved = await this.ask({
      tool: tool.name,
      input,
      ...(base.reason ? { reason: base.reason } : {}),
    });
    if (approved) {
      this.stickyAllow.add(stickyKey);
      return { decision: "allow" };
    }
    return { decision: "deny", reason: "user declined" };
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
