import { z } from "zod";

import type { ToolDefinition } from "../types.js";

const input = z.object({
  description: z
    .string()
    .min(1)
    .describe("Brief identifier for what the subagent will do (used in logs)."),
  prompt: z
    .string()
    .min(1)
    .describe(
      "The full task description for the subagent. It receives no context from the parent " +
        "conversation other than this prompt — be self-contained.",
    ),
  allowed_tools: z
    .array(z.string())
    .optional()
    .describe(
      "Restrict the subagent's tool access to this allowlist (parent registry filtered). " +
        "Default: inherit all parent tools except `subagent` itself.",
    ),
});

export const subagentTool: ToolDefinition<z.infer<typeof input>> = {
  name: "subagent",
  description:
    "Spawn an isolated subagent to perform a focused subtask. The subagent gets a fresh " +
    "conversation, runs to completion, and returns its final assistant message as the tool result. " +
    "Use this to keep the parent's context clean while delegating a self-contained task.",
  inputSchema: input,
  risk: "execute",
  source: "builtin",
  async run(args, ctx) {
    if (!ctx.spawnSubagent) {
      return {
        ok: false,
        output: "subagent tool unavailable: runtime did not provide a spawnSubagent factory.",
      };
    }
    try {
      const result = await ctx.spawnSubagent({
        prompt: args.prompt,
        description: args.description,
        ...(args.allowed_tools ? { allowedTools: args.allowed_tools } : {}),
      });
      return {
        ok: true,
        output: result.lastMessage || "(subagent produced no final message)",
        meta: {
          agentId: result.agentId,
          turns: result.turns,
          tokens: { input: result.totalInputTokens, output: result.totalOutputTokens },
          costUsd: result.totalCostUsd,
        },
      };
    } catch (err) {
      return {
        ok: false,
        output: `Subagent failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
