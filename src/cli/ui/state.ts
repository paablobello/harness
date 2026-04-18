import type { ModelAdapter, PermissionMode, ToolCall } from "../../types.js";

export type UserMsg = {
  readonly kind: "user";
  readonly id: string;
  readonly text: string;
  readonly turn: number;
};

export type AssistantMsg = {
  readonly kind: "assistant";
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly turn: number;
};

export type ToolMsg = {
  readonly kind: "tool";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly status: "pending" | "running" | "ok" | "fail";
  readonly output: string;
  readonly durationMs?: number;
  readonly expanded: boolean;
  readonly turn: number;
};

export type SensorMsg = {
  readonly kind: "sensor";
  readonly id: string;
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
  readonly turn: number;
};

export type InfoMsg = {
  readonly kind: "info";
  readonly id: string;
  readonly level: "info" | "warn" | "error";
  readonly text: string;
  readonly turn: number;
};

export type Message = UserMsg | AssistantMsg | ToolMsg | SensorMsg | InfoMsg;

export type PolicyRequest = {
  readonly id: string;
  readonly tool: string;
  readonly input: unknown;
  readonly reason?: string;
};

export type PlanRequest = {
  readonly id: string;
  readonly plan: string;
  readonly allowedTools?: readonly string[];
};

export type SessionMeta = {
  readonly mode: "chat" | "run";
  readonly adapter: Pick<ModelAdapter, "name" | "model">;
  readonly cwd: string;
  readonly logPath: string;
  readonly configPath: string | null;
  readonly permissionMode: PermissionMode;
  readonly withTools: boolean;
  readonly toolCount: number;
};

export type TurnStat = {
  readonly index: number;
  readonly durationMs: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly toolCalls: number;
  readonly toolFailures: number;
};

export type ToolStat = {
  readonly count: number;
  readonly totalMs: number;
  readonly failures: number;
};

export type UsageSnapshot = {
  readonly sessionStartedAt: number;
  /** Tokens sent as input on the most recent model turn (≈ current context window fill). */
  readonly lastInputTokens: number;
  readonly turnHistory: readonly TurnStat[];
  readonly toolUsage: Readonly<Record<string, ToolStat>>;
  /** Totals at the start of the current turn, used to compute a per-turn delta on TURN_END. */
  readonly turnAnchor: {
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly costUsd: number;
    readonly toolCalls: number;
    readonly toolFailures: number;
  } | null;
};

export type CompactionState = {
  readonly phase: "summarizing" | "saving";
  readonly reason: "auto" | "manual";
  readonly startedAt: number;
};

export type UiState = {
  readonly session: SessionMeta;
  /**
   * Mutable current permission mode. Seeded from `session.permissionMode` on
   * init but updated by Shift+Tab and by `PermissionModeChanged` events from
   * the runtime (e.g. after `exit_plan_mode` approval). The `session` field
   * stays as the startup snapshot for the overlay.
   */
  readonly permissionMode: PermissionMode;
  readonly details: boolean;
  readonly messages: readonly Message[];
  readonly focusedToolId: string | null;
  readonly turn: number;
  readonly isAssistantStreaming: boolean;
  readonly isTurnActive: boolean;
  readonly turnStartedAt: number | null;
  readonly pendingPolicy: PolicyRequest | null;
  readonly pendingPlan: PlanRequest | null;
  readonly stats: {
    readonly turns: number;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly costUsd: number;
    readonly toolCalls: number;
    readonly toolFailures: number;
  };
  readonly usage: UsageSnapshot;
  readonly compaction: CompactionState | null;
  /**
   * Latest context-window warning (ratio >= warnThreshold). Cleared when a
   * compaction finishes. Used by the status bar to paint `ctx %` amber.
   */
  readonly contextWarning: { readonly ratio: number; readonly emittedAt: number } | null;
  readonly overlay: Overlay | null;
  readonly shouldExit: boolean;
};

export type Overlay =
  | { readonly type: "help" }
  | { readonly type: "status" }
  | { readonly type: "tools" }
  | { readonly type: "model" }
  | { readonly type: "log" }
  | { readonly type: "details" }
  | { readonly type: "usage" }
  | { readonly type: "context" }
  | { readonly type: "message"; readonly level: "info" | "warn" | "error"; readonly text: string };

export type Action =
  | { type: "USER_SENT"; text: string }
  | { type: "ASSIST_DELTA"; text: string }
  | { type: "ASSIST_END"; text: string }
  | {
      type: "TOOL_CALL";
      call: ToolCall;
    }
  | { type: "TOOL_RESULT"; id: string; ok: boolean; output: string; durationMs?: number }
  | { type: "SENSOR_RUN"; name: string; ok: boolean; message: string }
  | { type: "USAGE"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: "TURN_START" }
  | { type: "TURN_END" }
  | { type: "POLICY_ASK"; request: PolicyRequest }
  | { type: "POLICY_RESOLVE" }
  | { type: "PLAN_ASK"; request: PlanRequest }
  | { type: "PLAN_RESOLVE" }
  | { type: "SET_PERMISSION_MODE"; mode: PermissionMode }
  | { type: "TOGGLE_EXPAND"; id: string }
  | { type: "FOCUS_TOOL"; direction: "next" | "prev" }
  | { type: "SET_DETAILS"; value: boolean }
  | { type: "OPEN_OVERLAY"; overlay: Overlay }
  | { type: "CLOSE_OVERLAY" }
  | { type: "CLEAR" }
  | { type: "EXIT" }
  | { type: "INFO"; level: "info" | "warn" | "error"; text: string }
  | { type: "COMPACT_START"; reason: "auto" | "manual" }
  | {
      type: "COMPACT_END";
      reason: "auto" | "manual";
      summaryTokens: number;
      freedMessages: number;
      snapshotPath: string;
      durationMs: number;
    }
  | { type: "CONTEXT_WARNING"; ratio: number }
  | { type: "HISTORY_CLEARED"; messagesDropped: number };

export function initialState(session: SessionMeta): UiState {
  return {
    session,
    permissionMode: session.permissionMode,
    details: false,
    messages: [],
    focusedToolId: null,
    turn: 0,
    isAssistantStreaming: false,
    isTurnActive: false,
    turnStartedAt: null,
    pendingPolicy: null,
    pendingPlan: null,
    stats: {
      turns: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      toolCalls: 0,
      toolFailures: 0,
    },
    usage: {
      sessionStartedAt: Date.now(),
      lastInputTokens: 0,
      turnHistory: [],
      toolUsage: {},
      turnAnchor: null,
    },
    compaction: null,
    contextWarning: null,
    overlay: null,
    shouldExit: false,
  };
}

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function reducer(state: UiState, action: Action): UiState {
  switch (action.type) {
    case "USER_SENT": {
      const turn = state.turn + 1;
      const msg: UserMsg = { kind: "user", id: nextId("u"), text: action.text, turn };
      return {
        ...state,
        turn,
        isTurnActive: true,
        turnStartedAt: Date.now(),
        messages: [...state.messages, msg],
        usage: {
          ...state.usage,
          turnAnchor: {
            tokensIn: state.stats.tokensIn,
            tokensOut: state.stats.tokensOut,
            costUsd: state.stats.costUsd,
            toolCalls: state.stats.toolCalls,
            toolFailures: state.stats.toolFailures,
          },
        },
      };
    }
    case "ASSIST_DELTA": {
      const last = state.messages[state.messages.length - 1];
      if (last && last.kind === "assistant" && last.streaming) {
        const updated: AssistantMsg = { ...last, text: last.text + action.text };
        return {
          ...state,
          isAssistantStreaming: true,
          messages: [...state.messages.slice(0, -1), updated],
        };
      }
      const msg: AssistantMsg = {
        kind: "assistant",
        id: nextId("a"),
        text: action.text,
        streaming: true,
        turn: state.turn,
      };
      return {
        ...state,
        isAssistantStreaming: true,
        messages: [...state.messages, msg],
      };
    }
    case "ASSIST_END": {
      const last = state.messages[state.messages.length - 1];
      if (last && last.kind === "assistant" && last.streaming) {
        const finalText = last.text.length > 0 ? last.text : action.text;
        const updated: AssistantMsg = { ...last, text: finalText, streaming: false };
        return {
          ...state,
          isAssistantStreaming: false,
          messages: [...state.messages.slice(0, -1), updated],
        };
      }
      const msg: AssistantMsg = {
        kind: "assistant",
        id: nextId("a"),
        text: action.text,
        streaming: false,
        turn: state.turn,
      };
      return {
        ...state,
        isAssistantStreaming: false,
        messages: [...state.messages, msg],
      };
    }
    case "TOOL_CALL": {
      const msg: ToolMsg = {
        kind: "tool",
        id: action.call.id,
        name: action.call.name,
        input: action.call.input,
        status: "running",
        output: "",
        expanded: false,
        turn: state.turn,
      };
      return {
        ...state,
        focusedToolId: action.call.id,
        stats: { ...state.stats, toolCalls: state.stats.toolCalls + 1 },
        messages: [...state.messages, msg],
      };
    }
    case "TOOL_RESULT": {
      let toolName: string | null = null;
      const messages = state.messages.map((m) => {
        if (m.kind === "tool" && m.id === action.id) {
          toolName = m.name;
          return {
            ...m,
            status: action.ok ? ("ok" as const) : ("fail" as const),
            output: action.output,
            ...(action.durationMs !== undefined ? { durationMs: action.durationMs } : {}),
          };
        }
        return m;
      });
      const toolUsage = { ...state.usage.toolUsage };
      if (toolName) {
        const prev = toolUsage[toolName] ?? { count: 0, totalMs: 0, failures: 0 };
        toolUsage[toolName] = {
          count: prev.count + 1,
          totalMs: prev.totalMs + (action.durationMs ?? 0),
          failures: prev.failures + (action.ok ? 0 : 1),
        };
      }
      return {
        ...state,
        messages,
        stats: {
          ...state.stats,
          toolFailures: state.stats.toolFailures + (action.ok ? 0 : 1),
        },
        usage: {
          ...state.usage,
          toolUsage,
        },
      };
    }
    case "SENSOR_RUN": {
      const msg: SensorMsg = {
        kind: "sensor",
        id: nextId("s"),
        name: action.name,
        ok: action.ok,
        message: action.message,
        turn: state.turn,
      };
      return { ...state, messages: [...state.messages, msg] };
    }
    case "USAGE":
      return {
        ...state,
        stats: {
          ...state.stats,
          tokensIn: state.stats.tokensIn + action.inputTokens,
          tokensOut: state.stats.tokensOut + action.outputTokens,
          costUsd: state.stats.costUsd + (action.costUsd ?? 0),
        },
        usage: {
          ...state.usage,
          lastInputTokens: action.inputTokens,
        },
      };
    case "TURN_START":
      return {
        ...state,
        isTurnActive: true,
        turnStartedAt: state.turnStartedAt ?? Date.now(),
      };
    case "TURN_END": {
      if (!state.isTurnActive && !state.isAssistantStreaming) return state;
      const anchor = state.usage.turnAnchor;
      const nextTurns = state.stats.turns + 1;
      const turnHistory = anchor
        ? [
            ...state.usage.turnHistory,
            {
              index: nextTurns,
              durationMs: state.turnStartedAt ? Date.now() - state.turnStartedAt : 0,
              tokensIn: state.stats.tokensIn - anchor.tokensIn,
              tokensOut: state.stats.tokensOut - anchor.tokensOut,
              costUsd: state.stats.costUsd - anchor.costUsd,
              toolCalls: state.stats.toolCalls - anchor.toolCalls,
              toolFailures: state.stats.toolFailures - anchor.toolFailures,
            } satisfies TurnStat,
          ]
        : state.usage.turnHistory;
      return {
        ...state,
        isTurnActive: false,
        isAssistantStreaming: false,
        turnStartedAt: null,
        stats: { ...state.stats, turns: nextTurns },
        usage: { ...state.usage, turnHistory, turnAnchor: null },
      };
    }
    case "POLICY_ASK":
      return { ...state, pendingPolicy: action.request };
    case "POLICY_RESOLVE":
      return { ...state, pendingPolicy: null };
    case "PLAN_ASK":
      return { ...state, pendingPlan: action.request };
    case "PLAN_RESOLVE":
      return { ...state, pendingPlan: null };
    case "SET_PERMISSION_MODE":
      if (state.permissionMode === action.mode) return state;
      return { ...state, permissionMode: action.mode };
    case "TOGGLE_EXPAND": {
      const messages = state.messages.map((m) =>
        m.kind === "tool" && m.id === action.id ? { ...m, expanded: !m.expanded } : m,
      );
      return { ...state, messages };
    }
    case "FOCUS_TOOL": {
      const toolIds: string[] = [];
      for (const m of state.messages) {
        if (m.kind === "tool") toolIds.push(m.id);
      }
      if (toolIds.length === 0) return state;
      const current = state.focusedToolId;
      const idx = current ? toolIds.indexOf(current) : -1;
      let nextIdx: number;
      if (action.direction === "next") {
        nextIdx = idx < 0 ? toolIds.length - 1 : Math.min(toolIds.length - 1, idx + 1);
      } else {
        nextIdx = idx < 0 ? toolIds.length - 1 : Math.max(0, idx - 1);
      }
      const target = toolIds[nextIdx] ?? null;
      return { ...state, focusedToolId: target };
    }
    case "SET_DETAILS":
      return { ...state, details: action.value };
    case "OPEN_OVERLAY":
      return { ...state, overlay: action.overlay };
    case "CLOSE_OVERLAY":
      return { ...state, overlay: null };
    case "CLEAR":
      return {
        ...state,
        messages: [],
        focusedToolId: null,
        turn: 0,
        isAssistantStreaming: false,
        pendingPolicy: null,
        overlay: null,
      };
    case "EXIT":
      return { ...state, shouldExit: true };
    case "INFO": {
      const msg: InfoMsg = {
        kind: "info",
        id: nextId("i"),
        level: action.level,
        text: action.text,
        turn: state.turn,
      };
      return { ...state, messages: [...state.messages, msg] };
    }
    case "COMPACT_START": {
      const info: InfoMsg = {
        kind: "info",
        id: nextId("i"),
        level: "info",
        text:
          action.reason === "manual"
            ? "Compacting conversation…"
            : "Auto-compacting conversation (context nearly full)…",
        turn: state.turn,
      };
      return {
        ...state,
        compaction: { phase: "summarizing", reason: action.reason, startedAt: Date.now() },
        messages: [...state.messages, info],
      };
    }
    case "COMPACT_END": {
      const info: InfoMsg = {
        kind: "info",
        id: nextId("i"),
        level: "info",
        text:
          action.freedMessages > 0
            ? `Compacted ${action.freedMessages} messages · summary ${action.summaryTokens} tokens · snapshot ${action.snapshotPath}`
            : `Compaction finished without summarising (snapshot ${action.snapshotPath})`,
        turn: state.turn,
      };
      return {
        ...state,
        compaction: null,
        contextWarning: null,
        usage: { ...state.usage, lastInputTokens: 0 },
        messages: [...state.messages, info],
      };
    }
    case "CONTEXT_WARNING":
      return {
        ...state,
        contextWarning: { ratio: action.ratio, emittedAt: Date.now() },
      };
    case "HISTORY_CLEARED": {
      const info: InfoMsg = {
        kind: "info",
        id: nextId("i"),
        level: "info",
        text: `Cleared ${action.messagesDropped} messages from runtime history.`,
        turn: state.turn,
      };
      return {
        ...state,
        messages: [...state.messages, info],
        contextWarning: null,
        usage: { ...state.usage, lastInputTokens: 0 },
      };
    }
    default:
      return state;
  }
}
