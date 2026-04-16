import { randomUUID } from "node:crypto";

import type { HookDispatcher, HookPayload } from "../hooks/dispatcher.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { Sensor, SensorContext } from "../sensors/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ConversationMessage, ModelAdapter, ToolCall } from "../types.js";
import { computeCost } from "./cost.js";
import type { EventSink, HarnessEvent, SessionEndReason } from "./events.js";

/**
 * An `UserInputStream` drives the turn loop. Returning `null` means the user
 * is done (EOF / ctrl-D / exit). The CLI wraps readline; tests wrap a queue.
 */
export type UserInputStream = {
  next(): Promise<string | null>;
};

export type SessionConfig = {
  adapter: ModelAdapter;
  system: string;
  cwd: string;
  sink: EventSink;
  input: UserInputStream;
  tools?: ToolRegistry;
  policy?: PolicyEngine;
  hooks?: HookDispatcher;
  sensors?: Sensor[];
  /** Absolute path used to confine tool paths. Defaults to `cwd`. */
  workspaceRoot?: string;
  /** Max tool calls to execute between two user inputs. Default 25. */
  maxToolsPerUserTurn?: number;
  onAssistantDelta?: (text: string) => void;
  onAssistantMessage?: (text: string) => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (res: { id: string; name: string; ok: boolean; output: string }) => void;
  onSensorRun?: (res: { name: string; ok: boolean; message: string }) => void;
  signal?: AbortSignal;
};

export type RunSummary = {
  sessionId: string;
  runId: string;
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
};

export async function runSession(cfg: SessionConfig): Promise<RunSummary> {
  const sessionId = randomUUID();
  const runId = randomUUID();
  const workspaceRoot = cfg.workspaceRoot ?? cfg.cwd;
  const maxTools = cfg.maxToolsPerUserTurn ?? 25;
  const signal = cfg.signal ?? new AbortController().signal;
  const sensors = cfg.sensors ?? [];

  const now = (): string => new Date().toISOString();
  const base = (): { timestamp: string; session_id: string; run_id: string } => ({
    timestamp: now(),
    session_id: sessionId,
    run_id: runId,
  });
  const hookBase = (event: HookPayload["hook_event_name"]): Pick<
    HookPayload,
    "session_id" | "run_id" | "cwd" | "timestamp" | "hook_event_name"
  > => ({
    session_id: sessionId,
    run_id: runId,
    cwd: cfg.cwd,
    timestamp: now(),
    hook_event_name: event,
  });

  cfg.sink.write({
    ...base(),
    event: "SessionStart",
    model: cfg.adapter.model,
    adapter: cfg.adapter.name,
    cwd: cfg.cwd,
  });
  if (cfg.hooks) {
    await cfg.hooks.dispatch({ ...hookBase("SessionStart"), source: "startup" });
  }

  const messages: ConversationMessage[] = [];
  const pendingReminders: string[] = [];
  const toolSpecs = cfg.tools?.specs();
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let turns = 0;
  let endReason: SessionEndReason = "eof";

  const runSensors = async (
    trigger: Sensor["trigger"],
    extra?: { lastTool?: SensorContext["lastTool"] },
  ): Promise<void> => {
    for (const s of sensors) {
      if (s.trigger !== trigger) continue;
      const ctx: SensorContext = {
        workspaceRoot,
        cwd: cfg.cwd,
        signal,
        ...(extra?.lastTool ? { lastTool: extra.lastTool } : {}),
      };
      if (s.applicable) {
        const ok = await s.applicable(ctx);
        if (!ok) continue;
      }
      const started = Date.now();
      const result = await s.run(ctx);
      const duration = Date.now() - started;
      cfg.sink.write({
        ...base(),
        event: "SensorRun",
        name: s.name,
        kind: s.kind,
        trigger: s.trigger,
        ok: result.ok,
        message: result.message,
        duration_ms: duration,
      });
      cfg.onSensorRun?.({ name: s.name, ok: result.ok, message: result.message });
      if (result.message) {
        pendingReminders.push(`<sensor-feedback sensor="${s.name}">\n${result.message}\n</sensor-feedback>`);
      }
    }
  };

  try {
    userLoop: while (true) {
      const userInput = await cfg.input.next();
      if (userInput === null) {
        endReason = "user_exit";
        break;
      }

      if (cfg.hooks) {
        const hookRes = await cfg.hooks.dispatch({
          ...hookBase("UserPromptSubmit"),
          prompt: userInput,
        });
        if (hookRes.systemMessage) {
          pendingReminders.push(hookRes.systemMessage);
        }
        if (hookRes.block) {
          cfg.sink.write({
            ...base(),
            event: "HookBlocked",
            hook_event_name: "UserPromptSubmit",
            reason: hookRes.reason ?? "blocked by hook",
          });
          continue;
        }
      }

      cfg.sink.write({ ...base(), event: "UserPromptSubmit", prompt: userInput });
      messages.push({ role: "user", content: userInput });

      let toolsThisUserTurn = 0;

      modelLoop: while (true) {
        while (pendingReminders.length > 0) {
          const r = pendingReminders.shift()!;
          messages.push({ role: "user", content: r });
        }

        let assistantText = "";
        const toolCalls: ToolCall[] = [];
        let lastUsage: { input: number; output: number; cost?: number } | null = null;
        let stopReason: "end_turn" | "max_tokens" | "tool_use" | "error" = "end_turn";
        let errorMsg: string | undefined;

        const turnInput = {
          system: cfg.system,
          messages,
          ...(toolSpecs && toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
        };

        for await (const event of cfg.adapter.runTurn(turnInput, signal)) {
          if (event.type === "text_delta") {
            assistantText += event.text;
            cfg.onAssistantDelta?.(event.text);
            cfg.sink.write({ ...base(), event: "AssistantTextDelta", text: event.text });
          } else if (event.type === "tool_call") {
            toolCalls.push({ id: event.id, name: event.name, input: event.input });
          } else if (event.type === "usage") {
            const cost =
              event.costUsd ??
              computeCost(cfg.adapter.model, event.inputTokens, event.outputTokens);
            lastUsage = { input: event.inputTokens, output: event.outputTokens, cost };
          } else if (event.type === "stop") {
            stopReason = event.reason;
            errorMsg = event.error;
          }
        }

        if (assistantText || toolCalls.length > 0) {
          if (assistantText) {
            cfg.sink.write({ ...base(), event: "AssistantMessage", text: assistantText });
            cfg.onAssistantMessage?.(assistantText);
          }
          messages.push({
            role: "assistant",
            content: assistantText,
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          });
        }

        if (lastUsage) {
          totalInput += lastUsage.input;
          totalOutput += lastUsage.output;
          totalCost += lastUsage.cost ?? 0;
          const usage: Extract<HarnessEvent, { event: "Usage" }> = {
            ...base(),
            event: "Usage",
            input_tokens: lastUsage.input,
            output_tokens: lastUsage.output,
          };
          if (lastUsage.cost !== undefined) usage.cost_usd = lastUsage.cost;
          cfg.sink.write(usage);
        }

        const stop: Extract<HarnessEvent, { event: "Stop" }> = {
          ...base(),
          event: "Stop",
          reason: stopReason,
        };
        if (errorMsg) stop.error = errorMsg;
        cfg.sink.write(stop);
        if (cfg.hooks) {
          await cfg.hooks.dispatch({ ...hookBase("Stop"), reason: stopReason });
        }

        turns += 1;

        if (stopReason === "error") {
          endReason = "error";
          break userLoop;
        }

        if (stopReason !== "tool_use" || toolCalls.length === 0) {
          await runSensors("after_turn");
          break modelLoop;
        }

        for (const call of toolCalls) {
          if (toolsThisUserTurn >= maxTools) {
            const output = `Aborted: exceeded max ${maxTools} tool calls per user turn.`;
            cfg.sink.write({
              ...base(),
              event: "ToolResult",
              tool_use_id: call.id,
              tool_name: call.name,
              ok: false,
              output,
              duration_ms: 0,
            });
            messages.push({ role: "tool", toolCallId: call.id, content: output, isError: true });
            continue;
          }
          toolsThisUserTurn += 1;

          cfg.sink.write({
            ...base(),
            event: "ToolCall",
            tool_use_id: call.id,
            tool_name: call.name,
            tool_input: call.input,
          });
          cfg.onToolCall?.(call);

          const tool = cfg.tools?.get(call.name);
          if (!tool) {
            const output = `Unknown tool: ${call.name}`;
            cfg.sink.write({
              ...base(),
              event: "ToolResult",
              tool_use_id: call.id,
              tool_name: call.name,
              ok: false,
              output,
              duration_ms: 0,
            });
            messages.push({ role: "tool", toolCallId: call.id, content: output, isError: true });
            continue;
          }

          const parsed = tool.inputSchema.safeParse(call.input);
          if (!parsed.success) {
            const output = `Invalid input for ${call.name}: ${parsed.error.message}`;
            cfg.sink.write({
              ...base(),
              event: "ToolResult",
              tool_use_id: call.id,
              tool_name: call.name,
              ok: false,
              output,
              duration_ms: 0,
            });
            messages.push({ role: "tool", toolCallId: call.id, content: output, isError: true });
            continue;
          }

          let decision: { decision: "allow" | "deny" | "ask"; reason?: string } = {
            decision: "allow",
          };
          if (cfg.policy) {
            decision = await cfg.policy.decide({ tool, input: parsed.data });
          }
          cfg.sink.write({
            ...base(),
            event: "PolicyDecision",
            tool_use_id: call.id,
            tool_name: call.name,
            decision: decision.decision,
            ...(decision.reason ? { reason: decision.reason } : {}),
          });

          if (decision.decision !== "allow") {
            const output = `Denied by policy: ${decision.reason ?? "no reason"}`;
            cfg.sink.write({
              ...base(),
              event: "ToolResult",
              tool_use_id: call.id,
              tool_name: call.name,
              ok: false,
              output,
              duration_ms: 0,
            });
            messages.push({ role: "tool", toolCallId: call.id, content: output, isError: true });
            cfg.onToolResult?.({ id: call.id, name: call.name, ok: false, output });
            continue;
          }

          if (cfg.hooks) {
            const hookRes = await cfg.hooks.dispatch({
              ...hookBase("PreToolUse"),
              tool_name: call.name,
              tool_input: parsed.data,
              tool_use_id: call.id,
            });
            if (hookRes.systemMessage) pendingReminders.push(hookRes.systemMessage);
            if (hookRes.block) {
              const reason = hookRes.reason ?? "blocked by PreToolUse hook";
              cfg.sink.write({
                ...base(),
                event: "HookBlocked",
                hook_event_name: "PreToolUse",
                reason,
                tool_name: call.name,
                tool_use_id: call.id,
              });
              const output = `Blocked by hook: ${reason}`;
              cfg.sink.write({
                ...base(),
                event: "ToolResult",
                tool_use_id: call.id,
                tool_name: call.name,
                ok: false,
                output,
                duration_ms: 0,
              });
              messages.push({
                role: "tool",
                toolCallId: call.id,
                content: output,
                isError: true,
              });
              cfg.onToolResult?.({ id: call.id, name: call.name, ok: false, output });
              continue;
            }
          }

          const started = Date.now();
          try {
            const result = await tool.run(parsed.data, {
              workspaceRoot,
              cwd: cfg.cwd,
              signal,
              sessionId,
              runId,
            });
            const duration = Date.now() - started;
            cfg.sink.write({
              ...base(),
              event: "ToolResult",
              tool_use_id: call.id,
              tool_name: call.name,
              ok: result.ok,
              output: result.output,
              duration_ms: duration,
            });
            messages.push({
              role: "tool",
              toolCallId: call.id,
              content: result.output,
              ...(result.ok ? {} : { isError: true }),
            });
            cfg.onToolResult?.({
              id: call.id,
              name: call.name,
              ok: result.ok,
              output: result.output,
            });
            if (cfg.hooks) {
              const hookPayload = result.ok
                ? {
                    ...hookBase("PostToolUse"),
                    tool_name: call.name,
                    tool_input: parsed.data,
                    tool_use_id: call.id,
                    tool_response: result.output,
                  }
                : {
                    ...hookBase("PostToolUseFailure"),
                    tool_name: call.name,
                    tool_input: parsed.data,
                    tool_use_id: call.id,
                    error: result.output,
                  };
              const hookRes = await cfg.hooks.dispatch(hookPayload as HookPayload);
              if (hookRes.systemMessage) pendingReminders.push(hookRes.systemMessage);
            }
            await runSensors("after_tool", {
              lastTool: {
                name: call.name,
                input: parsed.data,
                ok: result.ok,
                output: result.output,
              },
            });
          } catch (err) {
            const duration = Date.now() - started;
            const output = `Tool threw: ${err instanceof Error ? err.message : String(err)}`;
            cfg.sink.write({
              ...base(),
              event: "ToolResult",
              tool_use_id: call.id,
              tool_name: call.name,
              ok: false,
              output,
              duration_ms: duration,
            });
            messages.push({ role: "tool", toolCallId: call.id, content: output, isError: true });
            cfg.onToolResult?.({ id: call.id, name: call.name, ok: false, output });
          }
        }
      }
    }
  } finally {
    await runSensors("final").catch(() => {
      // swallow — don't fail SessionEnd on a broken sensor
    });
    cfg.sink.write({ ...base(), event: "SessionEnd", end_reason: endReason });
    if (cfg.hooks) {
      await cfg.hooks
        .dispatch({ ...hookBase("SessionEnd"), end_reason: endReason })
        .catch(() => undefined);
    }
    await cfg.sink.close();
  }

  return {
    sessionId,
    runId,
    turns,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCostUsd: totalCost,
  };
}
