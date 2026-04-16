import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Command } from "commander";
import pc from "picocolors";

import type { HarnessEvent } from "../runtime/events.js";

type InspectOptions = {
  cwd?: string;
  full?: boolean;
};

const PREVIEW_CHARS = 200;

export function inspectCommand(): Command {
  return new Command("inspect")
    .description("Render a readable timeline of a recorded run")
    .argument("[run-id]", "Run id (or 'latest'). Defaults to latest.", "latest")
    .option("-C, --cwd <path>", "Project root containing .harness/")
    .option("--full", "Print full tool outputs / messages (no truncation)")
    .action(async (runIdArg: string, opts: InspectOptions) => {
      const root = resolve(opts.cwd ?? process.cwd());
      const runsDir = join(root, ".harness", "runs");

      const runId = runIdArg === "latest" ? await findLatestRun(runsDir) : runIdArg;
      if (!runId) {
        console.error(pc.red(`No runs found under ${runsDir}`));
        process.exit(1);
      }

      const eventsPath = join(runsDir, runId, "events.jsonl");
      const events = await readEvents(eventsPath);
      renderTimeline(events, { full: !!opts.full });
      console.log(pc.dim(`\n${eventsPath}`));
    });
}

async function findLatestRun(runsDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return null;
  }
  let latest: { name: string; mtime: number } | null = null;
  for (const name of entries) {
    try {
      const s = await stat(join(runsDir, name));
      if (!s.isDirectory()) continue;
      if (!latest || s.mtimeMs > latest.mtime) latest = { name, mtime: s.mtimeMs };
    } catch {
      // skip unreadable
    }
  }
  return latest?.name ?? null;
}

export async function readEvents(filePath: string): Promise<HarnessEvent[]> {
  const raw = await readFile(filePath, "utf8");
  const out: HarnessEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as HarnessEvent);
    } catch {
      // skip malformed line — preserves partial-tail readability
    }
  }
  return out;
}

type RenderOpts = { full: boolean };

export function renderTimeline(events: HarnessEvent[], opts: RenderOpts = { full: false }): void {
  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  const policyCounts: Record<string, number> = { allow: 0, deny: 0, ask: 0 };
  const sensorRuns: { name: string; ok: boolean }[] = [];

  // Buffer streamed deltas so we don't print one line per token.
  let pendingDelta = "";
  const flushDelta = (): void => {
    if (pendingDelta) {
      console.log(pc.yellow(`  assistant> `) + truncate(pendingDelta, opts.full));
      pendingDelta = "";
    }
  };

  for (const e of events) {
    switch (e.event) {
      case "SessionStart":
        console.log(
          pc.bold("Session ") + pc.dim(`${e.session_id.slice(0, 8)} run=${e.run_id.slice(0, 8)}`),
        );
        console.log(pc.dim(`  ${e.adapter}:${e.model}  cwd=${e.cwd}`));
        break;
      case "UserPromptSubmit":
        flushDelta();
        console.log(pc.cyan(`\nuser> `) + truncate(e.prompt, opts.full));
        break;
      case "AssistantTextDelta":
        pendingDelta += e.text;
        break;
      case "AssistantMessage":
        // The message arrives as one event after deltas finish — we already
        // streamed deltas, so flush them and skip duplicating.
        if (!pendingDelta) {
          console.log(pc.yellow(`  assistant> `) + truncate(e.text, opts.full));
        } else {
          flushDelta();
        }
        break;
      case "ToolCall":
        flushDelta();
        toolCalls += 1;
        console.log(
          pc.blue(`  → ${e.tool_name}`) +
            pc.dim(`  ${truncate(JSON.stringify(e.tool_input), opts.full, 120)}`),
        );
        break;
      case "PolicyDecision": {
        policyCounts[e.decision] = (policyCounts[e.decision] ?? 0) + 1;
        const color =
          e.decision === "allow" ? pc.green : e.decision === "deny" ? pc.red : pc.magenta;
        const reason = e.reason ? pc.dim(` (${e.reason})`) : "";
        console.log(`    ${color(`policy: ${e.decision}`)}${reason}`);
        break;
      }
      case "ToolResult": {
        if (!e.ok) toolFailures += 1;
        const tag = e.ok ? pc.green("ok") : pc.red("fail");
        const ms = pc.dim(`${e.duration_ms}ms`);
        console.log(`    ${tag}  ${ms}  ` + truncate(e.output, opts.full, 160));
        break;
      }
      case "HookBlocked":
        console.log(pc.red(`  hook blocked ${e.hook_event_name}: ${e.reason}`));
        break;
      case "SensorRun":
        sensorRuns.push({ name: e.name, ok: e.ok });
        console.log(
          (e.ok ? pc.green("  sensor ok ") : pc.red("  sensor fail ")) +
            pc.bold(e.name) +
            pc.dim(` [${e.kind}/${e.trigger}] ${e.duration_ms}ms`) +
            (e.message ? "\n    " + truncate(e.message, opts.full, 240) : ""),
        );
        break;
      case "SubagentStart":
        flushDelta();
        console.log(
          pc.magenta(`  ▶ subagent `) +
            pc.bold(e.agent_type) +
            pc.dim(` ${e.agent_id.slice(0, 8)}`),
        );
        break;
      case "SubagentStop":
        console.log(
          pc.magenta(`  ◀ subagent `) +
            pc.bold(e.agent_type) +
            pc.dim(` turns=${e.turns}`) +
            "\n    " +
            truncate(e.last_message, opts.full, 240),
        );
        break;
      case "Usage":
        totalIn += e.input_tokens;
        totalOut += e.output_tokens;
        if (e.cost_usd) totalCost += e.cost_usd;
        break;
      case "Stop":
        if (e.error) console.log(pc.red(`  stop=error: ${e.error}`));
        break;
      case "SessionEnd":
        flushDelta();
        console.log(pc.dim(`\nsession end (${e.end_reason})`));
        break;
      default:
        // Unknown event type — surface raw for forward-compat.
        console.log(pc.dim(`  · ${JSON.stringify(e)}`));
    }
  }
  flushDelta();

  const cost = totalCost > 0 ? `$${totalCost.toFixed(4)}` : "n/a";
  console.log(
    pc.dim(
      `\ntools=${toolCalls} (fail=${toolFailures})  policy: ${policyCounts["allow"]}a/${policyCounts["deny"]}d/${policyCounts["ask"]}?  sensors=${sensorRuns.length}  tokens=${totalIn}→${totalOut}  cost≈${cost}`,
    ),
  );
}

function truncate(text: string, full: boolean, max: number = PREVIEW_CHARS): string {
  if (full) return text;
  const single = text.replace(/\n/g, " ⏎ ");
  return single.length <= max
    ? single
    : single.slice(0, max) + pc.dim(` …(+${single.length - max})`);
}
