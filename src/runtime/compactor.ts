/**
 * Context-window compaction.
 *
 * Two complementary techniques run in sequence (see
 * /Users/pablobello/.cursor/plans/context-window-compaction_65a0166e.plan.md
 * for the full rationale):
 *
 * 1. Observation masking (JetBrains Junie). Stale tool-result messages are
 *    replaced with a placeholder that keeps the tool *call* visible so the
 *    model still knows what it did. Tool outputs account for 60–80% of
 *    long-session context and this alone frees most of it for free.
 *
 * 2. LLM summarisation (OpenCode / Claude Code). Everything but the tail of
 *    the conversation is passed to the model adapter with a structured
 *    summariser prompt. The model returns a markdown block that replaces
 *    the summarised region.
 *
 * The untouched tail (`keepLastNTurns` messages at the end) is preserved
 * verbatim so file paths, error messages and recent tool output remain
 * byte-for-byte. Before anything is touched we write a full snapshot of
 * the pre-compaction conversation to disk so the agent (or a human) can
 * recover details the summary omitted.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ConversationMessage, ModelAdapter, ModelTurnInput } from "../types.js";
import { computeCost } from "./cost.js";

export type CompactorConfig = {
  /** Adapter used to produce the summary. The caller normally passes the session's adapter. */
  readonly adapter: ModelAdapter;
  /** Number of trailing messages kept verbatim. Defaults to 6 (≈3 user/assistant pairs). */
  readonly keepLastNTurns?: number;
  /** Most recent N tool results are kept verbatim; everything older is masked. Defaults to 6. */
  readonly keepLastNToolOutputs?: number;
  /** Optional override for the summariser system prompt. */
  readonly summarizerSystem?: string;
};

export type CompactRequest = {
  readonly reason: "auto" | "manual";
  /** Optional user-provided focus for `/compact <instructions>`. */
  readonly instructions?: string;
  /** Metrics captured at trigger time so hooks/events can report the cause. */
  readonly trigger: {
    readonly tokens: number;
    readonly threshold: number;
    readonly contextWindow: number | undefined;
  };
  /** Absolute path of the snapshot file to write before compaction. */
  readonly snapshotPath: string;
};

export type CompactResult = {
  /** Number of tokens in the generated summary (provider-reported; 0 if adapter did not report). */
  readonly summaryTokens: number;
  /** Input tokens spent by the summariser call. */
  readonly summaryInputTokens: number;
  /** Output tokens spent by the summariser call. */
  readonly summaryOutputTokens: number;
  /** Cost of the summariser call, when the adapter/model is priced. */
  readonly summaryCostUsd?: number;
  /** How many messages were collapsed into the summary (head length). */
  readonly freedMessages: number;
  /** Absolute path of the snapshot written before compaction. */
  readonly snapshotPath: string;
  /** The raw summary text returned by the model, for UI/hook consumers. */
  readonly summary: string;
};

const DEFAULT_KEEP_LAST_N_TURNS = 6;
const DEFAULT_KEEP_LAST_N_TOOL_OUTPUTS = 6;

export const DEFAULT_SUMMARIZER_SYSTEM =
  "You compact coding-agent conversations. Produce a structured markdown summary " +
  "that lets a new agent continue the work without re-reading anything. Preserve " +
  "EXACT strings — never paraphrase file paths, line numbers, error messages, " +
  "commit hashes, or commands. Prefer bullet lists over prose. Use these exact " +
  "headings in this order: ## FILES TOUCHED, ## COMMANDS RUN, ## DECISIONS, " +
  "## CURRENT STATE, ## PENDING. Omit a section only if it has nothing to report.";

/**
 * Apply observation masking in-place-ish: returns a new array where tool
 * messages older than `keepLastN` keep their role/id but have their `content`
 * replaced by a short placeholder.
 */
export function maskOldToolResults(
  messages: readonly ConversationMessage[],
  keepLastN: number,
  snapshotPath: string,
): ConversationMessage[] {
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m && m.role === "tool") toolIndices.push(i);
  }
  const maskBefore = Math.max(0, toolIndices.length - keepLastN);
  const keepFromIndex = toolIndices[maskBefore] ?? messages.length;
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const c of m.toolCalls) toolNameById.set(c.id, c.name);
    }
  }
  return messages.map((m, idx) => {
    if (m.role !== "tool") return m;
    if (idx >= keepFromIndex) return m;
    const name = toolNameById.get(m.toolCallId) ?? "tool";
    const approxChars = m.content.length;
    const masked =
      `[masked: ${name} output (~${approxChars} chars). ` +
      `Full text in snapshot ${snapshotPath}. Call the tool again if details are needed.]`;
    return { ...m, content: masked };
  });
}

/**
 * Split the message array into (head, tail) where `tail` keeps the last N
 * messages verbatim. Tail always starts on a user boundary so we never
 * orphan a tool message from its originating assistant turn.
 */
export function splitTail(
  messages: readonly ConversationMessage[],
  keepLastN: number,
): { head: ConversationMessage[]; tail: ConversationMessage[] } {
  if (keepLastN <= 0) {
    return { head: [...messages], tail: [] };
  }
  if (messages.length <= keepLastN) {
    return { head: [], tail: [...messages] };
  }

  let idx = Math.max(0, messages.length - keepLastN);
  // Walk backward to the user message that started the recent turn. Walking
  // forward can miss long assistant/tool chains and keep the whole history.
  while (idx > 0 && messages[idx]?.role !== "user") idx -= 1;
  if (messages[idx]?.role !== "user") {
    return { head: [...messages], tail: [] };
  }
  return { head: messages.slice(0, idx), tail: messages.slice(idx) };
}

function serializeMessages(messages: readonly ConversationMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push(`<user>\n${m.content}\n</user>`);
    } else if (m.role === "assistant") {
      let s = `<assistant>\n${m.content}`;
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const c of m.toolCalls) {
          s += `\n<tool_call name="${c.name}" id="${c.id}">\n${safeJson(c.input)}\n</tool_call>`;
        }
      }
      s += "\n</assistant>";
      out.push(s);
    } else {
      const errAttr = m.isError ? ' error="true"' : "";
      out.push(`<tool id="${m.toolCallId}"${errAttr}>\n${m.content}\n</tool>`);
    }
  }
  return out.join("\n");
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2) ?? "null";
  } catch {
    return String(x);
  }
}

async function writeSnapshot(
  path: string,
  messages: readonly ConversationMessage[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  await writeFile(path, lines, "utf8");
}

async function runSummarizer(
  adapter: ModelAdapter,
  system: string,
  head: readonly ConversationMessage[],
  instructions: string | undefined,
  signal: AbortSignal,
): Promise<{ text: string; inputTokens: number; outputTokens: number; costUsd?: number }> {
  const focusLine = instructions && instructions.trim().length > 0 ? instructions.trim() : "none";
  const userPrompt =
    `User focus for this compaction: ${focusLine}\n\n` +
    `Conversation to summarise:\n\n${serializeMessages(head)}`;
  const input: ModelTurnInput = {
    system,
    messages: [{ role: "user", content: userPrompt }],
  };
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | undefined;
  for await (const ev of adapter.runTurn(input, signal)) {
    if (ev.type === "text_delta") text += ev.text;
    else if (ev.type === "usage") {
      inputTokens = ev.inputTokens;
      outputTokens = ev.outputTokens;
      costUsd = ev.costUsd ?? computeCost(adapter.model, ev.inputTokens, ev.outputTokens);
    }
  }
  const result = { text: text.trim(), inputTokens, outputTokens };
  if (costUsd !== undefined) {
    return { ...result, costUsd };
  }
  return result;
}

/**
 * Core entry point. Pure function style: returns the new message list plus a
 * summary of what happened. Hooks/events are dispatched by the caller.
 *
 * If `req.reason === "manual"` we always run (the user explicitly asked). For
 * "auto" requests the caller has already decided the threshold was crossed.
 * When the head is empty (conversation too short) we still write a snapshot
 * and apply observation masking on the tail — the user asked for it.
 */
export async function compactMessages(
  messages: readonly ConversationMessage[],
  req: CompactRequest,
  cfg: CompactorConfig,
  signal: AbortSignal,
): Promise<{ messages: ConversationMessage[]; result: CompactResult }> {
  const keepLastNTurns = cfg.keepLastNTurns ?? DEFAULT_KEEP_LAST_N_TURNS;
  const keepLastNToolOutputs = cfg.keepLastNToolOutputs ?? DEFAULT_KEEP_LAST_N_TOOL_OUTPUTS;
  const summarizerSystem = cfg.summarizerSystem ?? DEFAULT_SUMMARIZER_SYSTEM;

  await writeSnapshot(req.snapshotPath, messages);

  const masked = maskOldToolResults(messages, keepLastNToolOutputs, req.snapshotPath);
  const { head, tail } = splitTail(masked, keepLastNTurns);

  if (head.length === 0) {
    // Nothing worth summarising. Still keep the masking effect + snapshot.
    return {
      messages: tail,
      result: {
        summaryTokens: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        freedMessages: 0,
        snapshotPath: req.snapshotPath,
        summary: "",
      },
    };
  }

  const {
    text: summary,
    inputTokens: summaryInputTokens,
    outputTokens: summaryOutputTokens,
    costUsd: summaryCostUsd,
  } = await runSummarizer(cfg.adapter, summarizerSystem, head, req.instructions, signal);

  const reminderLines = [
    "<system-reminder>",
    `Previous conversation has been compacted (${req.reason}, ${head.length} messages).`,
    `Full pre-compaction snapshot saved to: ${req.snapshotPath}`,
    "Read that file with the read tool if you need an exact path, line or error string the summary below omits.",
    "",
    "Summary:",
    summary.length > 0 ? summary : "(summariser returned empty output)",
    "</system-reminder>",
  ];
  const reminder: ConversationMessage = {
    role: "user",
    content: reminderLines.join("\n"),
  };

  return {
    messages: [reminder, ...tail],
    result:
      summaryCostUsd !== undefined
        ? {
            summaryTokens: summaryOutputTokens,
            summaryInputTokens,
            summaryOutputTokens,
            summaryCostUsd,
            freedMessages: head.length,
            snapshotPath: req.snapshotPath,
            summary,
          }
        : {
            summaryTokens: summaryOutputTokens,
            summaryInputTokens,
            summaryOutputTokens,
            freedMessages: head.length,
            snapshotPath: req.snapshotPath,
            summary,
          },
  };
}
