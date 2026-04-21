import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultPolicy } from "../../src/policy/defaults.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import { ControlChannel } from "../../src/runtime/control.js";
import { MemoryEventSink } from "../../src/runtime/events.js";
import { runSession } from "../../src/runtime/session.js";
import { createBuiltinRegistry } from "../../src/tools/builtin.js";
import type {
  AskPlan,
  ConversationMessage,
  ModelAdapter,
  ModelEvent,
  ModelTurnInput,
  PlanDecision,
} from "../../src/types.js";
import { queuedInput } from "../fixtures/fake-adapter.js";

/** Plan body that clears `exit_plan_mode`'s soft-validation. Keep in sync
 *  with the similarly-named helper in tests/tools/exit-plan-mode.test.ts. */
function validPlanText(title = "Refactor auth"): string {
  return (
    `# ${title}\n\n` +
    "## Objective\nExtract the session helper so tRPC and Express share it.\n\n" +
    "## Affected files\n- src/auth/middleware.ts\n- src/auth/session.ts\n- tests/auth/middleware.test.ts\n\n" +
    "## Steps\n1. Create verifySession() in src/auth/session.ts\n" +
    "2. Rewrite src/auth/middleware.ts around it\n3. Update tests\n\n" +
    "## Risks\nCookie parsing order; request-scoped cache handles it.\n\n" +
    "## Verification\nRun pnpm test auth and pnpm typecheck."
  );
}

/**
 * Adapter that records every `turnInput` it was called with. Tests use the
 * snapshot of `messages` to assert the session injected the plan-mode
 * `<system-reminder>` on the right turn.
 */
function createRecordingAdapter(script: ModelEvent[][]): {
  adapter: ModelAdapter;
  seenMessages: ConversationMessage[][];
  seenReasoning: (ModelTurnInput["reasoning"] | undefined)[];
} {
  const seenMessages: ConversationMessage[][] = [];
  const seenReasoning: (ModelTurnInput["reasoning"] | undefined)[] = [];
  let turn = 0;
  const adapter: ModelAdapter = {
    name: "fake",
    model: "fake-model",
    async *runTurn(input: ModelTurnInput): AsyncIterable<ModelEvent> {
      seenMessages.push(input.messages.map((m) => ({ ...m })));
      seenReasoning.push(input.reasoning);
      const events = script[turn] ?? [];
      turn += 1;
      for (const ev of events) yield ev;
    },
  };
  return { adapter, seenMessages, seenReasoning };
}

describe("plan mode — session integration", () => {
  it("injects PLAN_ENTRY_REMINDER on the turn following a set_mode control", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-plan-entry-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({ rules: defaultPolicy, mode: "default" });
      const controls = new ControlChannel();
      controls.push({ type: "set_mode", mode: "plan" });

      const { adapter, seenMessages } = createRecordingAdapter([
        [
          { type: "text_delta", text: "ack" },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "end_turn" },
        ],
      ]);

      await runSession({
        adapter,
        system: "test",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        controls,
        input: queuedInput(["hello"]),
      });

      const firstTurn = seenMessages[0] ?? [];
      const reminder = firstTurn.find(
        (m) => m.role === "user" && m.content.includes("Plan mode is now active"),
      );
      expect(reminder).toBeDefined();
      expect(policy.getMode()).toBe("plan");

      const modeChanged = sink.events.find((e) => e.event === "PermissionModeChanged");
      expect(modeChanged).toMatchObject({ from: "default", to: "plan", source: "user" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects PLAN_ENTRY_REMINDER when the session starts in plan mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-plan-start-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({ rules: defaultPolicy, mode: "plan" });

      const { adapter, seenMessages } = createRecordingAdapter([
        [
          { type: "text_delta", text: "ack" },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "end_turn" },
        ],
      ]);

      await runSession({
        adapter,
        system: "test",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        input: queuedInput(["hello"]),
      });

      const firstTurn = seenMessages[0] ?? [];
      const reminder = firstTurn.find(
        (m) => m.role === "user" && m.content.includes("Plan mode is now active"),
      );
      expect(reminder).toBeDefined();
      expect(sink.events.filter((e) => e.event === "PermissionModeChanged")).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies write tools while in plan mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-plan-deny-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({ rules: defaultPolicy, mode: "plan" });

      const adapter = createRecordingAdapter([
        [
          {
            type: "tool_call",
            id: "c1",
            name: "edit_file",
            input: { path: "bad.txt", old_str: "", new_str: "nope" },
          },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "fine" },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "end_turn" },
        ],
      ]).adapter;

      await runSession({
        adapter,
        system: "test",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        input: queuedInput(["try to write"]),
      });

      const policyDecisions = sink.events.filter((e) => e.event === "PolicyDecision");
      const denial = policyDecisions.find((e) => "tool_name" in e && e.tool_name === "edit_file");
      expect(denial).toMatchObject({ decision: "deny" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reprompts instead of surfacing final plain text while in plan mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-plan-plaintext-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({ rules: defaultPolicy, mode: "plan" });

      const leakedPlan =
        "## Objective\nDo the thing.\n\n" +
        "## Affected files\n- src/runtime/session.ts\n- tests/runtime/session-plan-mode.test.ts\n\n" +
        "## Steps\n1. Patch runtime\n2. Add tests\n3. Run verification";

      const { adapter, seenMessages } = createRecordingAdapter([
        [
          { type: "text_delta", text: leakedPlan },
          { type: "usage", inputTokens: 10, outputTokens: 20 },
          { type: "stop", reason: "end_turn" },
        ],
        [
          {
            type: "tool_call",
            id: "c-exit",
            name: "exit_plan_mode",
            input: { plan: validPlanText("Guard plan mode") },
          },
          { type: "usage", inputTokens: 11, outputTokens: 21 },
          { type: "stop", reason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "approved" },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "end_turn" },
        ],
      ]);

      const askPlan: AskPlan = async () => ({ approved: true });

      await runSession({
        adapter,
        system: "test",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        askPlan,
        input: queuedInput(["audit the repo"]),
      });

      expect(policy.getMode()).toBe("default");

      const secondTurn = seenMessages[1] ?? [];
      expect(
        secondTurn.some(
          (m) =>
            m.role === "user" &&
            m.content.includes("previous response tried to finish in") &&
            m.content.includes("exit_plan_mode"),
        ),
      ).toBe(true);

      const assistantMessages = sink.events
        .filter((e) => e.event === "AssistantMessage")
        .map((e) => ("text" in e ? e.text : ""));
      expect(assistantMessages.join("\n")).not.toContain("## Objective");

      const assistantDeltas = sink.events
        .filter((e) => e.event === "AssistantTextDelta")
        .map((e) => ("text" in e ? e.text : ""));
      expect(assistantDeltas.join("\n")).not.toContain("## Objective");

      const files = await readdir(join(root, ".harness", "plans"));
      expect(files).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still allows a plain clarifying question in plan mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-plan-question-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({ rules: defaultPolicy, mode: "plan" });

      const question = "¿Qué área quieres que priorice: runtime, CLI, o tests?";
      const { adapter, seenMessages } = createRecordingAdapter([
        [
          { type: "text_delta", text: question },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "end_turn" },
        ],
      ]);

      await runSession({
        adapter,
        system: "test",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        input: queuedInput(["analyze improvements"]),
      });

      expect(policy.getMode()).toBe("plan");
      expect(seenMessages).toHaveLength(1);

      const assistantMsg = sink.events.find((e) => e.event === "AssistantMessage");
      expect(assistantMsg).toMatchObject({ text: question });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows exit_plan_mode after the exploratory tool budget is exhausted", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-plan-budget-exit-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({ rules: defaultPolicy, mode: "plan" });

      const { adapter } = createRecordingAdapter([
        [
          {
            type: "tool_call",
            id: "c-list",
            name: "list_files",
            input: { path: "." },
          },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "Presento el plan para aprobación." },
          {
            type: "tool_call",
            id: "c-exit",
            name: "exit_plan_mode",
            input: { plan: validPlanText("Budget exhausted") },
          },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "implementation phase" },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "end_turn" },
        ],
      ]);

      const askPlan: AskPlan = async () => ({ approved: true });

      await runSession({
        adapter,
        system: "test",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        askPlan,
        input: queuedInput(["plan please"]),
        maxToolsPerUserTurn: 1,
      });

      expect(policy.getMode()).toBe("default");

      const exitResult = sink.events.find(
        (e) => e.event === "ToolResult" && e.tool_use_id === "c-exit",
      );
      expect(exitResult).toMatchObject({ ok: true });
      expect(exitResult && "output" in exitResult && exitResult.output).not.toContain(
        "exceeded max",
      );

      const assistantText = sink.events
        .filter((e) => e.event === "AssistantMessage")
        .map((e) => ("text" in e ? e.text : ""))
        .join("\n");
      expect(assistantText).not.toContain("Presento el plan");
      expect(assistantText).toContain("implementation phase");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns the model to stop reading when the plan-mode tool budget is exhausted", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-plan-budget-reminder-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({ rules: defaultPolicy, mode: "plan" });

      const { adapter, seenMessages } = createRecordingAdapter([
        [
          {
            type: "tool_call",
            id: "c-list",
            name: "list_files",
            input: { path: "." },
          },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "tool_use" },
        ],
        [
          {
            type: "tool_call",
            id: "c-read",
            name: "read_file",
            input: { path: "package.json" },
          },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "tool_use" },
        ],
        [
          {
            type: "tool_call",
            id: "c-exit",
            name: "exit_plan_mode",
            input: { plan: validPlanText("Budget reminder") },
          },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "approved" },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "end_turn" },
        ],
      ]);

      const askPlan: AskPlan = async () => ({ approved: true });

      await runSession({
        adapter,
        system: "test",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        askPlan,
        input: queuedInput(["plan please"]),
        maxToolsPerUserTurn: 1,
      });

      const readResult = sink.events.find(
        (e) => e.event === "ToolResult" && e.tool_use_id === "c-read",
      );
      expect(readResult && "output" in readResult && readResult.output).toContain(
        "exit_plan_mode is still allowed",
      );

      const thirdTurn = seenMessages[2] ?? [];
      expect(
        thirdTurn.some(
          (m) =>
            m.role === "user" &&
            m.content.includes("read-tool budget") &&
            m.content.includes("exit_plan_mode"),
        ),
      ).toBe(true);
      expect(policy.getMode()).toBe("default");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exit_plan_mode approval writes plan.md and restores previous mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-plan-approve-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({ rules: defaultPolicy, mode: "plan" });

      const planText = validPlanText("Refactor auth");

      const { adapter, seenMessages } = createRecordingAdapter([
        [
          {
            type: "tool_call",
            id: "c-exit",
            name: "exit_plan_mode",
            input: { plan: planText },
          },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "implementing" },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "end_turn" },
        ],
      ]);

      const askPlan: AskPlan = async () => ({ approved: true });

      await runSession({
        adapter,
        system: "test",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        askPlan,
        input: queuedInput(["please plan"]),
      });

      expect(policy.getMode()).toBe("default");

      const planDir = join(root, ".harness", "plans");
      const files = await readdir(planDir);
      expect(files).toHaveLength(1);
      const firstFile = files[0];
      expect(firstFile).toBeDefined();
      const written = await readFile(join(planDir, firstFile as string), "utf8");
      expect(written).toContain("Refactor auth");

      const changed = sink.events.filter((e) => e.event === "PermissionModeChanged");
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({ from: "plan", to: "default", source: "tool" });

      // Silence the unused-adapter-capture variable
      expect(seenMessages.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exit_plan_mode rejection keeps plan mode active and surfaces feedback", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-plan-reject-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({ rules: defaultPolicy, mode: "plan" });

      const { adapter, seenMessages } = createRecordingAdapter([
        [
          {
            type: "tool_call",
            id: "c-exit-1",
            name: "exit_plan_mode",
            input: { plan: validPlanText("Plan v1") },
          },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "ok revising" },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "end_turn" },
        ],
      ]);

      const askPlan: AskPlan = async (): Promise<PlanDecision> => ({
        approved: false,
        feedback: "Missing step about DB migration.",
      });

      await runSession({
        adapter,
        system: "test",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        askPlan,
        input: queuedInput(["plan please"]),
      });

      expect(policy.getMode()).toBe("plan");

      const secondTurn = seenMessages[1] ?? [];
      const toolResult = secondTurn.find(
        (m) => m.role === "tool" && m.content.includes("Missing step about DB migration"),
      );
      expect(toolResult).toBeDefined();

      const modeChanged = sink.events.filter((e) => e.event === "PermissionModeChanged");
      expect(modeChanged).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("auto-injects reasoning: { effort: 'high' } into turn input while in plan mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-plan-reasoning-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({ rules: defaultPolicy, mode: "plan" });

      const { adapter, seenReasoning } = createRecordingAdapter([
        [
          { type: "text_delta", text: "thinking..." },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "end_turn" },
        ],
      ]);

      await runSession({
        adapter,
        system: "test",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        input: queuedInput(["think hard"]),
      });

      expect(seenReasoning[0]).toEqual({ effort: "high" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not inject reasoning by default in non-plan modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-default-reasoning-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({ rules: defaultPolicy, mode: "default" });

      const { adapter, seenReasoning } = createRecordingAdapter([
        [
          { type: "text_delta", text: "ok" },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "end_turn" },
        ],
      ]);

      await runSession({
        adapter,
        system: "test",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        input: queuedInput(["hi"]),
      });

      expect(seenReasoning[0]).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors an explicit null override to disable reasoning in plan mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-reasoning-override-"));
    try {
      const sink = new MemoryEventSink();
      const tools = createBuiltinRegistry();
      const policy = new PolicyEngine({ rules: defaultPolicy, mode: "plan" });

      const { adapter, seenReasoning } = createRecordingAdapter([
        [
          { type: "text_delta", text: "ok" },
          { type: "usage", inputTokens: 1, outputTokens: 1 },
          { type: "stop", reason: "end_turn" },
        ],
      ]);

      await runSession({
        adapter,
        system: "test",
        cwd: root,
        workspaceRoot: root,
        sink,
        tools,
        policy,
        reasoning: { plan: null },
        input: queuedInput(["hi"]),
      });

      expect(seenReasoning[0]).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
