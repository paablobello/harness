/**
 * Hooks — a subset of Claude Code's hook model.
 *
 * Each HookEvent corresponds to a turn-loop lifecycle point. Handlers receive
 * a structured payload and may return a result that BLOCKS downstream effects
 * (only meaningful for `UserPromptSubmit` and `PreToolUse`). Blocking a hook
 * is how guardrails (guides, in Fowler's vocabulary) feed back into the loop.
 *
 * This dispatcher is deliberately tiny — no eventemitter, no priorities.
 * Handlers run in registration order; the first to set `block: true` wins.
 */

export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop"
  | "SessionEnd";

export type HookPayloadBase = {
  session_id: string;
  run_id: string;
  cwd: string;
  timestamp: string;
  hook_event_name: HookEvent;
};

export type HookPayload =
  | (HookPayloadBase & { hook_event_name: "SessionStart"; source: "startup" | "resume" })
  | (HookPayloadBase & { hook_event_name: "UserPromptSubmit"; prompt: string })
  | (HookPayloadBase & {
      hook_event_name: "PreToolUse";
      tool_name: string;
      tool_input: unknown;
      tool_use_id: string;
    })
  | (HookPayloadBase & {
      hook_event_name: "PostToolUse";
      tool_name: string;
      tool_input: unknown;
      tool_use_id: string;
      tool_response: string;
    })
  | (HookPayloadBase & {
      hook_event_name: "PostToolUseFailure";
      tool_name: string;
      tool_input: unknown;
      tool_use_id: string;
      error: string;
    })
  | (HookPayloadBase & {
      hook_event_name: "SubagentStart";
      agent_id: string;
      agent_type: string;
    })
  | (HookPayloadBase & {
      hook_event_name: "SubagentStop";
      agent_id: string;
      agent_type: string;
      last_assistant_message?: string;
    })
  | (HookPayloadBase & {
      hook_event_name: "Stop";
      reason: "end_turn" | "max_tokens" | "tool_use" | "error";
    })
  | (HookPayloadBase & {
      hook_event_name: "SessionEnd";
      end_reason: "user_exit" | "eof" | "error";
    });

export type HookResult = {
  /** Cancel the downstream action (only honored for UserPromptSubmit and PreToolUse). */
  block?: boolean;
  /** Human-readable reason; for PreToolUse, this becomes the tool error passed back to the model. */
  reason?: string;
  /** Extra context to inject as a user-visible reminder (appended to the next turn). */
  systemMessage?: string;
};

export type HookHandler = (payload: HookPayload) => Promise<HookResult | void> | HookResult | void;

type Registered = { event: HookEvent; handler: HookHandler };

export class HookDispatcher {
  private readonly handlers: Registered[] = [];

  on(event: HookEvent, handler: HookHandler): this {
    this.handlers.push({ event, handler });
    return this;
  }

  /**
   * Dispatch a hook event. Returns the aggregated result.
   * Handlers run sequentially; accumulate systemMessages; short-circuit on block.
   */
  async dispatch(payload: HookPayload): Promise<HookResult> {
    const out: HookResult = {};
    const reminders: string[] = [];
    for (const h of this.handlers) {
      if (h.event !== payload.hook_event_name) continue;
      const res = (await h.handler(payload)) ?? {};
      if (res.systemMessage) reminders.push(res.systemMessage);
      if (res.block) {
        out.block = true;
        if (res.reason) out.reason = res.reason;
        break;
      }
    }
    if (reminders.length > 0) out.systemMessage = reminders.join("\n\n");
    return out;
  }
}
