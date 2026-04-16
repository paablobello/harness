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
  buildRegistry,
  permissionMode,
  terminalAsk,
} from "./shared.js";

type ChatOptions = {
  model: string;
  provider: "anthropic" | "openai";
  system: string;
  permissionMode?: string;
  noTools?: boolean;
};

export function chatCommand(): Command {
  return new Command("chat")
    .description("Start an interactive chat session with the configured model")
    .option("-m, --model <model>", "Model name", "claude-sonnet-4-5")
    .option("-p, --provider <provider>", "Provider (anthropic|openai)", "anthropic")
    .option("-s, --system <prompt>", "System prompt", "You are a helpful coding assistant.")
    .option(
      "--permission-mode <mode>",
      "default | accept-edits | bypass | plan",
      "default",
    )
    .option("--no-tools", "Disable built-in tools")
    .action(async (rawOpts: ChatOptions) => {
      const adapter = buildAdapter(rawOpts);
      const runId = randomUUID();
      const logPath = join(process.cwd(), ".harness", "runs", runId, "events.jsonl");
      const sink = await FileEventSink.open(logPath);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      const tools = rawOpts.noTools ? undefined : buildRegistry();
      const policy = tools ? buildPolicy(permissionMode(rawOpts.permissionMode), terminalAsk(rl)) : undefined;

      printBanner(adapter, logPath, Boolean(tools));

      let assistantStarted = false;
      const summary = await runSession({
        adapter,
        system: rawOpts.system,
        cwd: process.cwd(),
        sink,
        ...(tools ? { tools } : {}),
        ...(policy ? { policy } : {}),
        input: {
          async next() {
            try {
              const line = await rl.question(pc.cyan("you> "));
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
      });
      rl.close();

      const cost =
        summary.totalCostUsd > 0 ? `$${summary.totalCostUsd.toFixed(4)}` : "n/a";
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
