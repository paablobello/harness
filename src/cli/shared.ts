import type readline from "node:readline/promises";

import pc from "picocolors";

import { loadAgentsMd } from "../config/agents-md.js";
import {
  loadHarnessConfig,
  type HarnessConfig,
  type LoadedHarnessConfig,
  validateHarnessConfig,
} from "../config/harness-config.js";
import { McpHub } from "../mcp/client.js";
import { defaultPolicy } from "../policy/defaults.js";
import { PolicyEngine, type AskPrompt } from "../policy/engine.js";
import { createBuiltinSensors } from "../sensors/builtin.js";
import type { Sensor } from "../sensors/types.js";
import { createBuiltinRegistry } from "../tools/builtin.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AskPlan, ModelAdapter, PermissionMode } from "../types.js";

export type ProviderOpts = {
  model?: string;
  provider?: "anthropic" | "openai";
};

export async function buildAdapter(opts: ProviderOpts): Promise<ModelAdapter> {
  const resolved = resolveProviderOpts(opts);
  if (resolved.provider === "openai") {
    const { createOpenAIAdapter } = await import("../adapters/openai.js");
    return createOpenAIAdapter({ model: resolved.model });
  }
  if (resolved.provider === "anthropic") {
    const { createAnthropicAdapter } = await import("../adapters/anthropic.js");
    return createAnthropicAdapter({ model: resolved.model });
  }
  throw new Error(`Unknown provider: ${resolved.provider}`);
}

export function resolveProviderOpts(opts: ProviderOpts): Required<ProviderOpts> {
  const provider = opts.provider ?? defaultProvider();
  return {
    provider,
    model: opts.model ?? defaultModel(provider),
  };
}

function defaultProvider(): "anthropic" | "openai" {
  if (process.env["OPENAI_API_KEY"] && !process.env["ANTHROPIC_API_KEY"]) return "openai";
  return "anthropic";
}

function defaultModel(provider: "anthropic" | "openai"): string {
  if (provider === "openai") return "gpt-5.4";
  return "claude-sonnet-4-5";
}

export function buildRegistry(): ToolRegistry {
  return createBuiltinRegistry();
}

export function buildSensors(): Sensor[] {
  return createBuiltinSensors();
}

export function buildPolicy(
  mode: PermissionMode,
  ask: AskPrompt,
  config: HarnessConfig = {},
): PolicyEngine {
  return (
    config.policy ?? new PolicyEngine({ rules: config.policyRules ?? defaultPolicy, mode, ask })
  );
}

export async function composeSystemPrompt(system: string, cwd: string): Promise<string> {
  const projectGuide = await loadAgentsMd(cwd);
  if (!projectGuide) return system;
  return `${system}\n\n<project-guide>\n${projectGuide}\n</project-guide>`;
}

export async function loadCliConfig(cwd: string, enabled: boolean): Promise<LoadedHarnessConfig> {
  if (!enabled) return { path: null, config: {} };
  const loaded = await loadHarnessConfig(cwd);
  const errors = validateHarnessConfig(loaded.config);
  if (errors.length > 0) {
    throw new Error(
      `Invalid harness config${loaded.path ? ` at ${loaded.path}` : ""}: ${errors.join("; ")}`,
    );
  }
  return loaded;
}

export async function buildToolSurface(
  config: HarnessConfig,
  opts: { toolsEnabled: boolean; mcpEnabled: boolean },
): Promise<{ tools?: ToolRegistry; close(): Promise<void> }> {
  if (!opts.toolsEnabled) {
    return {
      async close() {
        return undefined;
      },
    };
  }

  const tools = config.tools ?? buildRegistry();
  const hub = new McpHub();
  try {
    if (opts.mcpEnabled) {
      for (const server of config.mcpServers ?? []) {
        await hub.connect(server);
      }
      hub.registerInto(tools);
    }
  } catch (err) {
    await hub.close();
    throw err;
  }

  return {
    tools,
    async close() {
      await hub.close();
    },
  };
}

/** Ask the user via stdin whether to allow a tool call. */
export function terminalAsk(rl: readline.Interface): AskPrompt {
  return async ({ tool, input, reason }) => {
    const summary = summarizeInput(tool, input);
    const reasonLine = reason ? pc.dim(` (${reason})`) : "";
    console.log(pc.magenta(`\n? ${tool}${reasonLine}`) + (summary ? pc.dim(`\n  ${summary}`) : ""));
    const answer = (await rl.question(pc.magenta("  allow? [y/N] "))).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  };
}

/** Ask the user via stdin whether to approve an `exit_plan_mode` proposal. */
export function terminalAskPlan(rl: readline.Interface): AskPlan {
  return async ({ plan, allowedTools }) => {
    console.log(pc.magenta("\n? exit_plan_mode"));
    console.log(pc.dim("  Review the proposed plan below."));
    console.log("");
    console.log(plan);
    if (allowedTools && allowedTools.length > 0) {
      console.log(pc.dim(`\n  requested allowed tools: ${allowedTools.join(", ")}`));
    }
    const answer = (await rl.question(pc.magenta("\n  approve plan? [y/N] ")))
      .trim()
      .toLowerCase();
    if (answer === "y" || answer === "yes") return { approved: true };

    const feedback = (await rl.question(pc.magenta("  feedback for revision (optional): "))).trim();
    return { approved: false, feedback: feedback || "Plan rejected." };
  };
}

export function permissionMode(raw: string | undefined): PermissionMode {
  switch (raw) {
    case "accept-edits":
      return "acceptEdits";
    case "bypass":
      return "bypassPermissions";
    case "plan":
      return "plan";
    case undefined:
    case "default":
      return "default";
    default:
      throw new Error(
        `Unknown permission mode: ${raw} (expected default|accept-edits|bypass|plan)`,
      );
  }
}

function summarizeInput(tool: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (tool === "run_command" && typeof o["command"] === "string") {
      return `$ ${o["command"]}`;
    }
    if (typeof o["path"] === "string") return `path: ${o["path"]}`;
  }
  try {
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return "";
  }
}
