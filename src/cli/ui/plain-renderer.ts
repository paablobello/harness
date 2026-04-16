/**
 * Plain-renderer: the non-TTY fallback. These functions write colored ANSI
 * directly to stdout and are used when Ink's virtual DOM cannot run (pipes,
 * CI, non-interactive shells) and for the `run` / `inspect` commands that are
 * designed to be pipeable by default.
 */
export {
  printDetailsState,
  printModel,
  printRunSummary,
  printSensorResult,
  printSessionHeader,
  printShellCommandHint,
  printSlashHelp,
  printStatus,
  printToolCall,
  printToolList,
  printToolResult,
  formatInputSummary,
} from "../ui.js";
