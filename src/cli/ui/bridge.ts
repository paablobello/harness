import { createElement } from "react";
import { render, type Instance } from "ink";

import type { AskPrompt } from "../../policy/engine.js";
import type { EventSink } from "../../runtime/events.js";
import { runSession, type RunSummary } from "../../runtime/session.js";
import type { HarnessConfig } from "../../config/harness-config.js";
import type { PolicyEngine } from "../../policy/engine.js";
import type { HookDispatcher } from "../../hooks/dispatcher.js";
import type { Sensor } from "../../sensors/types.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { ModelAdapter, PermissionMode } from "../../types.js";

import { App, type AppCallbacks } from "./App.js";
import { loadHistory } from "./history.js";
import { detectTerminalTheme, loadPreferences } from "./preferences.js";
import type { Action, SessionMeta } from "./state.js";

const EXIT_SIGNAL = "\x00__HARNESS_EXIT__\x00";

export type PolicyAsk = (req: {
  tool: string;
  input: unknown;
  reason?: string;
}) => Promise<boolean>;

export type InkBridgeOptions = {
  readonly adapter: ModelAdapter;
  readonly system: string;
  readonly cwd: string;
  readonly runId: string;
  readonly sink: EventSink;
  readonly logPath: string;
  readonly configPath: string | null;
  readonly permissionMode: PermissionMode;
  readonly tools?: ToolRegistry;
  readonly hooks?: HookDispatcher;
  readonly sensors?: Sensor[];
  readonly harnessConfig?: HarnessConfig;
  /** Factory that returns a PolicyEngine given the ask function (injected by the bridge). */
  readonly policyFactory?: (ask: AskPrompt) => PolicyEngine;
};

export async function runInkApp(opts: InkBridgeOptions): Promise<RunSummary> {
  const toolList = opts.tools?.list();
  const session: SessionMeta = {
    mode: "chat",
    adapter: { name: opts.adapter.name, model: opts.adapter.model },
    cwd: opts.cwd,
    logPath: opts.logPath,
    configPath: opts.configPath,
    permissionMode: opts.permissionMode,
    withTools: Boolean(opts.tools),
    toolCount: toolList?.length ?? 0,
  };

  const prefs = await loadPreferences();
  const history = await loadHistory();

  // A queue of user inputs the runtime will pull from.
  const pendingInputs: string[] = [];
  let waitingResolver: ((value: string | null) => void) | null = null;
  const dispatchRef: { current: ((action: Action) => void) | null } = { current: null };

  function pushUserInput(text: string): void {
    if (text === EXIT_SIGNAL) {
      if (waitingResolver) {
        const r = waitingResolver;
        waitingResolver = null;
        r(null);
      } else {
        pendingInputs.push(EXIT_SIGNAL);
      }
      return;
    }
    // Show the bubble immediately so the user sees their input land; the runtime
    // consumes from the queue on its own schedule.
    dispatchRef.current?.({ type: "USER_SENT", text });
    if (waitingResolver) {
      const r = waitingResolver;
      waitingResolver = null;
      r(text);
    } else {
      pendingInputs.push(text);
    }
  }

  function nextUserInput(): Promise<string | null> {
    // Mark the previous turn as done before blocking on the next input.
    dispatchRef.current?.({ type: "TURN_END" });
    const buffered = pendingInputs.shift();
    if (buffered !== undefined) {
      return Promise.resolve(buffered === EXIT_SIGNAL ? null : buffered);
    }
    return new Promise<string | null>((resolve) => {
      waitingResolver = resolve;
    });
  }

  // Abort controller wired to Esc.
  const abortController = new AbortController();

  let pendingPolicyResolve: ((allow: boolean) => void) | null = null;
  const ask: AskPrompt = (req) =>
    new Promise<boolean>((resolve) => {
      pendingPolicyResolve = resolve;
      const payload: { tool: string; input: unknown; reason?: string; id: string } = {
        id: crypto.randomUUID(),
        tool: req.tool,
        input: req.input,
        ...(req.reason !== undefined ? { reason: req.reason } : {}),
      };
      dispatchRef.current?.({ type: "POLICY_ASK", request: payload });
    });

  const callbacks: AppCallbacks = {
    onUserMessage: pushUserInput,
    onCancelTurn: () => {
      if (!abortController.signal.aborted) abortController.abort();
    },
    onPolicyResolve: (allow) => {
      const r = pendingPolicyResolve;
      pendingPolicyResolve = null;
      r?.(allow);
    },
  };

  const appElement = createElement(App, {
    session,
    initialTheme: prefs.theme ?? detectTerminalTheme(),
    history,
    tools: toolList,
    callbacks,
    register(dispatch) {
      dispatchRef.current = dispatch;
    },
  });

  const instance: Instance = render(appElement, { exitOnCtrlC: false });

  // Give Ink a tick to install the dispatcher before events arrive.
  await new Promise<void>((r) => setImmediate(r));

  try {
    const policy = opts.policyFactory ? opts.policyFactory(ask) : undefined;
    const summary = await runSession({
      adapter: opts.adapter,
      system: opts.system,
      cwd: opts.cwd,
      runId: opts.runId,
      sink: opts.sink,
      signal: abortController.signal,
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(policy ? { policy } : {}),
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
      ...(opts.sensors ? { sensors: opts.sensors } : {}),
      ...(opts.harnessConfig?.maxToolsPerUserTurn !== undefined
        ? { maxToolsPerUserTurn: opts.harnessConfig.maxToolsPerUserTurn }
        : {}),
      ...(opts.harnessConfig?.maxSubagentDepth !== undefined
        ? { maxSubagentDepth: opts.harnessConfig.maxSubagentDepth }
        : {}),
      input: {
        next: nextUserInput,
      },
      onAssistantDelta: (text) => dispatchRef.current?.({ type: "ASSIST_DELTA", text }),
      onAssistantMessage: (text) => {
        dispatchRef.current?.({ type: "ASSIST_END", text });
      },
      onToolCall: (call) => dispatchRef.current?.({ type: "TOOL_CALL", call }),
      onToolResult: (res) =>
        dispatchRef.current?.({
          type: "TOOL_RESULT",
          id: res.id,
          ok: res.ok,
          output: res.output,
          ...(res.durationMs !== undefined ? { durationMs: res.durationMs } : {}),
        }),
      onSensorRun: (res) =>
        dispatchRef.current?.({
          type: "SENSOR_RUN",
          name: res.name,
          ok: res.ok,
          message: res.message,
        }),
      onUsage: (u) =>
        dispatchRef.current?.({
          type: "USAGE",
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          ...(u.costUsd !== undefined ? { costUsd: u.costUsd } : {}),
        }),
    });
    return summary;
  } finally {
    instance.unmount();
    await instance.waitUntilExit().catch(() => undefined);
  }
}
