import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { HookDispatcher } from "../../src/hooks/dispatcher.js";
import { ControlChannel } from "../../src/runtime/control.js";
import { MemoryEventSink } from "../../src/runtime/events.js";
import { runSession } from "../../src/runtime/session.js";
import type { ModelAdapter, ModelTurnInput } from "../../src/types.js";
import { queuedInput } from "../fixtures/fake-adapter.js";

/**
 * Adapter that reports a configurable inputTokens on each turn. Uses the
 * model name "claude-sonnet-4-6" so we hit the 200k context window entry
 * from `src/runtime/context-window.ts` (90% ≈ 180k).
 */
function scriptedAdapterWithUsage(
  turns: readonly { text: string; inputTokens: number }[],
  model = "claude-sonnet-4-6",
): ModelAdapter {
  let i = 0;
  return {
    name: "anthropic",
    model,
    async *runTurn(_: ModelTurnInput, __: AbortSignal) {
      const t = turns[i] ?? { text: "", inputTokens: 0 };
      i += 1;
      yield { type: "text_delta", text: t.text };
      yield { type: "usage", inputTokens: t.inputTokens, outputTokens: 1 };
      yield { type: "stop", reason: "end_turn" };
    },
  };
}

async function waitForEvent(sink: MemoryEventSink, event: string): Promise<void> {
  const started = Date.now();
  while (!sink.events.some((e) => e.event === event)) {
    if (Date.now() - started > 500) throw new Error(`timed out waiting for ${event}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("runSession + context compaction", () => {
  it("auto-compacts when lastInputTokens cross the compact threshold", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "harness-sc-"));
    try {
      const sink = new MemoryEventSink();
      // Turn 1: low usage. Turn 2: >90% of 200k (critical). Turn 3: model is
      // invoked after compaction to respond to the third user input.
      const adapter = scriptedAdapterWithUsage([
        { text: "t1", inputTokens: 165_000 }, // 82.5% -> warn
        { text: "t2 big", inputTokens: 185_000 }, // 92.5% -> critical -> compact
        { text: "summary block", inputTokens: 100 }, // summariser call
        { text: "t3", inputTokens: 500 },
      ]);
      const summary = await runSession({
        adapter,
        system: "t",
        cwd: tmp,
        sink,
        input: queuedInput(["hi", "again", "more"]),
        contextManagement: { snapshotDir: join(tmp, "snap"), keepLastNTurns: 2 },
      });

      const kinds = sink.events.map((e) => e.event);
      // Warn fires on the way up to compact, then CompactStart/End.
      expect(kinds).toContain("ContextWarning");
      expect(kinds).toContain("CompactStart");
      expect(kinds).toContain("CompactEnd");
      const start = sink.events.find((e) => e.event === "CompactStart");
      expect(start && "reason" in start && start.reason).toBe("auto");
      // A snapshot file must exist with non-empty content.
      const end = sink.events.find((e) => e.event === "CompactEnd") as
        | { event: "CompactEnd"; snapshot_path: string }
        | undefined;
      expect(end).toBeDefined();
      const raw = await readFile(end!.snapshot_path, "utf8");
      expect(raw.length).toBeGreaterThan(0);
      expect(summary.totalInputTokens).toBe(165_000 + 185_000 + 100 + 500);
      expect(summary.totalOutputTokens).toBe(4);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not auto-compact when autoCompact is disabled", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "harness-sc-"));
    try {
      const sink = new MemoryEventSink();
      const adapter = scriptedAdapterWithUsage([
        { text: "t1", inputTokens: 165_000 },
        { text: "t2", inputTokens: 195_000 },
      ]);
      await runSession({
        adapter,
        system: "t",
        cwd: tmp,
        sink,
        input: queuedInput(["a", "b"]),
        contextManagement: { autoCompact: false, snapshotDir: join(tmp, "snap") },
      });
      const kinds = sink.events.map((e) => e.event);
      expect(kinds).not.toContain("CompactStart");
      expect(kinds).toContain("ContextWarning");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("manual compact via ControlChannel runs between turns with user instructions", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "harness-sc-"));
    try {
      const sink = new MemoryEventSink();
      const controls = new ControlChannel();
      const captured: string[] = [];
      const adapter: ModelAdapter = {
        name: "fake",
        model: "fake-model",
        async *runTurn(input: ModelTurnInput) {
          captured.push(input.messages.map((m) => m.content).join("\n"));
          yield { type: "text_delta", text: "ok" };
          yield { type: "usage", inputTokens: 10, outputTokens: 1 };
          yield { type: "stop", reason: "end_turn" };
        },
      };
      // Push the /compact control after the first turn but before the second.
      const inputs: string[] = ["first message that becomes old", "second"];
      let pulled = 0;
      const nextInput = {
        async next() {
          if (pulled === 1) controls.push({ type: "compact", instructions: "focus on X" });
          return inputs[pulled++] ?? null;
        },
      };
      await runSession({
        adapter,
        system: "t",
        cwd: tmp,
        sink,
        input: nextInput,
        controls,
        contextManagement: {
          snapshotDir: join(tmp, "snap"),
          keepLastNTurns: 1,
        },
      });
      const start = sink.events.find((e) => e.event === "CompactStart") as
        | { event: "CompactStart"; reason: string; instructions?: string }
        | undefined;
      expect(start).toBeDefined();
      expect(start!.reason).toBe("manual");
      expect(start!.instructions).toBe("focus on X");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("manual compact wakes the session while it is blocked waiting for input", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "harness-sc-"));
    try {
      const sink = new MemoryEventSink();
      const controls = new ControlChannel();
      const adapter = scriptedAdapterWithUsage([{ text: "first", inputTokens: 10 }], "fake-model");
      let pulled = 0;
      const idle = deferred<void>();
      const releaseIdle = deferred<string | null>();
      const session = runSession({
        adapter,
        system: "t",
        cwd: tmp,
        sink,
        input: {
          async next() {
            if (pulled === 0) {
              pulled += 1;
              return "first";
            }
            idle.resolve();
            return releaseIdle.promise;
          },
        },
        controls,
        contextManagement: { snapshotDir: join(tmp, "snap") },
      });

      await idle;
      controls.push({ type: "compact", instructions: "wake now" });
      try {
        await waitForEvent(sink, "CompactStart");
      } finally {
        releaseIdle.resolve(null);
      }
      await session;
      const start = sink.events.find((e) => e.event === "CompactStart") as
        | { event: "CompactStart"; instructions?: string }
        | undefined;
      expect(start?.instructions).toBe("wake now");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("manual clear via ControlChannel wipes the runtime history and emits HistoryCleared", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "harness-sc-"));
    try {
      const sink = new MemoryEventSink();
      const controls = new ControlChannel();
      const seenMessagesCount: number[] = [];
      const adapter: ModelAdapter = {
        name: "fake",
        model: "fake-model",
        async *runTurn(input: ModelTurnInput) {
          seenMessagesCount.push(input.messages.length);
          yield { type: "text_delta", text: "ok" };
          yield { type: "usage", inputTokens: 5, outputTokens: 1 };
          yield { type: "stop", reason: "end_turn" };
        },
      };
      const inputs = ["first", "second", "third"];
      let pulled = 0;
      // Push the clear while returning the SECOND user input (pulled===1).
      // drainControls runs at the top of each loop iteration BEFORE next() is
      // called, so the control must be queued at or before that point. Queuing
      // it while serving the second input guarantees iteration 3 sees it.
      const nextInput = {
        async next() {
          if (pulled === 1) controls.push({ type: "clear" });
          return inputs[pulled++] ?? null;
        },
      };
      await runSession({
        adapter,
        system: "t",
        cwd: tmp,
        sink,
        input: nextInput,
        controls,
      });
      const cleared = sink.events.find((e) => e.event === "HistoryCleared") as
        | { event: "HistoryCleared"; messages_dropped: number }
        | undefined;
      expect(cleared).toBeDefined();
      expect(cleared!.messages_dropped).toBeGreaterThan(0);
      // After clear, the third turn sees only the new "third" user message.
      expect(seenMessagesCount[seenMessagesCount.length - 1]).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("manual clear wakes the session while it is blocked waiting for input", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "harness-sc-"));
    try {
      const sink = new MemoryEventSink();
      const controls = new ControlChannel();
      const adapter = scriptedAdapterWithUsage([{ text: "first", inputTokens: 10 }], "fake-model");
      let pulled = 0;
      const idle = deferred<void>();
      const releaseIdle = deferred<string | null>();
      const session = runSession({
        adapter,
        system: "t",
        cwd: tmp,
        sink,
        input: {
          async next() {
            if (pulled === 0) {
              pulled += 1;
              return "first";
            }
            idle.resolve();
            return releaseIdle.promise;
          },
        },
        controls,
      });

      await idle;
      controls.push({ type: "clear" });
      try {
        await waitForEvent(sink, "HistoryCleared");
      } finally {
        releaseIdle.resolve(null);
      }
      await session;
      expect(sink.events.some((e) => e.event === "HistoryCleared")).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("calls onCompactEnd when compaction fails", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "harness-sc-"));
    try {
      const sink = new MemoryEventSink();
      const blocker = join(tmp, "not-a-directory");
      await writeFile(blocker, "x", "utf8");
      const onCompactEnd = vi.fn();
      const adapter = scriptedAdapterWithUsage([
        { text: "big", inputTokens: 195_000 },
        { text: "after failure", inputTokens: 10 },
      ]);
      await runSession({
        adapter,
        system: "t",
        cwd: tmp,
        sink,
        input: queuedInput(["a", "b"]),
        contextManagement: { snapshotDir: blocker },
        onCompactEnd,
      });

      expect(onCompactEnd).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "auto", freedMessages: 0, summaryTokens: 0 }),
      );
      expect(sink.events.some((e) => e.event === "CompactEnd")).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("PreCompact hook that blocks cancels the compaction", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "harness-sc-"));
    try {
      const sink = new MemoryEventSink();
      const hooks = new HookDispatcher();
      const handler = vi.fn(async () => ({ block: true, reason: "nope" }));
      hooks.on("PreCompact", handler);

      const adapter = scriptedAdapterWithUsage([
        { text: "big", inputTokens: 195_000 },
        { text: "big2", inputTokens: 195_000 },
      ]);
      await runSession({
        adapter,
        system: "t",
        cwd: tmp,
        sink,
        hooks,
        input: queuedInput(["a", "b"]),
        contextManagement: { snapshotDir: join(tmp, "snap") },
      });

      expect(handler).toHaveBeenCalled();
      const kinds = sink.events.map((e) => e.event);
      expect(kinds).not.toContain("CompactStart");
      expect(kinds).toContain("HookBlocked");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
