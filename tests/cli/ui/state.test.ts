import { describe, expect, it } from "vitest";

import { initialState, reducer, type SessionMeta } from "../../../src/cli/ui/state.js";

const SESSION: SessionMeta = {
  mode: "chat",
  adapter: { name: "fake", model: "fake-1" },
  cwd: "/tmp",
  logPath: "/tmp/log.jsonl",
  configPath: null,
  permissionMode: "default",
  withTools: true,
  toolCount: 3,
};

function base() {
  return initialState(SESSION);
}

describe("UI state reducer", () => {
  it("tracks user messages and increments turn counter", () => {
    const s1 = reducer(base(), { type: "USER_SENT", text: "hello" });
    expect(s1.turn).toBe(1);
    expect(s1.isTurnActive).toBe(true);
    expect(s1.messages).toHaveLength(1);
    expect(s1.messages[0]).toMatchObject({ kind: "user", text: "hello", turn: 1 });
  });

  it("streams assistant deltas into a single message", () => {
    const s0 = reducer(base(), { type: "USER_SENT", text: "hi" });
    const s1 = reducer(s0, { type: "ASSIST_DELTA", text: "He" });
    const s2 = reducer(s1, { type: "ASSIST_DELTA", text: "llo" });
    expect(s2.messages).toHaveLength(2);
    const assistant = s2.messages[1];
    expect(assistant && assistant.kind === "assistant" && assistant.text).toBe("Hello");
    expect(assistant && assistant.kind === "assistant" && assistant.streaming).toBe(true);
    expect(s2.isAssistantStreaming).toBe(true);
  });

  it("finalizes the streaming assistant message on ASSIST_END", () => {
    let s = base();
    s = reducer(s, { type: "USER_SENT", text: "hi" });
    s = reducer(s, { type: "ASSIST_DELTA", text: "Hi" });
    s = reducer(s, { type: "ASSIST_END", text: "Hi" });
    const last = s.messages[s.messages.length - 1];
    expect(last && last.kind === "assistant" && last.streaming).toBe(false);
    expect(s.isAssistantStreaming).toBe(false);
  });

  it("transitions tool messages through running → ok / fail", () => {
    let s = reducer(base(), { type: "USER_SENT", text: "go" });
    s = reducer(s, {
      type: "TOOL_CALL",
      call: { id: "t1", name: "read", input: { path: "a.ts" } },
    });
    expect(s.stats.toolCalls).toBe(1);
    expect(s.focusedToolId).toBe("t1");
    const running = s.messages[s.messages.length - 1];
    expect(running && running.kind === "tool" && running.status).toBe("running");

    s = reducer(s, { type: "TOOL_RESULT", id: "t1", ok: false, output: "boom" });
    const done = s.messages[s.messages.length - 1];
    expect(done && done.kind === "tool" && done.status).toBe("fail");
    expect(s.stats.toolFailures).toBe(1);
  });

  it("toggles expansion on a specific tool", () => {
    let s = reducer(base(), {
      type: "TOOL_CALL",
      call: { id: "t1", name: "read", input: {} },
    });
    s = reducer(s, { type: "TOGGLE_EXPAND", id: "t1" });
    const m = s.messages[s.messages.length - 1];
    expect(m && m.kind === "tool" && m.expanded).toBe(true);
    s = reducer(s, { type: "TOGGLE_EXPAND", id: "t1" });
    const m2 = s.messages[s.messages.length - 1];
    expect(m2 && m2.kind === "tool" && m2.expanded).toBe(false);
  });

  it("accumulates usage stats", () => {
    const s = reducer(base(), {
      type: "USAGE",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
    });
    expect(s.stats.tokensIn).toBe(100);
    expect(s.stats.tokensOut).toBe(50);
    expect(s.stats.costUsd).toBeCloseTo(0.001);
    expect(s.usage.lastInputTokens).toBe(100);
  });

  it("aggregates per-tool usage (count, total duration, failures)", () => {
    let s = reducer(base(), { type: "USER_SENT", text: "go" });
    s = reducer(s, { type: "TOOL_CALL", call: { id: "t1", name: "read", input: {} } });
    s = reducer(s, { type: "TOOL_RESULT", id: "t1", ok: true, output: "ok", durationMs: 20 });
    s = reducer(s, { type: "TOOL_CALL", call: { id: "t2", name: "read", input: {} } });
    s = reducer(s, { type: "TOOL_RESULT", id: "t2", ok: false, output: "err", durationMs: 30 });
    s = reducer(s, { type: "TOOL_CALL", call: { id: "t3", name: "grep", input: {} } });
    s = reducer(s, { type: "TOOL_RESULT", id: "t3", ok: true, output: "ok", durationMs: 10 });
    expect(s.usage.toolUsage.read).toEqual({ count: 2, totalMs: 50, failures: 1 });
    expect(s.usage.toolUsage.grep).toEqual({ count: 1, totalMs: 10, failures: 0 });
  });

  it("records a turn snapshot with token/cost/tool deltas on TURN_END", () => {
    let s = reducer(base(), { type: "USER_SENT", text: "hi" });
    s = reducer(s, { type: "TOOL_CALL", call: { id: "t1", name: "read", input: {} } });
    s = reducer(s, { type: "TOOL_RESULT", id: "t1", ok: true, output: "ok", durationMs: 5 });
    s = reducer(s, { type: "USAGE", inputTokens: 200, outputTokens: 40, costUsd: 0.002 });
    s = reducer(s, { type: "ASSIST_END", text: "done" });
    s = reducer(s, { type: "TURN_END" });
    expect(s.usage.turnHistory).toHaveLength(1);
    const [turn] = s.usage.turnHistory;
    expect(turn).toBeDefined();
    if (!turn) throw new Error("unreachable");
    expect(turn.index).toBe(1);
    expect(turn.tokensIn).toBe(200);
    expect(turn.tokensOut).toBe(40);
    expect(turn.costUsd).toBeCloseTo(0.002);
    expect(turn.toolCalls).toBe(1);
    expect(turn.toolFailures).toBe(0);
    expect(turn.durationMs).toBeGreaterThanOrEqual(0);
    expect(s.usage.turnAnchor).toBeNull();
  });

  it("does not count an idle TURN_END as a completed turn", () => {
    const s = reducer(base(), { type: "TURN_END" });
    expect(s.stats.turns).toBe(0);
  });

  it("CLEAR resets messages but keeps session meta", () => {
    let s = reducer(base(), { type: "USER_SENT", text: "hi" });
    s = reducer(s, { type: "CLEAR" });
    expect(s.messages).toHaveLength(0);
    expect(s.session).toEqual(SESSION);
  });

  it("COMPACT_START sets compaction state and appends info message", () => {
    const s = reducer(base(), { type: "COMPACT_START", reason: "auto" });
    expect(s.compaction?.reason).toBe("auto");
    expect(s.compaction?.phase).toBe("summarizing");
    const last = s.messages[s.messages.length - 1];
    expect(last && last.kind === "info" && /[Aa]uto-compact/.test(last.text)).toBe(true);
  });

  it("COMPACT_END clears compaction, resets lastInputTokens, logs summary info", () => {
    let s = reducer(base(), {
      type: "USAGE",
      inputTokens: 190_000,
      outputTokens: 100,
      costUsd: 0,
    });
    expect(s.usage.lastInputTokens).toBe(190_000);
    s = reducer(s, { type: "COMPACT_START", reason: "manual" });
    s = reducer(s, {
      type: "COMPACT_END",
      reason: "manual",
      freedMessages: 10,
      summaryTokens: 500,
      snapshotPath: "/tmp/snap.json",
      durationMs: 50,
    });
    expect(s.compaction).toBeNull();
    expect(s.contextWarning).toBeNull();
    expect(s.usage.lastInputTokens).toBe(0);
    const last = s.messages[s.messages.length - 1];
    expect(last && last.kind === "info" && /Compacted 10/.test(last.text)).toBe(true);
  });

  it("CONTEXT_WARNING records the last warning ratio", () => {
    const s = reducer(base(), { type: "CONTEXT_WARNING", ratio: 0.82 });
    expect(s.contextWarning?.ratio).toBeCloseTo(0.82);
  });

  it("HISTORY_CLEARED resets tokens and logs how many messages were dropped", () => {
    let s = reducer(base(), {
      type: "USAGE",
      inputTokens: 100_000,
      outputTokens: 0,
      costUsd: 0,
    });
    s = reducer(s, { type: "HISTORY_CLEARED", messagesDropped: 12 });
    expect(s.usage.lastInputTokens).toBe(0);
    expect(s.contextWarning).toBeNull();
    const last = s.messages[s.messages.length - 1];
    expect(last && last.kind === "info" && /Cleared 12/.test(last.text)).toBe(true);
  });

  it("POLICY_ASK / POLICY_RESOLVE toggles pendingPolicy", () => {
    let s = reducer(base(), {
      type: "POLICY_ASK",
      request: { id: "p1", tool: "run_command", input: { command: "ls" } },
    });
    expect(s.pendingPolicy?.id).toBe("p1");
    s = reducer(s, { type: "POLICY_RESOLVE" });
    expect(s.pendingPolicy).toBeNull();
  });
});
