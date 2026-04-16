import { applyPatchTool } from "./apply-patch.js";
import { editFileTool } from "./edit-file.js";
import { grepFilesTool } from "./grep-files.js";
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
  reg.register(subagentTool);
  return reg;
}

export {
  applyPatchTool,
  editFileTool,
  grepFilesTool,
  listFilesTool,
  readFileTool,
  runCommandTool,
  subagentTool,
};
