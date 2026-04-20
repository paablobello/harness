export { VERSION } from "./version.js";

// Core types — stable SDK surface
export type {
  AskPlan,
  ConversationMessage,
  ModelAdapter,
  ModelEvent,
  ModelTurnInput,
  PermissionMode,
  PlanDecision,
  PolicyDecision,
  PolicyRule,
  ReasoningEffort,
  ReasoningSpec,
  StopReason,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolRisk,
  ToolSource,
  ToolSpec,
} from "./types.js";

// Adapters
export { createAnthropicAdapter } from "./adapters/anthropic.js";
export type { AnthropicAdapterOptions } from "./adapters/anthropic.js";
export { createOpenAIAdapter } from "./adapters/openai.js";
export type { OpenAIAdapterOptions } from "./adapters/openai.js";

// Runtime
export {
  FileEventSink,
  MemoryEventSink,
  type EventSink,
  type HarnessEvent,
  type SessionEndReason,
} from "./runtime/events.js";
export { runSession } from "./runtime/session.js";
export type { RunSummary, SessionConfig, UserInputStream } from "./runtime/session.js";
export { computeCost } from "./runtime/cost.js";
export { resolveWithinWorkspace } from "./runtime/workspace.js";

// Tools
export { ToolRegistry } from "./tools/registry.js";
export { createBuiltinRegistry } from "./tools/builtin.js";
export { readFileTool } from "./tools/read-file.js";
export { listFilesTool } from "./tools/list-files.js";
export { grepFilesTool } from "./tools/grep-files.js";
export { editFileTool } from "./tools/edit-file.js";
export { applyPatchTool } from "./tools/apply-patch.js";
export { runCommandTool } from "./tools/run-command.js";
export { jobOutputTool } from "./tools/job-output.js";
export { exitPlanModeTool } from "./tools/exit-plan-mode.js";

// Policy
export { PolicyEngine } from "./policy/engine.js";
export type { AskPrompt, PolicyEngineOptions } from "./policy/engine.js";
export { defaultPolicy } from "./policy/defaults.js";

// Hooks
export { HookDispatcher } from "./hooks/dispatcher.js";
export type {
  HookEvent,
  HookHandler,
  HookPayload,
  HookPayloadBase,
  HookResult,
} from "./hooks/dispatcher.js";

// Sensors
export type {
  Sensor,
  SensorContext,
  SensorKind,
  SensorResult,
  SensorTrigger,
} from "./sensors/types.js";
export {
  createBuiltinSensors,
  lintSensor,
  testSensor,
  typecheckSensor,
  llmReviewSensor,
} from "./sensors/builtin.js";
export { shellSensor } from "./sensors/shell.js";

// MCP
export { McpHub } from "./mcp/client.js";
export type { McpServerSpec } from "./mcp/client.js";

// Config
export { loadAgentsMd } from "./config/agents-md.js";
export {
  findHarnessConfig,
  loadHarnessConfig,
  summarizeHarnessConfig,
  validateHarnessConfig,
} from "./config/harness-config.js";
export type { HarnessConfig, LoadedHarnessConfig } from "./config/harness-config.js";
