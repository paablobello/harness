import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { HookDispatcher } from "../hooks/dispatcher.js";
import type { McpServerSpec } from "../mcp/client.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { ContextManagementConfig } from "../runtime/session.js";
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
  /** Context-window compaction settings. Falls through to `runSession`. */
  contextManagement?: ContextManagementConfig;
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

export function validateHarnessConfig(config: HarnessConfig): string[] {
  const errors: string[] = [];
  const raw = config as Record<string, unknown>;

  if (raw["system"] !== undefined && typeof raw["system"] !== "string") {
    errors.push("system must be a string");
  }
  if (raw["maxToolsPerUserTurn"] !== undefined && !isPositiveInteger(raw["maxToolsPerUserTurn"])) {
    errors.push("maxToolsPerUserTurn must be a positive integer");
  }
  if (raw["maxSubagentDepth"] !== undefined && !isNonNegativeInteger(raw["maxSubagentDepth"])) {
    errors.push("maxSubagentDepth must be a non-negative integer");
  }
  if (raw["policy"] !== undefined && !hasMethods(raw["policy"], ["decide"])) {
    errors.push("policy must expose decide()");
  }
  if (
    raw["tools"] !== undefined &&
    !hasMethods(raw["tools"], ["get", "list", "register", "specs"])
  ) {
    errors.push("tools must be a ToolRegistry-like object");
  }
  if (raw["hooks"] !== undefined && !hasMethods(raw["hooks"], ["dispatch"])) {
    errors.push("hooks must expose dispatch()");
  }
  if (raw["policyRules"] !== undefined && !Array.isArray(raw["policyRules"])) {
    errors.push("policyRules must be an array");
  }
  if (raw["contextManagement"] !== undefined) {
    if (!isRecord(raw["contextManagement"])) {
      errors.push("contextManagement must be an object");
    } else {
      const cm = raw["contextManagement"];
      if (cm["autoCompact"] !== undefined && typeof cm["autoCompact"] !== "boolean") {
        errors.push("contextManagement.autoCompact must be boolean");
      }
      for (const key of ["warnThreshold", "compactThreshold"] as const) {
        if (cm[key] !== undefined && !isRatio(cm[key])) {
          errors.push(`contextManagement.${key} must be a number in (0, 1]`);
        }
      }
      for (const key of ["keepLastNTurns", "keepLastNToolOutputs"] as const) {
        if (cm[key] !== undefined && !isNonNegativeInteger(cm[key])) {
          errors.push(`contextManagement.${key} must be a non-negative integer`);
        }
      }
      if (cm["summarizerSystem"] !== undefined && typeof cm["summarizerSystem"] !== "string") {
        errors.push("contextManagement.summarizerSystem must be a string");
      }
      if (cm["snapshotDir"] !== undefined && typeof cm["snapshotDir"] !== "string") {
        errors.push("contextManagement.snapshotDir must be a string");
      }
      if (cm["summarizerAdapter"] !== undefined && !hasMethods(cm["summarizerAdapter"], ["runTurn"])) {
        errors.push("contextManagement.summarizerAdapter must expose runTurn()");
      }
      if (
        cm["warnThreshold"] !== undefined &&
        cm["compactThreshold"] !== undefined &&
        typeof cm["warnThreshold"] === "number" &&
        typeof cm["compactThreshold"] === "number" &&
        cm["warnThreshold"] >= cm["compactThreshold"]
      ) {
        errors.push("contextManagement.warnThreshold must be strictly less than compactThreshold");
      }
    }
  }
  if (raw["sensors"] !== undefined) {
    if (!Array.isArray(raw["sensors"])) {
      errors.push("sensors must be an array");
    } else {
      raw["sensors"].forEach((sensor, i) => {
        if (
          !isRecord(sensor) ||
          typeof sensor["name"] !== "string" ||
          typeof sensor["run"] !== "function"
        ) {
          errors.push(`sensors[${i}] must include name and run()`);
        }
      });
    }
  }
  if (raw["mcpServers"] !== undefined) {
    if (!Array.isArray(raw["mcpServers"])) {
      errors.push("mcpServers must be an array");
    } else {
      raw["mcpServers"].forEach((server, i) => {
        if (!isRecord(server)) {
          errors.push(`mcpServers[${i}] must be an object`);
          return;
        }
        if (typeof server["name"] !== "string" || server["name"].length === 0) {
          errors.push(`mcpServers[${i}].name must be a non-empty string`);
        }
        if (typeof server["command"] !== "string" || server["command"].length === 0) {
          errors.push(`mcpServers[${i}].command must be a non-empty string`);
        }
        if (
          server["args"] !== undefined &&
          (!Array.isArray(server["args"]) || server["args"].some((arg) => typeof arg !== "string"))
        ) {
          errors.push(`mcpServers[${i}].args must be an array of strings`);
        }
        if (server["cwd"] !== undefined && typeof server["cwd"] !== "string") {
          errors.push(`mcpServers[${i}].cwd must be a string`);
        }
        if (server["env"] !== undefined && !isStringRecord(server["env"])) {
          errors.push(`mcpServers[${i}].env must be an object of string values`);
        }
      });
    }
  }

  return errors;
}

export function summarizeHarnessConfig(config: HarnessConfig): string {
  const parts: string[] = [];
  if (config.system) parts.push("system");
  if (config.tools) parts.push("tools");
  if (config.policy) parts.push("policy");
  if (config.policyRules) parts.push(`${config.policyRules.length} policy rule(s)`);
  if (config.hooks) parts.push("hooks");
  if (config.sensors) parts.push(`${config.sensors.length} sensor(s)`);
  if (config.mcpServers) parts.push(`${config.mcpServers.length} MCP server(s)`);
  if (config.maxToolsPerUserTurn !== undefined)
    parts.push(`maxTools=${config.maxToolsPerUserTurn}`);
  if (config.maxSubagentDepth !== undefined) parts.push(`maxSubagents=${config.maxSubagentDepth}`);
  if (config.contextManagement) parts.push("contextManagement");
  return parts.length > 0 ? parts.join(", ") : "no overrides";
}

function isRatio(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
}

function hasMethods(value: unknown, methods: string[]): boolean {
  if (!isRecord(value)) return false;
  return methods.every((method) => typeof value[method] === "function");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isStringRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}
