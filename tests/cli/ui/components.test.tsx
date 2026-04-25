import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { App, type AppCallbacks } from "../../../src/cli/ui/App.js";
import { ActivityLine } from "../../../src/cli/ui/components/ActivityLine.js";
import { AssistantMessage } from "../../../src/cli/ui/components/AssistantMessage.js";
import { Overlay } from "../../../src/cli/ui/components/Overlay.js";
import { PlanApprovalDialog } from "../../../src/cli/ui/components/PlanApprovalDialog.js";
import { PolicyDialog } from "../../../src/cli/ui/components/PolicyDialog.js";
import { StatusBar } from "../../../src/cli/ui/components/StatusBar.js";
import { SuggestionsPanel } from "../../../src/cli/ui/components/SuggestionsPanel.js";
import { ToolBlock } from "../../../src/cli/ui/components/ToolBlock.js";
import { filterCommands } from "../../../src/cli/ui/commands.js";
import {
  initialState,
  reducer,
  type Action,
  type SessionMeta,
  type UiState,
} from "../../../src/cli/ui/state.js";

describe("ToolBlock", () => {
  it("renders a running tool with spinner and input summary", () => {
    const { lastFrame } = render(
      <ToolBlock
        msg={{
          kind: "tool",
          id: "t1",
          name: "read",
          input: { path: "src/index.ts" },
          status: "running",
          output: "",
          expanded: false,
          turn: 1,
        }}
        focused={false}
        details={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("read");
    expect(frame).toContain("src/index.ts");
  });

  it("renders a successful tool with preview when not expanded", () => {
    const longOutput = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const { lastFrame } = render(
      <ToolBlock
        msg={{
          kind: "tool",
          id: "t1",
          name: "run_command",
          input: { command: "ls" },
          status: "ok",
          output: longOutput,
          expanded: false,
          turn: 1,
          durationMs: 120,
        }}
        focused={true}
        details={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("run_command");
    expect(frame).toContain("line 1");
    expect(frame).toContain("Ctrl+O");
  });

  it("renders the failure output in red when the tool failed", () => {
    const { lastFrame } = render(
      <ToolBlock
        msg={{
          kind: "tool",
          id: "t1",
          name: "read",
          input: { path: "x" },
          status: "fail",
          output: "Error: boom",
          expanded: false,
          turn: 1,
        }}
        focused={false}
        details={false}
      />,
    );
    expect(lastFrame() ?? "").toContain("Error: boom");
  });
});

describe("SuggestionsPanel", () => {
  it("lists the matching slash commands with an active marker", () => {
    const suggestions = filterCommands("/t");
    const { lastFrame } = render(<SuggestionsPanel suggestions={suggestions} activeIndex={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/tools");
    expect(frame).toContain("➤");
  });

  it("shows the reverse-search mode when historyMode is true", () => {
    const { lastFrame } = render(
      <SuggestionsPanel
        suggestions={[]}
        activeIndex={0}
        historyMode
        historyMatches={["hello world", "hello friends"]}
      />,
    );
    expect(lastFrame() ?? "").toContain("reverse-i-search");
  });
});

describe("AssistantMessage", () => {
  it("shows a 'thinking' hint with the adapter when streaming starts empty", () => {
    const { lastFrame } = render(
      <AssistantMessage
        msg={{
          kind: "assistant",
          id: "a1",
          text: "",
          streaming: true,
          turn: 1,
        }}
        adapter="fake"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("fake");
    expect(frame).toContain("thinking");
  });

  it("streams text inline with the assistant bullet", () => {
    const { lastFrame } = render(
      <AssistantMessage
        msg={{
          kind: "assistant",
          id: "a1",
          text: "Thinking…",
          streaming: true,
          turn: 1,
        }}
        adapter="fake"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("●");
    expect(frame).toContain("Thinking");
  });

  it("renders headings and inline code once streaming is done", () => {
    const { lastFrame } = render(
      <AssistantMessage
        msg={{
          kind: "assistant",
          id: "a1",
          text: "# Title\n\nUse `foo()` carefully.",
          streaming: false,
          turn: 1,
        }}
        adapter="fake"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Title");
    expect(frame).toContain("foo()");
  });
});

describe("Overlay — usage", () => {
  const session: SessionMeta = {
    mode: "chat",
    adapter: { name: "anthropic", model: "claude-sonnet-4-5" },
    cwd: "/tmp",
    logPath: "/tmp/log.jsonl",
    configPath: null,
    permissionMode: "default",
    withTools: true,
    toolCount: 3,
  };

  function stateWith(partial: Partial<UiState>): UiState {
    const s = initialState(session);
    return { ...s, ...partial };
  }

  it("renders session totals, context bar and tool table", () => {
    const s = stateWith({
      stats: {
        turns: 3,
        tokensIn: 1234,
        tokensOut: 567,
        costUsd: 0.0423,
        toolCalls: 7,
        toolFailures: 1,
      },
      usage: {
        sessionStartedAt: Date.now() - 65_000,
        lastInputTokens: 50_000,
        turnHistory: [
          {
            index: 1,
            durationMs: 4_200,
            tokensIn: 500,
            tokensOut: 120,
            costUsd: 0.012,
            toolCalls: 2,
            toolFailures: 0,
          },
        ],
        toolUsage: {
          read_file: { count: 4, totalMs: 60, failures: 0 },
          run_command: { count: 3, totalMs: 1_800, failures: 1 },
        },
        turnAnchor: null,
      },
    });
    const { lastFrame } = render(<Overlay overlay={{ type: "usage" }} state={s} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("usage");
    expect(frame).toContain("duration");
    expect(frame).toContain("Context window");
    expect(frame).toContain("25.0%");
    expect(frame).toContain("read_file");
    expect(frame).toContain("run_command");
    expect(frame).toContain("Recent turns");
  });

  it("falls back to an 'unknown' line when the model has no context window entry", () => {
    const s = stateWith({
      session: { ...session, adapter: { name: "fake", model: "mystery-99" } },
      usage: {
        sessionStartedAt: Date.now(),
        lastInputTokens: 42,
        turnHistory: [],
        toolUsage: {},
        turnAnchor: null,
      },
    });
    const { lastFrame } = render(<Overlay overlay={{ type: "usage" }} state={s} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Unknown");
    expect(frame).toContain("mystery-99");
  });

  it("renders cost as 'n/a' instead of '$0' when the model is not in the pricing table", () => {
    const s = stateWith({
      session: { ...session, adapter: { name: "fake", model: "gpt-5.4" } },
      stats: {
        turns: 2,
        tokensIn: 10_000,
        tokensOut: 500,
        costUsd: 0,
        toolCalls: 0,
        toolFailures: 0,
      },
    });
    const { lastFrame } = render(<Overlay overlay={{ type: "usage" }} state={s} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("n/a");
    expect(frame).not.toContain("$0.00");
  });

  it("colours the 'failed' tool count in the session section when there are failures", () => {
    const s = stateWith({
      stats: {
        turns: 1,
        tokensIn: 10,
        tokensOut: 5,
        costUsd: 0,
        toolCalls: 5,
        toolFailures: 2,
      },
    });
    const { lastFrame } = render(<Overlay overlay={{ type: "usage" }} state={s} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("5 calls");
    expect(frame).toContain("2 failed");
  });
});

describe("StatusBar", () => {
  const session: SessionMeta = {
    mode: "chat",
    adapter: { name: "openai", model: "gpt-5.4" },
    cwd: "/tmp",
    logPath: "/tmp/log.jsonl",
    configPath: null,
    permissionMode: "default",
    withTools: true,
    toolCount: 7,
  };

  function state(partial: Partial<UiState>): UiState {
    return { ...initialState(session), ...partial };
  }

  it("shows 'cost n/a' when the model is not tabulated", () => {
    const s = state({
      stats: { turns: 1, tokensIn: 100, tokensOut: 50, costUsd: 0, toolCalls: 0, toolFailures: 0 },
    });
    const { lastFrame } = render(<StatusBar state={s} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("cost n/a");
    expect(frame).not.toContain("$0");
  });

  it("splits tool count and failure count so failures can be colored", () => {
    const s = state({
      stats: {
        turns: 1,
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0,
        toolCalls: 17,
        toolFailures: 1,
      },
    });
    const { lastFrame } = render(<StatusBar state={s} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("17 tools");
    expect(frame).toContain("1 failed");
    expect(frame).not.toMatch(/17\/1 fail/);
  });

  it("omits the 'failed' segment entirely when there are no failures", () => {
    const s = state({
      stats: {
        turns: 1,
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0,
        toolCalls: 4,
        toolFailures: 0,
      },
    });
    const { lastFrame } = render(<StatusBar state={s} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("4 tools");
    expect(frame).not.toContain("failed");
  });
});

describe("StatusBar — context indicator", () => {
  const session: SessionMeta = {
    mode: "chat",
    adapter: { name: "anthropic", model: "claude-sonnet-4-5" },
    cwd: "/tmp",
    logPath: "/tmp/log.jsonl",
    configPath: null,
    permissionMode: "default",
    withTools: true,
    toolCount: 0,
  };
  function state(partial: Partial<UiState>): UiState {
    return { ...initialState(session), ...partial };
  }

  it("shows the ctx% indicator when input tokens are known", () => {
    const s = state({
      usage: {
        sessionStartedAt: Date.now(),
        lastInputTokens: 50_000,
        turnHistory: [],
        toolUsage: {},
        turnAnchor: null,
      },
    });
    const { lastFrame } = render(<StatusBar state={s} />);
    expect(lastFrame() ?? "").toMatch(/ctx 25%/);
  });

  it("renders a 'compacting…' badge while a compaction is in flight", () => {
    const s = state({
      compaction: { phase: "summarizing", reason: "auto", startedAt: Date.now() },
    });
    const { lastFrame } = render(<StatusBar state={s} />);
    expect(lastFrame() ?? "").toContain("compacting");
  });

  it("omits the ctx% indicator for models without a known context window", () => {
    const unknown: SessionMeta = { ...session, adapter: { name: "fake", model: "unknown-x" } };
    const s = { ...initialState(unknown) };
    const { lastFrame } = render(<StatusBar state={s} />);
    expect(lastFrame() ?? "").not.toMatch(/ctx \d+%/);
  });
});

describe("Overlay — context", () => {
  const session: SessionMeta = {
    mode: "chat",
    adapter: { name: "anthropic", model: "claude-sonnet-4-5" },
    cwd: "/tmp",
    logPath: "/tmp/log.jsonl",
    configPath: null,
    permissionMode: "default",
    withTools: true,
    toolCount: 0,
  };

  it("renders a breakdown with system/tools, conversation and free buckets", () => {
    const s: UiState = {
      ...initialState(session),
      usage: {
        sessionStartedAt: Date.now(),
        lastInputTokens: 60_000,
        turnHistory: [
          {
            index: 1,
            durationMs: 100,
            tokensIn: 15_000,
            tokensOut: 10,
            costUsd: 0,
            toolCalls: 0,
            toolFailures: 0,
          },
        ],
        toolUsage: {},
        turnAnchor: null,
      },
    };
    const { lastFrame } = render(<Overlay overlay={{ type: "context" }} state={s} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("context");
    expect(frame).toContain("system + tools");
    expect(frame).toContain("conversation");
    expect(frame).toContain("free");
    expect(frame).toMatch(/30\.0%/);
    expect(frame).toContain("Auto-compact at");
  });

  it("shows a helpful message when the model has no known context window", () => {
    const unknown: SessionMeta = { ...session, adapter: { name: "fake", model: "unknown-x" } };
    const s: UiState = {
      ...initialState(unknown),
      usage: {
        sessionStartedAt: Date.now(),
        lastInputTokens: 100,
        turnHistory: [],
        toolUsage: {},
        turnAnchor: null,
      },
    };
    const { lastFrame } = render(<Overlay overlay={{ type: "context" }} state={s} />);
    expect(lastFrame() ?? "").toContain("Context window size is unknown");
  });
});

describe("ActivityLine", () => {
  const session: SessionMeta = {
    mode: "chat",
    adapter: { name: "fake", model: "fake-1" },
    cwd: "/tmp",
    logPath: "/tmp/log.jsonl",
    configPath: null,
    permissionMode: "default",
    withTools: false,
    toolCount: 0,
  };

  it("renders the compaction phase and omits the 'esc to cancel' hint while compacting", () => {
    const s: UiState = {
      ...initialState(session),
      compaction: { phase: "summarizing", reason: "manual", startedAt: Date.now() },
    };
    const { lastFrame } = render(<ActivityLine state={s} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Compacting context");
    expect(frame).toContain("manually");
    expect(frame).toContain("summarizing");
    expect(frame).not.toContain("esc to cancel");
  });

  it("renders nothing when idle", () => {
    const { lastFrame } = render(<ActivityLine state={initialState(session)} />);
    expect(lastFrame() ?? "").toBe("");
  });
});

describe("StatusBar — plan mode", () => {
  const session: SessionMeta = {
    mode: "chat",
    adapter: { name: "openai", model: "gpt-5.4" },
    cwd: "/tmp",
    logPath: "/tmp/log.jsonl",
    configPath: null,
    permissionMode: "default",
    withTools: true,
    toolCount: 0,
  };

  it("paints the mode segment as '⏸ plan' when permissionMode is plan", () => {
    const base = initialState(session);
    const s: UiState = { ...base, permissionMode: "plan" };
    const { lastFrame } = render(<StatusBar state={s} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("plan");
    expect(frame).toContain("⏸");
  });

  it("shows the plain mode name when not in plan", () => {
    const s = initialState(session);
    const { lastFrame } = render(<StatusBar state={s} />);
    expect(lastFrame() ?? "").toContain("default");
  });
});

describe("UiState reducer — plan mode actions", () => {
  const session: SessionMeta = {
    mode: "chat",
    adapter: { name: "fake", model: "fake-1" },
    cwd: "/tmp",
    logPath: "/tmp/log.jsonl",
    configPath: null,
    permissionMode: "default",
    withTools: false,
    toolCount: 0,
  };

  it("SET_PERMISSION_MODE toggles between default and plan", () => {
    let state = initialState(session);
    expect(state.permissionMode).toBe("default");
    state = reducer(state, { type: "SET_PERMISSION_MODE", mode: "plan" });
    expect(state.permissionMode).toBe("plan");
    state = reducer(state, { type: "SET_PERMISSION_MODE", mode: "default" });
    expect(state.permissionMode).toBe("default");
  });

  it("SET_PERMISSION_MODE returns same reference when already in target mode", () => {
    const state = initialState(session);
    const next = reducer(state, { type: "SET_PERMISSION_MODE", mode: "default" });
    expect(next).toBe(state);
  });

  it("PLAN_ASK stores the pending plan and PLAN_RESOLVE clears it", () => {
    let state = initialState(session);
    state = reducer(state, {
      type: "PLAN_ASK",
      request: { id: "p1", plan: "# Plan\n\nStep 1" },
    });
    expect(state.pendingPlan).toMatchObject({ id: "p1" });
    state = reducer(state, { type: "PLAN_RESOLVE" });
    expect(state.pendingPlan).toBeNull();
  });
});

describe("PlanApprovalDialog", () => {
  it("renders the plan body inside the approval chrome with step/word meta", () => {
    const { lastFrame } = render(
      <PlanApprovalDialog
        request={{
          id: "p1",
          plan: "# Refactor Auth\n\n1. Extract helpers\n2. Update callers",
        }}
        onResolve={() => undefined}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("plan ready for approval");
    expect(frame).toContain("⏸ plan mode");
    expect(frame).toContain("2 steps");
    expect(frame).toContain("Refactor Auth");
    expect(frame).toContain("approve");
    expect(frame).toContain("reject");
    expect(frame).toContain("Esc cancel");
  });

  it("surfaces a file-ref count when the plan mentions paths", () => {
    const { lastFrame } = render(
      <PlanApprovalDialog
        request={{
          id: "p2",
          plan: "# Plan\n\n1. Edit `src/a.ts` and `src/b.tsx`\n2. Update tests/a.test.ts\n3. Ship",
        }}
        onResolve={() => undefined}
      />,
    );
    expect(lastFrame() ?? "").toContain("3 files");
  });

  it("collapses long plans with a 'N more lines' indicator", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const { lastFrame } = render(
      <PlanApprovalDialog
        request={{ id: "p3", plan: `# Big\n\n${body}` }}
        onResolve={() => undefined}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line 1");
    expect(frame).toMatch(/more lines hidden/);
    expect(frame).not.toContain("line 40");
  });

  it("expands the plan when the user presses 'v' and toggles back on a second press", async () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const { stdin, lastFrame } = render(
      <PlanApprovalDialog
        request={{ id: "p5", plan: `# Big\n\n${body}` }}
        onResolve={() => undefined}
      />,
    );
    // Initially collapsed.
    expect(lastFrame() ?? "").not.toContain("line 40");

    stdin.write("v");
    await new Promise((r) => setTimeout(r, 20));
    const expanded = lastFrame() ?? "";
    expect(expanded).toContain("line 40");
    expect(expanded).toContain("full view");
    expect(expanded).toContain("collapse");

    stdin.write("v");
    await new Promise((r) => setTimeout(r, 20));
    const collapsed = lastFrame() ?? "";
    expect(collapsed).not.toContain("line 40");
    expect(collapsed).toContain("expand");
  });

  it("exposes an 'edit in $EDITOR' hotkey on the review rail", () => {
    const { lastFrame } = render(
      <PlanApprovalDialog
        request={{ id: "p6", plan: "# Plan\n\n1. Step one\n2. Step two" }}
        onResolve={() => undefined}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("edit in $EDITOR");
  });

  it("switches to the framed feedback stage when the user presses 'r'", async () => {
    const { stdin, lastFrame } = render(
      <PlanApprovalDialog
        request={{ id: "p4", plan: "# Plan Title\n\n1. Step" }}
        onResolve={() => undefined}
      />,
    );
    stdin.write("r");
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("reject plan");
    expect(frame).toContain("feedback");
    expect(frame).toContain("Plan Title");
    expect(frame).toContain("submit");
    expect(frame).toContain("back to review");
  });

  it("resolves approved:true when user presses 'a'", async () => {
    let decision: { approved: boolean; feedback?: string } | null = null;
    const { stdin } = render(
      <PlanApprovalDialog
        request={{ id: "p1", plan: "# Plan\n\nDo the thing please" }}
        onResolve={(d) => {
          decision = d;
        }}
      />,
    );
    stdin.write("a");
    await new Promise((r) => setTimeout(r, 20));
    expect(decision).toEqual({ approved: true });
  });

  it("collects feedback when the user rejects the plan", async () => {
    let decision: { approved: boolean; feedback?: string } | null = null;
    const { stdin } = render(
      <PlanApprovalDialog
        request={{ id: "p1", plan: "# Plan\n\nSome plan content here" }}
        onResolve={(d) => {
          decision = d;
        }}
      />,
    );
    stdin.write("r");
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("missing tests");
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 20));
    expect(decision).toMatchObject({ approved: false, feedback: "missing tests" });
  });
});

describe("App — plan mode toggle", () => {
  const session: SessionMeta = {
    mode: "chat",
    adapter: { name: "fake", model: "fake-1" },
    cwd: "/tmp",
    logPath: "/tmp/log.jsonl",
    configPath: null,
    permissionMode: "default",
    withTools: true,
    toolCount: 8,
  };

  it("requests a runtime mode change without rendering an optimistic duplicate message", async () => {
    let requestedMode: string | null = null;
    const { stdin, lastFrame } = render(
      <App
        session={session}
        history={[]}
        callbacks={callbacks({
          onSetMode: (mode) => {
            requestedMode = mode;
          },
        })}
        register={() => undefined}
      />,
    );

    stdin.write("\u001B[Z");
    await tick();

    expect(requestedMode).toBe("plan");
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("plan mode on — read-only");
    expect(frame).toContain("default");
  });

  it("does not request a mode change while a turn is active", async () => {
    let requestedMode: string | null = null;
    const registered: { dispatch?: (action: Action) => void } = {};
    const { stdin } = render(
      <App
        session={session}
        history={[]}
        callbacks={callbacks({
          onSetMode: (mode) => {
            requestedMode = mode;
          },
        })}
        register={(d) => {
          registered.dispatch = d;
        }}
      />,
    );

    if (!registered.dispatch) throw new Error("App did not register dispatch");
    registered.dispatch({ type: "USER_SENT", text: "work" });
    await tick();
    stdin.write("\u001B[Z");
    await tick();

    expect(requestedMode).toBeNull();
  });
});

describe("PolicyDialog", () => {
  it("renders the pending policy request with allow/deny hints", () => {
    const { lastFrame } = render(
      <PolicyDialog
        request={{
          id: "p1",
          tool: "run_command",
          input: { command: "rm -rf /tmp/x" },
          reason: "write outside sandbox",
        }}
        onResolve={() => undefined}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("run_command");
    expect(frame).toContain("rm -rf /tmp/x");
    expect(frame).toContain("allow");
    expect(frame).toContain("deny");
  });

  it("renders edit_file approvals as a diff-first dialog", () => {
    const { lastFrame } = render(
      <PolicyDialog
        request={{
          id: "p2",
          tool: "edit_file",
          input: { path: "src/a.ts", old_str: "old()", new_str: "new()" },
        }}
        onResolve={() => undefined}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("edit_file");
    expect(frame).toContain("src/a.ts");
    expect(frame).toContain("-old()");
    expect(frame).toContain("+new()");
  });

  it("renders apply_patch unified_diff input in the approval dialog", () => {
    const { lastFrame } = render(
      <PolicyDialog
        request={{
          id: "p3",
          tool: "apply_patch",
          input: { path: "src/a.ts", unified_diff: "@@\n-old\n+new\n" },
        }}
        onResolve={() => undefined}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("apply_patch");
    expect(frame).toContain("src/a.ts");
    expect(frame).toContain("-old");
    expect(frame).toContain("+new");
  });
});

function callbacks(overrides: Partial<AppCallbacks> = {}): AppCallbacks {
  return {
    onUserMessage: () => undefined,
    onCancelTurn: () => undefined,
    onPolicyResolve: () => undefined,
    onPlanResolve: () => undefined,
    ...overrides,
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
