import { randomUUID } from "node:crypto";
import { join } from "node:path";
import readline from "node:readline/promises";

import { Command } from "commander";
import pc from "picocolors";

import { FileEventSink } from "../runtime/events.js";
import { runSession } from "../runtime/session.js";
import type { ModelAdapter } from "../types.js";
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

type ChatOptions = {
  model: string;
  provider: "anthropic" | "openai";
  system?: string;
  permissionMode?: string;
  noConfig?: boolean;
  noMcp?: boolean;
  noTools?: boolean;
  noSensors?: boolean;
};

const DEFAULT_SYSTEM = "You are a helpful coding assistant.";

export function chatCommand(): Command {
  return new Command("chat")
    .description("Start an interactive chat session with the configured model")
    .option("-m, --model <model>", "Model name", "claude-sonnet-4-5")
    .option("-p, --provider <provider>", "Provider (anthropic|openai)", "anthropic")
    .option("-s, --system <prompt>", "System prompt")
    .option("--permission-mode <mode>", "default | accept-edits | bypass | plan", "default")
    .option("--no-config", "Do not load harness.config.* from the workspace")
    .option("--no-mcp", "Do not connect MCP servers from harness.config.*")
    .option("--no-tools", "Disable built-in tools")
    .option("--no-sensors", "Disable built-in typecheck/lint/test sensors")
    .action(async (rawOpts: ChatOptions) => {
      const adapter = buildAdapter(rawOpts);
      const cwd = process.cwd();
      const loaded = await loadCliConfig(cwd, rawOpts.noConfig !== true);
      const config = loaded.config;
      const system = await composeSystemPrompt(
        rawOpts.system ?? config.system ?? DEFAULT_SYSTEM,
        cwd,
      );
      const runId = randomUUID();
      const logPath = join(cwd, ".harness", "runs", runId, "events.jsonl");
      const toolSurface = await buildToolSurface(config, {
        toolsEnabled: rawOpts.noTools !== true,
        mcpEnabled: rawOpts.noMcp !== true,
      });

      printBanner(adapter, logPath, Boolean(toolSurface.tools));
      if (loaded.path) console.log(pc.dim(`Config → ${loaded.path}`));

      let assistantStarted = false;
      const summary = await (async () => {
        let rl: ReturnType<typeof readline.createInterface> | undefined;
        try {
          const sink = await FileEventSink.open(logPath);
          rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const activeRl = rl;
          const policy = toolSurface.tools
            ? buildPolicy(permissionMode(rawOpts.permissionMode), terminalAsk(activeRl), config)
            : undefined;
          const sensors = rawOpts.noSensors ? undefined : (config.sensors ?? buildSensors());

          return await runSession({
            adapter,
            system,
            cwd,
            runId,
            sink,
            ...(toolSurface.tools ? { tools: toolSurface.tools } : {}),
            ...(policy ? { policy } : {}),
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
                try {
                  const line = await activeRl.question(pc.cyan("you> "));
                  return line;
                } catch {
                  return null;
                }
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
          `\n[session] turns=${summary.turns} tokens=${summary.totalInputTokens}→${summary.totalOutputTokens} cost≈${cost}`,
        ),
      );
      console.log(pc.dim(`[session] ${logPath}`));
    });
}

function printBanner(adapter: ModelAdapter, logPath: string, withTools: boolean): void {
  console.log(
    pc.dim(
      `Chat with ${adapter.name}:${adapter.model} (ctrl+D or ctrl+C to exit) ${withTools ? "[tools on]" : "[tools off]"}`,
    ),
  );
  console.log(pc.dim(`Events → ${logPath}`));
  console.log();
}
