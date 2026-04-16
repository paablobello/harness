/**
 * Public SDK types. The core never imports provider SDKs; those live in
 * `src/adapters/*` and translate to/from these neutral shapes.
 */

import type { ZodType } from "zod";

export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type ConversationMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string; isError?: boolean };

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: unknown;
};

export type ModelTurnInput = {
  system: string;
  messages: ConversationMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
};

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: "stop"; reason: StopReason; error?: string };

export type StopReason = "end_turn" | "max_tokens" | "tool_use" | "error";

export type ModelAdapter = {
  readonly name: string;
  readonly model: string;
  runTurn(input: ModelTurnInput, signal: AbortSignal): AsyncIterable<ModelEvent>;
};

export type ToolRisk = "read" | "write" | "execute";
export type ToolSource = "builtin" | "mcp";

export type ToolContext = {
  workspaceRoot: string;
  cwd: string;
  signal: AbortSignal;
  sessionId: string;
  runId: string;
};

export type ToolResult = {
  ok: boolean;
  output: string;
  meta?: Record<string, unknown>;
};

export type ToolDefinition<I = unknown> = {
  name: string;
  description: string;
  inputSchema: ZodType<I>;
  risk: ToolRisk;
  source: ToolSource;
  run(input: I, ctx: ToolContext): Promise<ToolResult>;
};

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export type PolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "ask"; reason?: string };

export type PolicyRule = {
  match: { tool: string | RegExp; pattern?: RegExp };
  decision: "allow" | "deny" | "ask";
  reason?: string;
};
