import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Command } from "commander";
import pc from "picocolors";

const HARNESS_CONFIG_MJS = `// harness.config.mjs — auto-loaded by \`harness chat\`, \`harness run\`, and \`harness tools\`.
export default {
  // CLI flags still choose provider/model/permission mode.
  // This file describes project-specific overrides.
  //
  // Defaults already include built-in tools, default policy rules, and
  // typecheck/lint/test sensors. Uncomment only what this project needs.
  //
  // system: "Project-specific system prompt override.",
  // maxToolsPerUserTurn: 25,
  // maxSubagentDepth: 1,
  mcpServers: [
    // Example:
    // { name: "filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
  ],
};
`;

const AGENTS_MD = `# Project guide for the agent

This file is auto-loaded into the session as the \`project\` context layer.
Stuff you'd otherwise repeat in every prompt belongs here.

## Style
- Match existing code style; don't reformat unrelated lines.
- Prefer the smallest reasonable change.

## Commands the agent can rely on
- Tests: \`npm test\` (or \`pnpm test\`)
- Typecheck: \`npx tsc --noEmit\`
- Lint: \`npx eslint .\`

## Things to avoid
- Don't \`rm -rf\` anything.
- Don't push to \`main\`.
- Don't add new top-level dependencies without asking.
`;

const HARNESS_GITIGNORE = `# Harness run logs (per-run JSONL event traces)
*
!.gitignore
`;

type Force = { force?: boolean };

export function initCommand(): Command {
  return new Command("init")
    .description("Scaffold harness.config.mjs, AGENTS.md and .harness/ in the cwd")
    .option("-C, --cwd <path>", "Where to scaffold (default: current dir)")
    .option("-f, --force", "Overwrite files that already exist")
    .action(async (opts: Force & { cwd?: string }) => {
      const root = resolve(opts.cwd ?? process.cwd());
      const targets: { rel: string; body: string }[] = [
        { rel: "harness.config.mjs", body: HARNESS_CONFIG_MJS },
        { rel: "AGENTS.md", body: AGENTS_MD },
        { rel: ".harness/runs/.gitignore", body: HARNESS_GITIGNORE },
      ];

      let wrote = 0;
      let skipped = 0;
      for (const t of targets) {
        const abs = join(root, t.rel);
        if (!opts.force && (await exists(abs))) {
          console.log(
            pc.yellow(`  skip  ${t.rel}`) + pc.dim(" (exists; pass --force to overwrite)"),
          );
          skipped += 1;
          continue;
        }
        await mkdir(join(abs, ".."), { recursive: true });
        await writeFile(abs, t.body, "utf8");
        console.log(pc.green(`  wrote ${t.rel}`));
        wrote += 1;
      }

      console.log(pc.dim(`\n${wrote} written, ${skipped} skipped — root: ${root}`));
      if (wrote > 0) {
        console.log(pc.dim('next: `harness doctor` then `harness run "..."`'));
      }
    });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
