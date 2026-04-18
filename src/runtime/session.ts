import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { HookDispatcher, HookPayload, HookPayloadBase } from "../hooks/dispatcher.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { Sensor, SensorContext } from "../sensors/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type {
  AskPlan,
  ConversationMessage,
  ModelAdapter,
  PermissionMode,
  ReasoningSpec,
  SpawnSubagent,
  SpawnSubagentOptions,
  SpawnSubagentResult,
  ToolCall,
} from "../types.js";
import { compactMessages } from "./compactor.js";
import { classifyContext, DEFAULT_CONTEXT_THRESHOLDS } from "./context-window.js";
import type { ControlChannel } from "./control.js";
import { computeCost } from "./cost.js";
import type { EventSink, HarnessEvent, SessionEndReason } from "./events.js";
import { PLAN_ENTRY_REMINDER, PLAN_EXIT_REMINDER } from "./plan-mode-prompts.js";

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
  /** Optional caller-provided id used to correlate every event in one recorded run. */
  runId?: string;
  /** Internal: sub-sessions sharing a sink should not close it. Default true. */
  closeSink?: boolean;
  /** Max tool calls to execute between two user inputs. Default 25. */
  maxToolsPerUserTurn?: number;
  /** Internal: current subagent recursion depth. Default 0. */
  subagentDepth?: number;
  /** Max subagent recursion depth. Default 1 (parent may spawn, children may not). */
  maxSubagentDepth?: number;
  /** Context-window compaction settings. See `contextManagementDefaults()` for defaults. */
  contextManagement?: ContextManagementConfig;
  /** UI -> runtime control bus used to trigger `/compact` and `/clear` between turns. */
  controls?: ControlChannel;
  onAssistantDelta?: (text: string) => void;
  onAssistantMessage?: (text: string) => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (res: {
    id: string;
    name: string;
    ok: boolean;
    output: string;
    durationMs?: number;
  }) => void;
  onSensorRun?: (res: { name: string; ok: boolean; message: string }) => void;
  onUsage?: (usage: { inputTokens: number; outputTokens: number; costUsd?: number }) => void;
  onModelError?: (error: string) => void;
  /** Keep interactive sessions alive after provider/model errors. Default false for one-shot runs. */
  continueOnModelError?: boolean;
  onCompactStart?: (info: { reason: "auto" | "manual"; instructions?: string }) => void;
  onCompactEnd?: (info: {
    reason: "auto" | "manual";
    summaryTokens: number;
    freedMessages: number;
    snapshotPath: string;
    durationMs: number;
    error?: string;
  }) => void;
  onHistoryCleared?: (info: { messagesDropped: number }) => void;
  onContextWarning?: (info: {
    inputTokens: number;
    contextWindow: number;
    ratio: number;
  }) => void;
  onPermissionModeChanged?: (info: {
    from: PermissionMode;
    to: PermissionMode;
    source: "user" | "tool" | "system";
  }) => void;
  /** UI-provided plan approval prompt. Only wired when plan mode is enabled. */
  askPlan?: AskPlan;
  /**
   * Per-mode deliberative-thinking knob. When `permissionMode === "plan"` the
   * session auto-injects `reasoning: { effort: "high" }` into every turn
   * input — this is what makes plan mode actually "think harder" instead of
   * just "block writes".
   *
   * Override any slot with `null` to disable reasoning even in plan mode.
   * Defaults: `{ plan: { effort: "high" } }`, no reasoning in other modes.
   */
  reasoning?: {
    plan?: ReasoningSpec | null;
    default?: ReasoningSpec | null;
    acceptEdits?: ReasoningSpec | null;
    bypassPermissions?: ReasoningSpec | null;
  };
  signal?: AbortSignal;
};

export type ContextManagementConfig = {
  /** Trigger LLM summarisation automatically when tokens cross `compactThreshold`. Default true. */
  autoCompact?: boolean;
  /** Emit `ContextWarning` at this ratio of the context window. Default 0.80. */
  warnThreshold?: number;
  /** Auto-compact when the last input crosses this ratio. Default 0.90. */
  compactThreshold?: number;
  /** Number of trailing messages kept verbatim after compaction. Default 6. */
  keepLastNTurns?: number;
  /** Most recent N tool results kept verbatim; older ones are masked. Default 6. */
  keepLastNToolOutputs?: number;
  /** Override the summariser system prompt. */
  summarizerSystem?: string;
  /** Adapter used for summarisation. Defaults to the session adapter. */
  summarizerAdapter?: ModelAdapter;
  /** Directory to write snapshots into. Defaults to `<cwd>/.harness/runs/<runId>/compact`. */
  snapshotDir?: string;
};

export type RunSummary = {
  sessionId: string;
  runId: string;
  /** Provider id + model name the session ran against. Used downstream to
   *  decide whether a cost of `$0` means "genuinely free" or "model not in
   *  the pricing table". */
  adapter: { name: string; model: string };
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  /** Last assistant message text emitted during the session (used by subagent results). */
  lastAssistantMessage: string;
};

/** Default per-mode reasoning policy. Plan mode thinks hard, other modes stay
 *  silent so we don't pay reasoning tokens on routine turns. Users override
 *  via `SessionConfig.reasoning`. */
const DEFAULT_REASONING_BY_MODE: Record<PermissionMode, ReasoningSpec | null> = {
  plan: { effort: "high" },
  default: null,
  acceptEdits: null,
  bypassPermissions: null,
};

function resolveReasoningForMode(
  mode: PermissionMode,
  cfg: SessionConfig["reasoning"],
): ReasoningSpec | null {
  // Explicit null in user config disables reasoning; `undefined` falls back
  // to the default for that mode.
  const override = cfg?.[mode];
  if (override === null) return null;
  if (override !== undefined) return override;
  return DEFAULT_REASONING_BY_MODE[mode];
}

const DEFAULT_SUBAGENT_SYSTEM =
  "You are a focused subagent spawned from a parent session. You have no memory of " +
  "the parent's conversation — everything you need is in the task below. Work " +
  "efficiently, use tools as needed, and finish with a concise final message that " +
  "summarizes what you did and any relevant output.";

export async function runSession(cfg: SessionConfig): Promise<RunSummary> {
  const sessionId = randomUUID();
  const runId = cfg.runId ?? randomUUID();
  const closeSink = cfg.closeSink ?? true;
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
  function hookBase<E extends HookPayload["hook_event_name"]>(
    event: E,
  ): HookPayloadBase & { hook_event_name: E } {
    return {
      session_id: sessionId,
      run_id: runId,
      cwd: cfg.cwd,
      timestamp: now(),
      hook_event_name: event,
    };
  }

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
  let workspaceChangedThisSession = false;
  let workspaceChangedSinceAfterTurnSensors = false;
  let endReason: SessionEndReason = "eof";
  let lastAssistantMessage = "";
  let lastInputTokens = 0;
  let compactionCounter = 0;
  let warnedAtCurrentZone = false;
  let suppressAutoCompactAfterFailure = false;
  const subagentDepth = cfg.subagentDepth ?? 0;
  const maxSubagentDepth = cfg.maxSubagentDepth ?? 1;

  const ctxCfg = cfg.contextManagement ?? {};
  const autoCompact = ctxCfg.autoCompact ?? true;
  const warnThreshold = ctxCfg.warnThreshold ?? DEFAULT_CONTEXT_THRESHOLDS.warn;
  const compactThreshold = ctxCfg.compactThreshold ?? DEFAULT_CONTEXT_THRESHOLDS.compact;
  const snapshotDir = ctxCfg.snapshotDir ?? join(cfg.cwd, ".harness", "runs", runId, "compact");

  // Remembers the permission mode we were in before entering plan, so
  // `exit_plan_mode` can restore it (default, acceptEdits, …). If the session
  // *starts* in plan mode (via `--permission-mode plan`) we have no record of
  // a prior mode, so we fall back to "default" on exit.
  const startingMode = cfg.policy?.getMode() ?? "default";
  let previousPermissionMode: PermissionMode =
    startingMode === "plan" ? "default" : startingMode;
  if (startingMode === "plan") {
    pendingReminders.push(PLAN_ENTRY_REMINDER);
  }

  const applyPermissionMode = (
    nextMode: PermissionMode,
    source: "user" | "tool" | "system",
  ): void => {
    if (!cfg.policy) return;
    const fromMode = cfg.policy.getMode();
    if (fromMode === nextMode) return;
    if (fromMode !== "plan" && nextMode === "plan") {
      previousPermissionMode = fromMode;
      pendingReminders.push(PLAN_ENTRY_REMINDER);
    } else if (fromMode === "plan" && nextMode !== "plan") {
      pendingReminders.push(PLAN_EXIT_REMINDER);
    }
    cfg.policy.setMode(nextMode);
    cfg.sink.write({
      ...base(),
      event: "PermissionModeChanged",
      from: fromMode,
      to: nextMode,
      source,
    });
    cfg.onPermissionModeChanged?.({ from: fromMode, to: nextMode, source });
  };

  const spawnSubagent: SpawnSubagent = async (opts: SpawnSubagentOptions) => {
    if (subagentDepth >= maxSubagentDepth) {
      throw new Error(
        `subagent depth limit reached (${maxSubagentDepth}); nested subagents are disabled`,
      );
    }
    const agentId = randomUUID();
    const agentType = opts.description ?? "subagent";

    const parentTools = cfg.tools?.list() ?? [];
    const childRegistry = new ToolRegistry();
    for (const t of parentTools) {
      if (t.name === "subagent") continue;
      if (opts.allowedTools && !opts.allowedTools.includes(t.name)) continue;
      childRegistry.register(t);
    }

    cfg.sink.write({
      ...base(),
      event: "SubagentStart",
      agent_id: agentId,
      agent_type: agentType,
      ...(opts.description ? { description: opts.description } : {}),
    });
    if (cfg.hooks) {
      await cfg.hooks.dispatch({
        ...hookBase("SubagentStart"),
        agent_id: agentId,
        agent_type: agentType,
      });
    }

    let delivered = false;
    const child = await runSession({
      adapter: cfg.adapter,
      system: opts.system ?? DEFAULT_SUBAGENT_SYSTEM,
      cwd: cfg.cwd,
      workspaceRoot,
      runId,
      closeSink: false,
      sink: cfg.sink,
      tools: childRegistry,
      ...(cfg.policy ? { policy: cfg.policy } : {}),
      ...(cfg.hooks ? { hooks: cfg.hooks } : {}),
      // skip sensors in subagents — they'd re-run typecheck/etc at every turn
      subagentDepth: subagentDepth + 1,
      maxSubagentDepth,
      input: {
        async next() {
          if (delivered) return null;
          delivered = true;
          return opts.prompt;
        },
      },
    });

    cfg.sink.write({
      ...base(),
      event: "SubagentStop",
      agent_id: agentId,
      agent_type: agentType,
      last_message: child.lastAssistantMessage,
      turns: child.turns,
    });
    if (cfg.hooks) {
      await cfg.hooks.dispatch({
        ...hookBase("SubagentStop"),
        agent_id: agentId,
        agent_type: agentType,
        last_assistant_message: child.lastAssistantMessage,
      });
    }

    const result: SpawnSubagentResult = {
      agentId,
      lastMessage: child.lastAssistantMessage,
      turns: child.turns,
      totalInputTokens: child.totalInputTokens,
      totalOutputTokens: child.totalOutputTokens,
      totalCostUsd: child.totalCostUsd,
    };
    return result;
  };

  const runSensors = async (
    trigger: Sensor["trigger"],
    extra?: { lastTool?: SensorContext["lastTool"]; workspaceChanged?: boolean },
  ): Promise<void> => {
    for (const s of sensors) {
      if (s.trigger !== trigger) continue;
      const ctx: SensorContext = {
        workspaceRoot,
        cwd: cfg.cwd,
        signal,
        ...(extra?.workspaceChanged !== undefined
          ? { workspaceChanged: extra.workspaceChanged }
          : {}),
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
        pendingReminders.push(
          `<sensor-feedback sensor="${s.name}">\n${result.message}\n</sensor-feedback>`,
        );
      }
    }
  };

  const noteWorkspaceChange = (): void => {
    workspaceChangedThisSession = true;
    workspaceChangedSinceAfterTurnSensors = true;
  };

  const runAfterTurnSensors = async (): Promise<void> => {
    if (!workspaceChangedSinceAfterTurnSensors) return;
    await runSensors("after_turn", { workspaceChanged: true });
    workspaceChangedSinceAfterTurnSensors = false;
  };

  const runCompaction = async (
    reason: "auto" | "manual",
    instructions: string | undefined,
  ): Promise<void> => {
    if (messages.length === 0) return;
    const hookBasePayload = hookBase("PreCompact");
    const ctxWindow = classifyContext(lastInputTokens, cfg.adapter.model).contextWindow;
    if (cfg.hooks) {
      const hookRes = await cfg.hooks.dispatch({
        ...hookBasePayload,
        reason,
        input_tokens: lastInputTokens,
        context_window: ctxWindow,
        threshold: compactThreshold,
        ...(instructions !== undefined ? { instructions } : {}),
      });
      if (hookRes.systemMessage) pendingReminders.push(hookRes.systemMessage);
      if (hookRes.block) {
        cfg.sink.write({
          ...base(),
          event: "HookBlocked",
          hook_event_name: "PreCompact",
          reason: hookRes.reason ?? "blocked by PreCompact hook",
        });
        return;
      }
    }

    const started = Date.now();
    const snapshotPath = join(snapshotDir, `${String(compactionCounter + 1).padStart(4, "0")}-${Date.now()}.jsonl`);
    const compactStart: Extract<HarnessEvent, { event: "CompactStart" }> = {
      ...base(),
      event: "CompactStart",
      reason,
      input_tokens: lastInputTokens,
      threshold: compactThreshold,
      ...(instructions !== undefined ? { instructions } : {}),
    };
    cfg.sink.write(compactStart);
    cfg.onCompactStart?.({ reason, ...(instructions !== undefined ? { instructions } : {}) });

    try {
      const { messages: next, result } = await compactMessages(
        messages,
        {
          reason,
          ...(instructions !== undefined ? { instructions } : {}),
          trigger: {
            tokens: lastInputTokens,
            threshold: compactThreshold,
            contextWindow: ctxWindow,
          },
          snapshotPath,
        },
        {
          adapter: ctxCfg.summarizerAdapter ?? cfg.adapter,
          ...(ctxCfg.keepLastNTurns !== undefined ? { keepLastNTurns: ctxCfg.keepLastNTurns } : {}),
          ...(ctxCfg.keepLastNToolOutputs !== undefined
            ? { keepLastNToolOutputs: ctxCfg.keepLastNToolOutputs }
            : {}),
          ...(ctxCfg.summarizerSystem !== undefined
            ? { summarizerSystem: ctxCfg.summarizerSystem }
            : {}),
        },
        signal,
      );
      messages.length = 0;
      messages.push(...next);
      compactionCounter += 1;
      if (result.summaryInputTokens > 0 || result.summaryOutputTokens > 0) {
        totalInput += result.summaryInputTokens;
        totalOutput += result.summaryOutputTokens;
        totalCost += result.summaryCostUsd ?? 0;
        const usage: Extract<HarnessEvent, { event: "Usage" }> = {
          ...base(),
          event: "Usage",
          input_tokens: result.summaryInputTokens,
          output_tokens: result.summaryOutputTokens,
        };
        if (result.summaryCostUsd !== undefined) usage.cost_usd = result.summaryCostUsd;
        cfg.sink.write(usage);
        cfg.onUsage?.({
          inputTokens: result.summaryInputTokens,
          outputTokens: result.summaryOutputTokens,
          ...(result.summaryCostUsd !== undefined ? { costUsd: result.summaryCostUsd } : {}),
        });
      }
      // Reset the warn latch AND the token estimate: after compaction the
      // next turn will report a much lower input token count, and we must not
      // retrigger auto-compaction on the now-stale `lastInputTokens` value
      // before the first post-compaction turn has reported real usage.
      warnedAtCurrentZone = false;
      suppressAutoCompactAfterFailure = false;
      lastInputTokens = 0;

      const duration = Date.now() - started;
      cfg.sink.write({
        ...base(),
        event: "CompactEnd",
        reason,
        summary_tokens: result.summaryTokens,
        freed_messages: result.freedMessages,
        snapshot_path: result.snapshotPath,
        duration_ms: duration,
      });
      cfg.onCompactEnd?.({
        reason,
        summaryTokens: result.summaryTokens,
        freedMessages: result.freedMessages,
        snapshotPath: result.snapshotPath,
        durationMs: duration,
      });
      if (cfg.hooks) {
        await cfg.hooks.dispatch({
          ...hookBase("PostCompact"),
          reason,
          summary_tokens: result.summaryTokens,
          freed_messages: result.freedMessages,
          snapshot_path: result.snapshotPath,
        });
      }
    } catch (err) {
      // Compaction is best-effort: if it fails, keep going with the existing
      // messages. Emit an error-flavoured CompactEnd with freed_messages = 0
      // so observers know we tried and failed.
      const duration = Date.now() - started;
      const error = err instanceof Error ? err.message : String(err);
      suppressAutoCompactAfterFailure = true;
      cfg.sink.write({
        ...base(),
        event: "CompactEnd",
        reason,
        summary_tokens: 0,
        freed_messages: 0,
        snapshot_path: snapshotPath,
        duration_ms: duration,
        error,
      });
      cfg.onCompactEnd?.({
        reason,
        summaryTokens: 0,
        freedMessages: 0,
        snapshotPath,
        durationMs: duration,
        error,
      });
    }
  };

  const clearHistory = (): void => {
    if (messages.length === 0) return;
    const dropped = messages.length;
    messages.length = 0;
    warnedAtCurrentZone = false;
    suppressAutoCompactAfterFailure = false;
    lastInputTokens = 0;
    cfg.sink.write({ ...base(), event: "HistoryCleared", messages_dropped: dropped });
    cfg.onHistoryCleared?.({ messagesDropped: dropped });
  };

  const drainControls = async (): Promise<void> => {
    if (!cfg.controls) return;
    let control = cfg.controls.poll();
    while (control) {
      if (control.type === "compact") {
        await runCompaction("manual", control.instructions);
      } else if (control.type === "clear") {
        clearHistory();
      } else if (control.type === "set_mode") {
        applyPermissionMode(control.mode, "user");
      }
      control = cfg.controls.poll();
    }
  };

  const maybeAutoCompact = async (): Promise<void> => {
    const classified = classifyContext(lastInputTokens, cfg.adapter.model, {
      warn: warnThreshold,
      compact: compactThreshold,
    });
    if (classified.zone === "unknown") return;
    if (classified.zone !== "critical") suppressAutoCompactAfterFailure = false;
    // Warnings are emitted regardless of `autoCompact`: the user opted out of
    // automatic compaction but still deserves a heads-up that the window is
    // filling up so they can trigger `/compact` manually.
    if (classified.zone === "warn" && !warnedAtCurrentZone) {
      warnedAtCurrentZone = true;
      cfg.sink.write({
        ...base(),
        event: "ContextWarning",
        input_tokens: classified.lastInputTokens,
        context_window: classified.contextWindow ?? 0,
        ratio: classified.ratio ?? 0,
      });
      cfg.onContextWarning?.({
        inputTokens: classified.lastInputTokens,
        contextWindow: classified.contextWindow ?? 0,
        ratio: classified.ratio ?? 0,
      });
    }
    if (classified.zone === "critical" && autoCompact && !suppressAutoCompactAfterFailure) {
      await runCompaction("auto", undefined);
    }
  };

  let pendingInput: Promise<string | null> | null = null;
  const waitForUserInput = async (): Promise<string | null> => {
    while (true) {
      await drainControls();
      await maybeAutoCompact();
      if (!cfg.controls) return cfg.input.next();

      pendingInput ??= cfg.input.next();
      const controlWaiter = cfg.controls.wait();
      const winner = await Promise.race([
        pendingInput.then((value) => ({ type: "input" as const, value })),
        controlWaiter.promise.then(() => ({ type: "control" as const })),
      ]);
      if (winner.type === "input") {
        controlWaiter.cancel();
        pendingInput = null;
        return winner.value;
      }
    }
  };

  try {
    userLoop: while (true) {
      const userInput = await waitForUserInput();
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

        const reasoning = resolveReasoningForMode(
          cfg.policy?.getMode() ?? "default",
          cfg.reasoning,
        );
        const turnInput = {
          system: cfg.system,
          messages,
          ...(toolSpecs && toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
          ...(reasoning ? { reasoning } : {}),
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
            lastInputTokens = event.inputTokens;
          } else if (event.type === "stop") {
            stopReason = event.reason;
            errorMsg = event.error;
          }
        }

        if (assistantText || toolCalls.length > 0) {
          if (assistantText) {
            cfg.sink.write({ ...base(), event: "AssistantMessage", text: assistantText });
            cfg.onAssistantMessage?.(assistantText);
            lastAssistantMessage = assistantText;
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
          cfg.onUsage?.({
            inputTokens: lastUsage.input,
            outputTokens: lastUsage.output,
            ...(lastUsage.cost !== undefined ? { costUsd: lastUsage.cost } : {}),
          });
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
          cfg.onModelError?.(errorMsg ?? "model call failed");
          if (cfg.continueOnModelError) {
            await runAfterTurnSensors();
            break modelLoop;
          }
          endReason = "error";
          break userLoop;
        }

        if (stopReason !== "tool_use" || toolCalls.length === 0) {
          await runAfterTurnSensors();
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
            cfg.onToolResult?.({
              id: call.id,
              name: call.name,
              ok: false,
              output,
              durationMs: 0,
            });
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
            cfg.onToolResult?.({
              id: call.id,
              name: call.name,
              ok: false,
              output,
              durationMs: 0,
            });
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
            cfg.onToolResult?.({
              id: call.id,
              name: call.name,
              ok: false,
              output,
              durationMs: 0,
            });
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
            cfg.onToolResult?.({
              id: call.id,
              name: call.name,
              ok: false,
              output,
              durationMs: 0,
            });
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
              cfg.onToolResult?.({
                id: call.id,
                name: call.name,
                ok: false,
                output,
                durationMs: 0,
              });
              continue;
            }
          }

          const started = Date.now();
          try {
            if (tool.risk !== "read") noteWorkspaceChange();
            const result = await tool.run(parsed.data, {
              workspaceRoot,
              cwd: cfg.cwd,
              signal,
              sessionId,
              runId,
              spawnSubagent,
              ...(cfg.askPlan ? { askPlan: cfg.askPlan } : {}),
              setPermissionMode: (mode, source = "tool") => {
                applyPermissionMode(mode, source);
              },
              previousPermissionMode,
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
              durationMs: duration,
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
            cfg.onToolResult?.({
              id: call.id,
              name: call.name,
              ok: false,
              output,
              durationMs: duration,
            });
          }
        }
      }
    }
  } finally {
    await runSensors("final", { workspaceChanged: workspaceChangedThisSession }).catch(() => {
      // swallow — don't fail SessionEnd on a broken sensor
    });
    cfg.sink.write({ ...base(), event: "SessionEnd", end_reason: endReason });
    if (cfg.hooks) {
      await cfg.hooks
        .dispatch({ ...hookBase("SessionEnd"), end_reason: endReason })
        .catch(() => undefined);
    }
    if (closeSink) await cfg.sink.close();
  }

  return {
    sessionId,
    runId,
    adapter: { name: cfg.adapter.name, model: cfg.adapter.model },
    turns,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCostUsd: totalCost,
    lastAssistantMessage,
  };
}
