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
  resolveProviderOpts,
  terminalAsk,
} from "./shared.js";
import {
  printRunSummary,
  printSensorResult,
  printSessionHeader,
  printDetailsState,
  printSlashHelp,
  printModel,
  printShellCommandHint,
  printStatus,
  printToolCall,
  printToolList,
  printToolResult,
} from "./ui.js";

type ChatOptions = {
  model?: string;
  provider?: "anthropic" | "openai";
  system?: string;
  permissionMode?: string;
  config?: boolean;
  mcp?: boolean;
  tools?: boolean;
  sensors?: boolean;
};

const DEFAULT_SYSTEM = "You are a helpful coding assistant.";

export function chatCommand(): Command {
  return new Command("chat")
    .description("Start an interactive chat session with the configured model")
    .option("-m, --model <model>", "Model name")
    .option("-p, --provider <provider>", "Provider (anthropic|openai)")
    .option("-s, --system <prompt>", "System prompt")
    .option("--permission-mode <mode>", "default | accept-edits | bypass | plan", "default")
    .option("--no-config", "Do not load harness.config.* from the workspace")
    .option("--no-mcp", "Do not connect MCP servers from harness.config.*")
    .option("--no-tools", "Disable built-in tools")
    .option("--no-sensors", "Disable built-in typecheck/lint/test sensors")
    .action(async (rawOpts: ChatOptions) => {
      const providerOpts = resolveProviderOpts(rawOpts);
      const adapter = buildAdapter(providerOpts);
      const cwd = process.cwd();
      const loaded = await loadCliConfig(cwd, rawOpts.config !== false);
      const config = loaded.config;
      const system = await composeSystemPrompt(
        rawOpts.system ?? config.system ?? DEFAULT_SYSTEM,
        cwd,
      );
      const runId = randomUUID();
      const logPath = join(cwd, ".harness", "runs", runId, "events.jsonl");
      const toolSurface = await buildToolSurface(config, {
        toolsEnabled: rawOpts.tools !== false,
        mcpEnabled: rawOpts.mcp !== false,
      });
      const mode = permissionMode(rawOpts.permissionMode);
      const tools = toolSurface.tools?.list();
      const uiState = { details: false };

      printSessionHeader({
        mode: "chat",
        adapter,
        cwd,
        logPath,
        configPath: loaded.path,
        permissionMode: mode,
        withTools: Boolean(toolSurface.tools),
        toolCount: tools?.length ?? 0,
      });

      let assistantStarted = false;
      const summary = await (async () => {
        let rl: ReturnType<typeof readline.createInterface> | undefined;
        try {
          const sink = await FileEventSink.open(logPath);
          rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const activeRl = rl;
          const policy = toolSurface.tools
            ? buildPolicy(mode, terminalAsk(activeRl), config)
            : undefined;
          const sensors =
            rawOpts.sensors === false ? undefined : (config.sensors ?? buildSensors());

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
                return readUserInput(activeRl, {
                  adapter,
                  cwd,
                  logPath,
                  configPath: loaded.path,
                  permissionMode: mode,
                  withTools: Boolean(toolSurface.tools),
                  toolCount: tools?.length ?? 0,
                  tools,
                  uiState,
                });
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
              printToolCall(call, { details: uiState.details });
            },
            onToolResult: (res) => {
              printToolResult(res, { details: uiState.details });
            },
            onSensorRun: (res) => {
              printSensorResult(res);
            },
          });
        } finally {
          rl?.close();
          await toolSurface.close();
        }
      })();

      printRunSummary("session", summary, logPath);
    });
}

type SlashContext = {
  adapter: ModelAdapter;
  cwd: string;
  logPath: string;
  configPath?: string | null;
  permissionMode: ReturnType<typeof permissionMode>;
  withTools: boolean;
  toolCount: number;
  tools?: { name: string; risk: string; source: string; description: string }[];
  uiState: { details: boolean };
};

async function readUserInput(rl: readline.Interface, ctx: SlashContext): Promise<string | null> {
  while (true) {
    let line: string;
    try {
      line = await rl.question(pc.cyan("harness> "));
    } catch {
      return null;
    }

    const handled = handleLocalInput(line, ctx);
    if (handled === "exit") return null;
    if (handled === "handled") continue;
    return line;
  }
}

export function isExitInput(line: string): boolean {
  return ["exit", "quit", "q"].includes(line.trim().toLowerCase());
}

export function isLikelyHarnessInvocation(line: string): boolean {
  return /^harness(\s|$)/.test(line.trim());
}

function handleLocalInput(line: string, ctx: SlashContext): "send" | "handled" | "exit" {
  const trimmed = line.trim();
  if (isExitInput(trimmed)) return "exit";
  if (isLikelyHarnessInvocation(trimmed)) {
    printShellCommandHint(trimmed);
    return "handled";
  }
  if (!trimmed.startsWith("/")) return "send";

  const [command] = trimmed.split(/\s+/, 1);
  switch (command) {
    case "/help":
    case "/?":
      printSlashHelp();
      return "handled";
    case "/status":
      printStatus(ctx);
      return "handled";
    case "/model":
      printModel(ctx.adapter);
      return "handled";
    case "/tools":
      printToolList(ctx.tools);
      return "handled";
    case "/details":
      ctx.uiState.details = !ctx.uiState.details;
      printDetailsState(ctx.uiState.details);
      return "handled";
    case "/log":
      console.log(pc.dim(ctx.logPath));
      return "handled";
    case "/clear":
      process.stdout.write("\x1Bc");
      printSessionHeader({ mode: "chat", ...ctx });
      return "handled";
    case "/exit":
    case "/quit":
    case "/q":
      return "exit";
    default:
      console.log(pc.yellow(`Unknown command: ${command}`));
      console.log(pc.dim("Type /help for available commands."));
      return "handled";
  }
}
