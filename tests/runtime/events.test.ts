import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileEventSink } from "../../src/runtime/events.js";

describe("FileEventSink", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "harness-events-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates nested dirs and writes one JSON per line", async () => {
    const path = join(tmp, "runs", "run-1", "events.jsonl");
    const sink = await FileEventSink.open(path);

    sink.write({
      timestamp: "2026-04-16T00:00:00Z",
      session_id: "s1",
      run_id: "r1",
      event: "SessionStart",
      model: "fake",
      adapter: "fake",
      cwd: "/tmp",
    });
    sink.write({
      timestamp: "2026-04-16T00:00:01Z",
      session_id: "s1",
      run_id: "r1",
      event: "SessionEnd",
      end_reason: "user_exit",
    });
    await sink.close();

    const content = await readFile(path, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).event).toBe("SessionStart");
    expect(JSON.parse(lines[1]!).event).toBe("SessionEnd");
  });

  it("serialises context-management events (warn / compact / cleared)", async () => {
    const path = join(tmp, "runs", "run-2", "events.jsonl");
    const sink = await FileEventSink.open(path);
    const common = {
      timestamp: "2026-04-16T00:00:00Z",
      session_id: "s1",
      run_id: "r1",
    } as const;
    sink.write({
      ...common,
      event: "ContextWarning",
      input_tokens: 170_000,
      context_window: 200_000,
      ratio: 0.85,
    });
    sink.write({
      ...common,
      event: "CompactStart",
      reason: "auto",
      input_tokens: 185_000,
      threshold: 180_000,
    });
    sink.write({
      ...common,
      event: "CompactEnd",
      reason: "auto",
      freed_messages: 12,
      summary_tokens: 800,
      snapshot_path: "/tmp/snap.json",
      duration_ms: 450,
      error: "boom",
    });
    sink.write({ ...common, event: "HistoryCleared", messages_dropped: 4 });
    await sink.close();

    const lines = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((e) => e.event)).toEqual([
      "ContextWarning",
      "CompactStart",
      "CompactEnd",
      "HistoryCleared",
    ]);
    expect(lines[0].ratio).toBeCloseTo(0.85);
    expect(lines[1].reason).toBe("auto");
    expect(lines[1].threshold).toBe(180_000);
    expect(lines[2].freed_messages).toBe(12);
    expect(lines[2].error).toBe("boom");
    expect(lines[3].messages_dropped).toBe(4);
  });
});
