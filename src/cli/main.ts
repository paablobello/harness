#!/usr/bin/env node
import { Command } from "commander";

import { VERSION } from "../index.js";
import { chatCommand } from "./chat.js";
import { doctorCommand } from "./doctor.js";
import { evalCommand } from "./eval.js";
import { initCommand } from "./init.js";
import { inspectCommand } from "./inspect.js";
import { runCommand } from "./run.js";
import { toolsCommand } from "./tools.js";

const program = new Command();

program
  .name("harness")
  .description("A provider-agnostic coding-agent harness CLI + SDK")
  .version(VERSION);

program.addCommand(initCommand());
program.addCommand(doctorCommand());
program.addCommand(chatCommand());
program.addCommand(runCommand());
program.addCommand(toolsCommand());
program.addCommand(inspectCommand());
program.addCommand(evalCommand());

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
