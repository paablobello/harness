import { applyPatchTool } from "./apply-patch.js";
import { editFileTool } from "./edit-file.js";
import { exitPlanModeTool } from "./exit-plan-mode.js";
import { grepFilesTool } from "./grep-files.js";
import { jobOutputTool } from "./job-output.js";
import { listFilesTool } from "./list-files.js";
import { readFileTool } from "./read-file.js";
import { ToolRegistry } from "./registry.js";
import { runCommandTool } from "./run-command.js";
import { subagentTool } from "./subagent.js";

export function createBuiltinRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(readFileTool);
  reg.register(listFilesTool);
  reg.register(grepFilesTool);
  reg.register(editFileTool);
  reg.register(applyPatchTool);
  reg.register(runCommandTool);
  reg.register(jobOutputTool);
  reg.register(subagentTool);
  reg.register(exitPlanModeTool);
  return reg;
}

export {
  applyPatchTool,
  editFileTool,
  exitPlanModeTool,
  grepFilesTool,
  jobOutputTool,
  listFilesTool,
  readFileTool,
  runCommandTool,
  subagentTool,
};
