import { basename, relative } from "node:path";

import pc from "picocolors";

import type { RunSummary } from "../runtime/session.js";
import type { ModelAdapter, PermissionMode, ToolCall } from "../types.js";

type ToolResultView = { id: string; name: string; ok: boolean; output: string };
type SensorResultView = { name: string; ok: boolean; message: string };
type ToolRenderOptions = { details?: boolean };

export function printSessionHeader(opts: {
  mode: "chat" | "run";
  adapter: ModelAdapter;
  cwd: string;
  logPath: string;
  configPath?: string | null;
  permissionMode: PermissionMode;
  withTools: boolean;
  toolCount?: number;
}): void {
  const label = opts.mode === "chat" ? "interactive" : "one-shot";
  const repo = basename(opts.cwd) || opts.cwd;
  const log = relative(opts.cwd, opts.logPath) || opts.logPath;
  const config = opts.configPath ? relative(opts.cwd, opts.configPath) || opts.configPath : "none";
  const tools = opts.withTools ? `${opts.toolCount ?? "?"} on` : "off";

  console.log(pc.bold("╭─ Harness"));
  console.log(`│ ${pc.dim(label)}  ${pc.cyan(`${opts.adapter.name}:${opts.adapter.model}`)}`);
  console.log(`│ repo   ${repo}`);
  console.log(`│ mode   ${opts.permissionMode}  tools ${tools}`);
  console.log(`│ cwd    ${opts.cwd}`);
  console.log(`│ config ${config}`);
  console.log(`│ log    ${log}`);
  if (opts.mode === "chat") {
    console.log(pc.dim("╰─ /help for commands · exit to quit"));
  } else {
    console.log(pc.dim("╰─ running task"));
  }
  console.log();
}

export function printToolCall(call: ToolCall, opts: ToolRenderOptions = {}): void {
  console.log(
    `${pc.dim("╭─")} ${pc.blue("tool")} ${pc.bold(call.name)}${formatInputSummary(call.name, call.input)}`,
  );
  if (opts.details) printJsonBlock("input", call.input);
}

export function printToolResult(res: ToolResultView, opts: ToolRenderOptions = {}): void {
  const tag = res.ok ? pc.green("ok") : pc.red("fail");
  const preview = firstLine(res.output, 140);
  console.log(`${pc.dim("╰─")} ${tag} ${preview}`);
  if (opts.details && res.output.includes("\n")) {
    console.log(pc.dim(indent(res.output, "   ")));
  }
}

export function printSensorResult(res: SensorResultView): void {
  const tag = res.ok ? pc.green("ok") : pc.red("fail");
  const preview = firstLine(res.message, 140);
  console.log(`${pc.dim("sensor")} ${res.name} ${tag} ${preview}`);
}

export function printRunSummary(
  label: "run" | "session",
  summary: RunSummary,
  logPath: string,
): void {
  const cost = summary.totalCostUsd > 0 ? `$${summary.totalCostUsd.toFixed(4)}` : "unknown";
  console.log(
    pc.dim(
      `\n${label} done  turns=${summary.turns}  tokens=${summary.totalInputTokens}->${summary.totalOutputTokens}  cost~${cost}`,
    ),
  );
  console.log(pc.dim(`log ${logPath}`));
}

export function printSlashHelp(): void {
  console.log(pc.bold("╭─ Commands"));
  console.log(`│ ${pc.cyan("/help")}      show this help`);
  console.log(`│ ${pc.cyan("/status")}    show cwd, model, permission mode, and log path`);
  console.log(`│ ${pc.cyan("/model")}     show the active model`);
  console.log(`│ ${pc.cyan("/tools")}     list available tools`);
  console.log(`│ ${pc.cyan("/details")}   toggle detailed tool input/output`);
  console.log(`│ ${pc.cyan("/log")}       print the current events.jsonl path`);
  console.log(`│ ${pc.cyan("/clear")}     clear the terminal`);
  console.log(`│ ${pc.cyan("/exit")}      quit the chat; bare ${pc.cyan("exit")} works too`);
  console.log(pc.dim("╰─"));
  console.log();
}

export function printStatus(opts: {
  adapter: ModelAdapter;
  cwd: string;
  logPath: string;
  configPath?: string | null;
  permissionMode: PermissionMode;
  withTools: boolean;
  toolCount?: number;
  details?: boolean;
}): void {
  console.log(pc.bold("╭─ Status"));
  console.log(`│ model   ${opts.adapter.name}:${opts.adapter.model}`);
  console.log(`│ cwd     ${opts.cwd}`);
  console.log(`│ mode    ${opts.permissionMode}`);
  console.log(`│ tools   ${opts.withTools ? `${opts.toolCount ?? "?"} on` : "off"}`);
  console.log(`│ details ${opts.details ? "on" : "off"}`);
  console.log(`│ config  ${opts.configPath ?? "none"}`);
  console.log(`│ log     ${opts.logPath}`);
  console.log(pc.dim("╰─"));
  console.log();
}

export function printToolList(
  tools: { name: string; risk: string; source: string; description: string }[] | undefined,
): void {
  const list = tools ?? [];
  if (list.length === 0) {
    console.log(pc.dim("No tools registered."));
    return;
  }
  console.log(pc.bold("╭─ Tools"));
  for (const tool of list) {
    console.log(
      `│ ${pc.cyan(tool.name.padEnd(14))} ${riskLabel(tool.risk)} ${pc.dim(tool.source)}`,
    );
    console.log(pc.dim(`│   ${firstLine(tool.description, 92)}`));
  }
  console.log(pc.dim(`╰─ ${list.length} tools registered.`));
  console.log();
}

export function printModel(adapter: ModelAdapter): void {
  console.log(`${pc.bold("model")} ${adapter.name}:${adapter.model}`);
  console.log(pc.dim("Restart the session with --provider/--model to change it."));
  console.log();
}

export function printDetailsState(enabled: boolean): void {
  console.log(`${pc.bold("details")} ${enabled ? "on" : "off"}`);
  console.log(pc.dim("When on, tool calls include JSON input and multi-line output."));
  console.log();
}

export function printShellCommandHint(command: string): void {
  console.log(pc.yellow("That looks like a shell command, but you are inside Harness chat."));
  console.log(pc.dim(`Leave with ${pc.cyan("exit")} and run: ${command}`));
  console.log();
}

export function formatInputSummary(tool: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (tool === "run_command" && typeof o["command"] === "string") {
      return pc.dim(`  $ ${o["command"]}`);
    }
    if (typeof o["path"] === "string") return pc.dim(`  ${o["path"]}`);
    if (typeof o["pattern"] === "string") return pc.dim(`  /${o["pattern"]}/`);
  }
  try {
    return pc.dim(`  ${JSON.stringify(input).slice(0, 180)}`);
  } catch {
    return "";
  }
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}...` : line;
}

function riskLabel(risk: string): string {
  if (risk === "read") return pc.green("read   ");
  if (risk === "write") return pc.yellow("write  ");
  if (risk === "execute") return pc.red("exec   ");
  return pc.dim(risk.padEnd(7));
}

function printJsonBlock(label: string, value: unknown): void {
  try {
    console.log(
      pc.dim(`│ ${label} ${JSON.stringify(value, null, 2).replace(/\n/g, "\n│       ")}`),
    );
  } catch {
    // Best effort only. Tool execution should never fail because rendering did.
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
