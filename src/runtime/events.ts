import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { finished } from "node:stream/promises";

/**
 * Every HarnessEvent is one line of JSONL in `.harness/runs/<run-id>/events.jsonl`.
 * Field naming mirrors Claude Code's hook payloads (snake_case + `event` key)
 * so that hooks and on-disk traces share a schema.
 */

type BaseFields = {
  timestamp: string;
  session_id: string;
  run_id: string;
};

export type HarnessEvent = BaseFields &
  (
    | { event: "SessionStart"; model: string; adapter: string; cwd: string }
    | { event: "UserPromptSubmit"; prompt: string }
    | { event: "AssistantTextDelta"; text: string }
    | { event: "AssistantMessage"; text: string }
    | {
        event: "ToolCall";
        tool_use_id: string;
        tool_name: string;
        tool_input: unknown;
      }
    | {
        event: "PolicyDecision";
        tool_use_id: string;
        tool_name: string;
        decision: "allow" | "deny" | "ask";
        reason?: string;
      }
    | {
        event: "ToolResult";
        tool_use_id: string;
        tool_name: string;
        ok: boolean;
        output: string;
        duration_ms: number;
      }
    | {
        event: "HookBlocked";
        hook_event_name: string;
        reason: string;
        tool_name?: string;
        tool_use_id?: string;
      }
    | {
        event: "SensorRun";
        name: string;
        kind: "computational" | "inferential";
        trigger: "after_tool" | "after_turn" | "final";
        ok: boolean;
        message: string;
        duration_ms: number;
      }
    | {
        event: "Usage";
        input_tokens: number;
        output_tokens: number;
        cost_usd?: number;
      }
    | {
        event: "Stop";
        reason: "end_turn" | "max_tokens" | "tool_use" | "error";
        error?: string;
      }
    | { event: "SessionEnd"; end_reason: SessionEndReason }
  );

export type SessionEndReason = "user_exit" | "eof" | "error";

export interface EventSink {
  write(event: HarnessEvent): void;
  close(): Promise<void>;
}

export class MemoryEventSink implements EventSink {
  readonly events: HarnessEvent[] = [];

  write(event: HarnessEvent): void {
    this.events.push(event);
  }

  async close(): Promise<void> {
    // no-op
  }
}

export class FileEventSink implements EventSink {
  private constructor(
    private readonly stream: WriteStream,
    readonly filePath: string,
  ) {}

  static async open(filePath: string): Promise<FileEventSink> {
    await mkdir(dirname(filePath), { recursive: true });
    const stream = createWriteStream(filePath, { flags: "a" });
    return new FileEventSink(stream, filePath);
  }

  write(event: HarnessEvent): void {
    this.stream.write(JSON.stringify(event) + "\n");
  }

  async close(): Promise<void> {
    this.stream.end();
    await finished(this.stream);
  }
}
