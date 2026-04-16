import { access, constants } from "node:fs/promises";
import { resolve } from "node:path";

import { Command } from "commander";
import pc from "picocolors";

type Check = { name: string; ok: boolean; detail: string; required: boolean };

const MIN_NODE_MAJOR = 20;

export function doctorCommand(): Command {
  return new Command("doctor")
    .description("Validate environment: node version, API keys, write permissions")
    .option("-C, --cwd <path>", "Project root to test write access on")
    .action(async (opts: { cwd?: string }) => {
      const cwd = resolve(opts.cwd ?? process.cwd());
      const checks: Check[] = [];

      checks.push(checkNodeVersion());
      checks.push(checkEnvKey("ANTHROPIC_API_KEY", false));
      checks.push(checkEnvKey("OPENAI_API_KEY", false));
      checks.push(await checkWritable(cwd));

      const requiredFails = checks.filter((c) => c.required && !c.ok);
      const anyApiKey = checks.some(
        (c) => c.name.endsWith("_API_KEY") && c.ok,
      );

      for (const c of checks) {
        const tag = c.ok ? pc.green("ok  ") : c.required ? pc.red("FAIL") : pc.yellow("warn");
        console.log(`  ${tag}  ${pc.bold(c.name)}  ${pc.dim(c.detail)}`);
      }

      if (!anyApiKey) {
        console.log(
          pc.yellow(
            "\n  no provider API key set — `harness chat`/`run` will fail until you export ANTHROPIC_API_KEY or OPENAI_API_KEY",
          ),
        );
      }

      if (requiredFails.length > 0) {
        console.log(pc.red(`\n${requiredFails.length} required check(s) failed`));
        process.exit(1);
      } else {
        console.log(pc.green("\nready"));
      }
    });
}

function checkNodeVersion(): Check {
  const v = process.versions.node;
  const major = Number.parseInt(v.split(".")[0] ?? "0", 10);
  return {
    name: "node",
    ok: major >= MIN_NODE_MAJOR,
    detail: `v${v} (need >=${MIN_NODE_MAJOR})`,
    required: true,
  };
}

function checkEnvKey(name: string, required: boolean): Check {
  const v = process.env[name];
  const ok = typeof v === "string" && v.length > 0;
  return {
    name,
    ok,
    detail: ok ? "set" : "missing",
    required,
  };
}

async function checkWritable(dir: string): Promise<Check> {
  try {
    await access(dir, constants.W_OK);
    return { name: "workspace writable", ok: true, detail: dir, required: true };
  } catch (err) {
    return {
      name: "workspace writable",
      ok: false,
      detail: `${dir}: ${err instanceof Error ? err.message : String(err)}`,
      required: true,
    };
  }
}
