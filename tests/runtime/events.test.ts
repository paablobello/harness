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
});
