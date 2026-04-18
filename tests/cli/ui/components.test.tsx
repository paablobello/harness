import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { ActivityLine } from "../../../src/cli/ui/components/ActivityLine.js";
import { AssistantMessage } from "../../../src/cli/ui/components/AssistantMessage.js";
import { Overlay } from "../../../src/cli/ui/components/Overlay.js";
import { PolicyDialog } from "../../../src/cli/ui/components/PolicyDialog.js";
import { StatusBar } from "../../../src/cli/ui/components/StatusBar.js";
import { SuggestionsPanel } from "../../../src/cli/ui/components/SuggestionsPanel.js";
import { ToolBlock } from "../../../src/cli/ui/components/ToolBlock.js";
import { filterCommands } from "../../../src/cli/ui/commands.js";
import { initialState, type SessionMeta, type UiState } from "../../../src/cli/ui/state.js";

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
