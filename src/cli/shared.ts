import type readline from "node:readline/promises";

import pc from "picocolors";

import { createAnthropicAdapter } from "../adapters/anthropic.js";
import { createOpenAIAdapter } from "../adapters/openai.js";
import { defaultPolicy } from "../policy/defaults.js";
import { PolicyEngine, type AskPrompt } from "../policy/engine.js";
import { createBuiltinRegistry } from "../tools/builtin.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ModelAdapter, PermissionMode } from "../types.js";

export type ProviderOpts = {
  model: string;
  provider: "anthropic" | "openai";
};

export function buildAdapter(opts: ProviderOpts): ModelAdapter {
  if (opts.provider === "openai") return createOpenAIAdapter({ model: opts.model });
  if (opts.provider === "anthropic") return createAnthropicAdapter({ model: opts.model });
  throw new Error(`Unknown provider: ${opts.provider}`);
}

export function buildRegistry(): ToolRegistry {
  return createBuiltinRegistry();
}

export function buildPolicy(mode: PermissionMode, ask: AskPrompt): PolicyEngine {
  return new PolicyEngine({ rules: defaultPolicy, mode, ask });
}

/** Ask the user via stdin whether to allow a tool call. */
export function terminalAsk(rl: readline.Interface): AskPrompt {
  return async ({ tool, input, reason }) => {
    const summary = summarizeInput(tool, input);
    const reasonLine = reason ? pc.dim(` (${reason})`) : "";
    console.log(
      pc.magenta(`\n? ${tool}${reasonLine}`) + (summary ? pc.dim(`\n  ${summary}`) : ""),
    );
    const answer = (await rl.question(pc.magenta("  allow? [y/N] "))).trim().toLowerCase();
    return answer === "y" || answer === "yes";
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
