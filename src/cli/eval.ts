import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Command } from "commander";
import { execa } from "execa";
import pc from "picocolors";

import { defaultPolicy } from "../policy/defaults.js";
import { PolicyEngine } from "../policy/engine.js";
import { MemoryEventSink } from "../runtime/events.js";
import { runSession } from "../runtime/session.js";
import { createBuiltinRegistry } from "../tools/builtin.js";
import type { PermissionMode } from "../types.js";
import { buildAdapter } from "./shared.js";

/**
 * Approved-fixtures eval harness. Each fixture defines a task plus assertions;
 * we materialize a temp workspace, run the agent, and check the post-state.
 * Designed to surface harness regressions, not to grade the model's quality.
 */

export type Fixture = {
  name: string;
  task: string;
  model?: string;
  provider?: "anthropic" | "openai";
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  /** Files to seed the workspace with before the run starts. */
  setup?: { files?: Record<string, string> };
  assertions?: {
    filesExist?: string[];
    fileContains?: { path: string; matches: string[] }[];
    /** Run a shell command after the agent finishes; assert exit=0 + substrings. */
    command?: { cmd: string; stdoutContains?: string[]; exitCode?: number };
    /** Cap on tool calls — fails if the agent thrashed. */
    maxToolCalls?: number;
  };
};

type FixtureResult = {
  name: string;
  pass: boolean;
  failures: string[];
  turns: number;
  toolCalls: number;
  durationMs: number;
};

type EvalOptions = {
  model: string;
  provider: "anthropic" | "openai";
  bail?: boolean;
};

export function evalCommand(): Command {
  return new Command("eval")
    .description("Run fixture-based regression tasks against the harness")
    .argument("<patterns...>", "Glob(s) matching fixture .json files")
    .option("-m, --model <model>", "Default model (fixture can override)", "claude-sonnet-4-5")
    .option("-p, --provider <provider>", "Default provider (fixture can override)", "anthropic")
    .option("--bail", "Stop on first failure")
    .action(async (patterns: string[], opts: EvalOptions) => {
      const files = await expandFixtures(patterns);
      if (files.length === 0) {
        console.error(pc.red("No fixtures matched."));
        process.exit(1);
      }

      const results: FixtureResult[] = [];
      for (const file of files) {
        const fixture = await loadFixture(file);
        console.log(pc.bold(`\n▶ ${fixture.name}`) + pc.dim(`  ${file}`));
        const res = await runFixture(fixture, opts);
        results.push(res);
        printResult(res);
        if (opts.bail && !res.pass) break;
      }

      const passed = results.filter((r) => r.pass).length;
      const failed = results.length - passed;
      console.log(
        pc.bold(`\n${passed}/${results.length} passed`) +
          (failed > 0 ? pc.red(`  ${failed} failed`) : ""),
      );
      if (failed > 0) process.exit(1);
    });
}

async function expandFixtures(patterns: string[]): Promise<string[]> {
  // Shell wildcards have already been expanded by the time argv lands here.
  // We just dedupe + absolutize and let the JSON.parse step fail loudly on
  // anything that isn't a real fixture file.
  const out = new Set<string>();
  for (const p of patterns) out.add(resolve(p));
  return [...out].sort();
}

async function loadFixture(file: string): Promise<Fixture> {
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw) as Fixture;
  if (!parsed.name || !parsed.task) {
    throw new Error(`Fixture ${file} is missing required field name/task`);
  }
  return parsed;
}

export async function runFixture(
  fixture: Fixture,
  opts: EvalOptions,
): Promise<FixtureResult> {
  const root = await mkdtemp(join(tmpdir(), `harness-eval-${slug(fixture.name)}-`));
  const started = Date.now();
  const failures: string[] = [];
  let turns = 0;
  let toolCalls = 0;

  try {
    if (fixture.setup?.files) {
      for (const [rel, content] of Object.entries(fixture.setup.files)) {
        const abs = join(root, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
      }
    }

    const adapter = buildAdapter({
      model: fixture.model ?? opts.model,
      provider: fixture.provider ?? opts.provider,
    });
    const tools = createBuiltinRegistry();
    const policy = new PolicyEngine({
      rules: defaultPolicy,
      mode: (fixture.permissionMode ?? "bypassPermissions") as PermissionMode,
    });
    const sink = new MemoryEventSink();

    let delivered = false;
    const summary = await runSession({
      adapter,
      system:
        "You are an autonomous coding agent in an isolated sandbox. " +
        "Complete the task using your tools. Be concise.",
      cwd: root,
      workspaceRoot: root,
      sink,
      tools,
      policy,
      input: {
        async next() {
          if (delivered) return null;
          delivered = true;
          return fixture.task;
        },
      },
      onToolCall: () => {
        toolCalls += 1;
      },
    });
    turns = summary.turns;

    // Pin the run id so a debug log is reachable from the workspace dir.
    const runId = summary.runId;
    await persistRunLog(root, runId, sink);

    await checkAssertions(root, fixture, toolCalls, failures);
  } catch (err) {
    failures.push(`run threw: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Keep the temp dir on failure so the user can inspect it.
    if (failures.length === 0) {
      await rm(root, { recursive: true, force: true });
    } else {
      console.log(pc.dim(`  workspace kept: ${root}`));
    }
  }

  return {
    name: fixture.name,
    pass: failures.length === 0,
    failures,
    turns,
    toolCalls,
    durationMs: Date.now() - started,
  };
}

async function persistRunLog(
  root: string,
  runId: string,
  sink: MemoryEventSink,
): Promise<void> {
  const dir = join(root, ".harness", "runs", runId);
  await mkdir(dir, { recursive: true });
  const lines = sink.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(join(dir, "events.jsonl"), lines, "utf8");
}

export async function checkAssertions(
  root: string,
  fixture: Fixture,
  toolCalls: number,
  failures: string[],
): Promise<void> {
  const a = fixture.assertions ?? {};

  for (const rel of a.filesExist ?? []) {
    try {
      await readFile(join(root, rel));
    } catch {
      failures.push(`expected file missing: ${rel}`);
    }
  }

  for (const fc of a.fileContains ?? []) {
    let body: string;
    try {
      body = await readFile(join(root, fc.path), "utf8");
    } catch {
      failures.push(`fileContains: cannot read ${fc.path}`);
      continue;
    }
    for (const m of fc.matches) {
      if (!body.includes(m)) failures.push(`${fc.path} missing substring: ${m}`);
    }
  }

  if (a.command) {
    try {
      const res = await execa(a.command.cmd, {
        cwd: root,
        shell: "/bin/sh",
        reject: false,
        timeout: 30_000,
      });
      const expectedExit = a.command.exitCode ?? 0;
      if (res.exitCode !== expectedExit) {
        failures.push(
          `command exit=${res.exitCode} (expected ${expectedExit}): ${a.command.cmd}`,
        );
      }
      const stdout = String(res.stdout ?? "");
      for (const m of a.command.stdoutContains ?? []) {
        if (!stdout.includes(m)) failures.push(`command stdout missing: ${m}`);
      }
    } catch (err) {
      failures.push(
        `command failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (a.maxToolCalls !== undefined && toolCalls > a.maxToolCalls) {
    failures.push(`tool calls ${toolCalls} > maxToolCalls ${a.maxToolCalls}`);
  }
}

function printResult(r: FixtureResult): void {
  const tag = r.pass ? pc.green("PASS") : pc.red("FAIL");
  console.log(
    `  ${tag}  turns=${r.turns} tools=${r.toolCalls} ${r.durationMs}ms`,
  );
  for (const f of r.failures) console.log(pc.red(`    ✗ ${f}`));
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 32) || `${randomUUID().slice(0, 8)}`;
}
