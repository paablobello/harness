import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compactMessages, maskOldToolResults, splitTail } from "../../src/runtime/compactor.js";
import type { ConversationMessage, ModelAdapter } from "../../src/types.js";
import { createScriptedAdapter } from "../fixtures/fake-adapter.js";

describe("maskOldToolResults", () => {
  it("keeps the last N tool outputs verbatim and replaces older ones with a placeholder", () => {
    const input: ConversationMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read", input: {} }] },
      { role: "tool", toolCallId: "1", content: "old output 1" },
      { role: "assistant", content: "", toolCalls: [{ id: "2", name: "read", input: {} }] },
      { role: "tool", toolCallId: "2", content: "old output 2" },
      { role: "assistant", content: "", toolCalls: [{ id: "3", name: "read", input: {} }] },
      { role: "tool", toolCallId: "3", content: "kept output" },
    ];

    const out = maskOldToolResults(input, 1, "/tmp/snap.jsonl");
    // First two tool results masked, third one kept as-is.
    expect(out[2]?.role).toBe("tool");
    expect(out[2] && "content" in out[2] && out[2].content).toMatch(/^\[masked: read output/);
    expect(out[2] && "content" in out[2] && out[2].content).toContain("/tmp/snap.jsonl");
    expect(out[4]?.role).toBe("tool");
    expect(out[4] && "content" in out[4] && out[4].content).toMatch(/^\[masked: read output/);
    expect(out[6]?.role).toBe("tool");
    expect(out[6] && "content" in out[6] && out[6].content).toBe("kept output");
  });

  it("does not touch tool calls (assistant messages) — only tool results", () => {
    const input: ConversationMessage[] = [
      {
        role: "assistant",
        content: "I'll read a file",
        toolCalls: [{ id: "1", name: "read", input: { path: "x" } }],
      },
      { role: "tool", toolCallId: "1", content: "big output" },
      {
        role: "assistant",
        content: "I'll read another",
        toolCalls: [{ id: "2", name: "read", input: {} }],
      },
      { role: "tool", toolCallId: "2", content: "kept" },
    ];
    const out = maskOldToolResults(input, 1, "/tmp/s.jsonl");
    expect(out[0]).toEqual(input[0]);
    expect(out[2]).toEqual(input[2]);
  });

  it("is a no-op when the number of tool results is within the keep window", () => {
    const input: ConversationMessage[] = [
      { role: "tool", toolCallId: "1", content: "a" },
      { role: "tool", toolCallId: "2", content: "b" },
    ];
    expect(maskOldToolResults(input, 6, "/tmp/s")).toEqual(input);
  });
});

describe("splitTail", () => {
  it("keeps trailing messages verbatim starting at the nearest user boundary", () => {
    const msgs: ConversationMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "second" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read", input: {} }] },
      { role: "tool", toolCallId: "1", content: "out" },
      { role: "assistant", content: "done" },
    ];
    const { head, tail } = splitTail(msgs, 3);
    // Tail must start at a "user" role message.
    expect(tail[0]?.role).toBe("user");
    expect(head.length + tail.length).toBe(msgs.length);
  });

  it("walks backward to keep a long tool-heavy turn as tail", () => {
    const msgs: ConversationMessage[] = [
      { role: "user", content: "old request" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "current request" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read", input: {} }] },
      { role: "tool", toolCallId: "1", content: "read output" },
      { role: "assistant", content: "", toolCalls: [{ id: "2", name: "grep", input: {} }] },
      { role: "tool", toolCallId: "2", content: "grep output" },
      { role: "assistant", content: "still current" },
    ];
    const { head, tail } = splitTail(msgs, 3);
    expect(head.map((m) => m.content)).toEqual(["old request", "old answer"]);
    expect(tail[0]).toMatchObject({ role: "user", content: "current request" });
    expect(tail).toHaveLength(6);
  });

  it("keeps short conversations as tail when they fit inside the keep window", () => {
    const msgs: ConversationMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const { head, tail } = splitTail(msgs, 6);
    expect(head).toHaveLength(0);
    expect(tail).toEqual(msgs);
  });

  it("returns everything as head when keepLastN is 0", () => {
    const msgs: ConversationMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const { head, tail } = splitTail(msgs, 0);
    expect(head).toHaveLength(2);
    expect(tail).toHaveLength(0);
  });
});

describe("compactMessages", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "harness-compact-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes the original messages to the snapshot file before editing", async () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "what is 2+2?" },
      { role: "assistant", content: "four" },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "np" },
    ];
    const adapter = createScriptedAdapter([
      [
        { type: "text_delta", text: "summary of 2+2" },
        { type: "usage", inputTokens: 20, outputTokens: 5 },
        { type: "stop", reason: "end_turn" },
      ],
    ]);

    const snapshotPath = join(tmp, "0001.jsonl");
    await compactMessages(
      messages,
      {
        reason: "manual",
        trigger: { tokens: 10, threshold: 0.9, contextWindow: 100 },
        snapshotPath,
      },
      { adapter, keepLastNTurns: 1, keepLastNToolOutputs: 6 },
      new AbortController().signal,
    );

    const raw = await readFile(snapshotPath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(messages.length);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual(messages[0]);
  });

  it("rebuilds messages as [system-reminder, ...tail] and collapses the head into the reminder", async () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "q3" },
      { role: "assistant", content: "a3" },
    ];
    const adapter = createScriptedAdapter([
      [
        { type: "text_delta", text: "## FILES TOUCHED\n- none\n" },
        { type: "usage", inputTokens: 30, outputTokens: 10 },
        { type: "stop", reason: "end_turn" },
      ],
    ]);

    const { messages: next, result } = await compactMessages(
      messages,
      {
        reason: "auto",
        trigger: { tokens: 90, threshold: 0.9, contextWindow: 100 },
        snapshotPath: join(tmp, "0001.jsonl"),
      },
      { adapter, keepLastNTurns: 2, keepLastNToolOutputs: 6 },
      new AbortController().signal,
    );

    expect(next[0]?.role).toBe("user");
    expect(next[0] && "content" in next[0] && next[0].content).toContain("<system-reminder>");
    expect(next[0] && "content" in next[0] && next[0].content).toContain("FILES TOUCHED");
    // Tail preserved verbatim.
    expect(next.slice(1).some((m) => m.role === "user" && m.content === "q3")).toBe(true);
    expect(result.freedMessages).toBeGreaterThan(0);
    expect(result.summary).toContain("FILES TOUCHED");
  });

  it("passes user-provided instructions to the summariser", async () => {
    let captured = "";
    const adapter: ModelAdapter = {
      name: "fake",
      model: "fake-model",
      async *runTurn(input) {
        captured = input.messages.map((m) => m.content).join("\n");
        yield { type: "text_delta", text: "focused summary" };
        yield { type: "usage", inputTokens: 1, outputTokens: 1 };
        yield { type: "stop", reason: "end_turn" };
      },
    };

    const messages: ConversationMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "middle q" },
      { role: "assistant", content: "middle a" },
      { role: "user", content: "bye" },
      { role: "assistant", content: "see ya" },
    ];

    await compactMessages(
      messages,
      {
        reason: "manual",
        instructions: "focus on the greeting",
        trigger: { tokens: 10, threshold: 0.9, contextWindow: 100 },
        snapshotPath: join(tmp, "0001.jsonl"),
      },
      { adapter, keepLastNTurns: 2, keepLastNToolOutputs: 6 },
      new AbortController().signal,
    );

    expect(captured).toContain("focus on the greeting");
    expect(captured).toContain("hello");
  });
});
