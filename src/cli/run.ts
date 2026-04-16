import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import readline from "node:readline/promises";

import { Command } from "commander";
import pc from "picocolors";

import { FileEventSink } from "../runtime/events.js";
import { runSession } from "../runtime/session.js";
import {
  buildAdapter,
  buildPolicy,
  buildSensors,
  buildToolSurface,
  composeSystemPrompt,
  loadCliConfig,
  permissionMode,
  terminalAsk,
} from "./shared.js";

type RunOptions = {
  model: string;
  provider: "anthropic" | "openai";
  system?: string;
  cwd?: string;
  permissionMode?: string;
  noConfig?: boolean;
  noMcp?: boolean;
  noSensors?: boolean;
};

const DEFAULT_SYSTEM = `You are an autonomous coding assistant running inside a sandboxed workspace.
You have tools to read, search, and edit files, and to run shell commands.
Complete the user's task in as few steps as possible. After each tool result, reason briefly
about the next step. When the task is done, write a short final message summarizing what you did.`;

export function runCommand(): Command {
  return new Command("run")
    .description("Run a one-shot task non-interactively")
    .argument("<task...>", "Task description to hand to the agent")
    .option("-m, --model <model>", "Model name", "claude-sonnet-4-5")
    .option("-p, --provider <provider>", "Provider (anthropic|openai)", "anthropic")
    .option("-s, --system <prompt>", "System prompt override")
    .option("-C, --cwd <path>", "Workspace / working dir (default: current dir)")
    .option("--permission-mode <mode>", "default | accept-edits | bypass | plan", "default")
    .option("--no-config", "Do not load harness.config.* from the workspace")
    .option("--no-mcp", "Do not connect MCP servers from harness.config.*")
    .option("--no-sensors", "Disable built-in typecheck/lint/test sensors")
    .action(async (taskParts: string[], rawOpts: RunOptions) => {
      const task = taskParts.join(" ");
      const cwd = resolve(rawOpts.cwd ?? process.cwd());
      const adapter = buildAdapter(rawOpts);
      const loaded = await loadCliConfig(cwd, rawOpts.noConfig !== true);
      const config = loaded.config;
      const system = await composeSystemPrompt(
        rawOpts.system ?? config.system ?? DEFAULT_SYSTEM,
        cwd,
      );
      const runId = randomUUID();
      const logPath = join(cwd, ".harness", "runs", runId, "events.jsonl");
      const toolSurface = await buildToolSurface(config, {
        toolsEnabled: true,
        mcpEnabled: rawOpts.noMcp !== true,
      });

      console.log(pc.dim(`run: ${adapter.name}:${adapter.model} cwd=${cwd}`));
      if (loaded.path) console.log(pc.dim(`config → ${loaded.path}`));
      console.log(pc.dim(`events → ${logPath}\n`));

      let delivered = false;
      let assistantStarted = false;

      const summary = await (async () => {
        let rl: ReturnType<typeof readline.createInterface> | undefined;
        try {
          const sink = await FileEventSink.open(logPath);
          rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const policy = buildPolicy(
            permissionMode(rawOpts.permissionMode),
            terminalAsk(rl),
            config,
          );
          const sensors = rawOpts.noSensors ? undefined : (config.sensors ?? buildSensors());

          return await runSession({
            adapter,
            system,
            cwd,
            workspaceRoot: cwd,
            runId,
            sink,
            ...(toolSurface.tools ? { tools: toolSurface.tools } : {}),
            policy,
            ...(config.hooks ? { hooks: config.hooks } : {}),
            ...(sensors ? { sensors } : {}),
            ...(config.maxToolsPerUserTurn !== undefined
              ? { maxToolsPerUserTurn: config.maxToolsPerUserTurn }
              : {}),
            ...(config.maxSubagentDepth !== undefined
              ? { maxSubagentDepth: config.maxSubagentDepth }
              : {}),
            input: {
              async next() {
                if (delivered) return null;
                delivered = true;
                return task;
              },
            },
            onAssistantDelta: (text) => {
              if (!assistantStarted) {
                process.stdout.write(pc.yellow(`${adapter.name}> `));
                assistantStarted = true;
              }
              process.stdout.write(text);
            },
            onAssistantMessage: () => {
              process.stdout.write("\n");
              assistantStarted = false;
            },
            onToolCall: (call) => {
              console.log(pc.blue(`  → ${call.name}`));
            },
            onToolResult: (res) => {
              const tag = res.ok ? pc.green("ok") : pc.red("fail");
              const preview = res.output.split("\n")[0]?.slice(0, 120) ?? "";
              console.log(pc.dim(`  ← [${tag}] ${preview}`));
            },
            onSensorRun: (res) => {
              const tag = res.ok ? pc.green("ok") : pc.red("fail");
              const preview = res.message.split("\n")[0]?.slice(0, 120) ?? "";
              console.log(pc.dim(`  ∴ sensor ${res.name} [${tag}] ${preview}`));
            },
          });
        } finally {
          rl?.close();
          await toolSurface.close();
        }
      })();

      const cost = summary.totalCostUsd > 0 ? `$${summary.totalCostUsd.toFixed(4)}` : "n/a";
      console.log(
        pc.dim(
          `\n[run] turns=${summary.turns} tokens=${summary.totalInputTokens}→${summary.totalOutputTokens} cost≈${cost}`,
        ),
      );
      console.log(pc.dim(`[run] ${logPath}`));
    });
}
