import { resolve } from "node:path";

import { Command } from "commander";
import pc from "picocolors";

import { buildToolSurface, loadCliConfig } from "./shared.js";

type ToolsOptions = {
  cwd?: string;
  noConfig?: boolean;
  noMcp?: boolean;
};

export function toolsCommand(): Command {
  return new Command("tools")
    .description("List tools available to the agent")
    .option("-C, --cwd <path>", "Workspace whose harness.config.* should be loaded")
    .option("--no-config", "Do not load harness.config.* from the workspace")
    .option("--no-mcp", "Do not connect MCP servers from harness.config.*")
    .action(async (opts: ToolsOptions) => {
      const cwd = resolve(opts.cwd ?? process.cwd());
      const loaded = await loadCliConfig(cwd, opts.noConfig !== true);
      const toolSurface = await buildToolSurface(loaded.config, {
        toolsEnabled: true,
        mcpEnabled: opts.noMcp !== true,
      });

      try {
        if (loaded.path) console.log(pc.dim(`config → ${loaded.path}`));
        const list = toolSurface.tools?.list() ?? [];
        for (const t of list) {
          const risk =
            t.risk === "read"
              ? pc.green(t.risk)
              : t.risk === "write"
                ? pc.yellow(t.risk)
                : pc.red(t.risk);
          console.log(`${pc.bold(t.name)}  ${pc.dim(`[${risk}] ${t.source}`)}`);
          console.log(`  ${t.description}`);
        }
        console.log(pc.dim(`\n${list.length} tools registered.`));
      } finally {
        await toolSurface.close();
      }
    });
}
