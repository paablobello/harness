import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { HookDispatcher } from "../hooks/dispatcher.js";
import type { McpServerSpec } from "../mcp/client.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { Sensor } from "../sensors/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PolicyRule } from "../types.js";

const CONFIG_FILES = [
  "harness.config.mjs",
  "harness.config.js",
  "harness.config.cjs",
  "harness.config.ts",
];

export type HarnessConfig = {
  /** Optional complete registry. If omitted, the CLI uses built-in tools. */
  tools?: ToolRegistry;
  /** Advanced escape hatch. If omitted, the CLI builds a PolicyEngine from policyRules. */
  policy?: PolicyEngine;
  /** Declarative rules used with the CLI's terminal ask function. Defaults to defaultPolicy. */
  policyRules?: PolicyRule[];
  hooks?: HookDispatcher;
  sensors?: Sensor[];
  mcpServers?: McpServerSpec[];
  /** Optional system prompt override loaded before AGENTS.md is appended. */
  system?: string;
  maxToolsPerUserTurn?: number;
  maxSubagentDepth?: number;
};

export type LoadedHarnessConfig = {
  path: string | null;
  config: HarnessConfig;
};

export async function loadHarnessConfig(cwd: string): Promise<LoadedHarnessConfig> {
  const path = await findHarnessConfig(cwd);
  if (!path) return { path: null, config: {} };
  if (path.endsWith(".ts")) {
    throw new Error(
      `Cannot load ${path}: the CLI loads JavaScript config files only. ` +
        "Rename it to harness.config.mjs, or compile your TypeScript config before running the CLI.",
    );
  }

  const imported = (await import(pathToFileURL(path).href)) as {
    default?: unknown;
    config?: unknown;
  };
  const raw = imported.default ?? imported.config ?? {};
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid harness config at ${path}: expected an object export.`);
  }
  return { path, config: raw as HarnessConfig };
}

export async function findHarnessConfig(cwd: string): Promise<string | null> {
  for (const file of CONFIG_FILES) {
    const candidate = join(cwd, file);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}
