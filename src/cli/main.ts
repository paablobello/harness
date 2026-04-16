#!/usr/bin/env node
process.noDeprecation = true;

process.on("warning", (warning: Error & { code?: string }) => {
  if (warning.code === "DEP0040" && warning.message.includes("punycode")) return;
  console.warn(warning.stack ?? `${warning.name}: ${warning.message}`);
});

const { Command } = await import("commander");
const { VERSION } = await import("../index.js");
const { chatCommand } = await import("./chat.js");
const { doctorCommand } = await import("./doctor.js");
const { evalCommand } = await import("./eval.js");
const { initCommand } = await import("./init.js");
const { inspectCommand } = await import("./inspect.js");
const { runCommand } = await import("./run.js");
const { toolsCommand } = await import("./tools.js");

const program = new Command();

program
  .name("harness")
  .description("A provider-agnostic coding-agent harness CLI + SDK")
  .version(VERSION);

program.addCommand(initCommand());
program.addCommand(doctorCommand());
program.addCommand(chatCommand(), { isDefault: true });
program.addCommand(runCommand());
program.addCommand(toolsCommand());
program.addCommand(inspectCommand());
program.addCommand(evalCommand());

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

export {};
