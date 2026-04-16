import { Command } from "commander";
import pc from "picocolors";

import { createBuiltinRegistry } from "../tools/builtin.js";

export function toolsCommand(): Command {
  return new Command("tools").description("List built-in tools available to the agent").action(() => {
    const reg = createBuiltinRegistry();
    const list = reg.list();
    for (const t of list) {
      const risk =
        t.risk === "read" ? pc.green(t.risk) : t.risk === "write" ? pc.yellow(t.risk) : pc.red(t.risk);
      console.log(`${pc.bold(t.name)}  ${pc.dim(`[${risk}] ${t.source}`)}`);
      console.log(`  ${t.description}`);
    }
    console.log(pc.dim(`\n${list.length} tools registered.`));
  });
}
