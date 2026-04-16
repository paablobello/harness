import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

import type { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition } from "../types.js";

/**
 * Declarative spec for a single MCP server. Stdio is the only transport
 * supported in v0 — it covers the bulk of MCP servers shipped today
 * (filesystem, git, github, etc, all distributed as `npx`-runnable bins).
 */
export type McpServerSpec = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

type Connected = {
  spec: McpServerSpec;
  client: Client;
  transport: StdioClientTransport;
};

/**
 * `McpHub` connects to one or more MCP servers, surfaces their tools as
 * `ToolDefinition`s prefixed `mcp__<server>__<tool>`, and registers them into
 * a shared `ToolRegistry`. The registry's `specs()` will use the server-provided
 * JSON Schema verbatim, so the model sees what the server intended.
 */
export class McpHub {
  private readonly connected: Connected[] = [];
  private readonly tools: ToolDefinition[] = [];

  async connect(spec: McpServerSpec): Promise<void> {
    const transport = new StdioClientTransport({
      command: spec.command,
      ...(spec.args ? { args: spec.args } : {}),
      ...(spec.env ? { env: spec.env } : {}),
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
    });
    const client = new Client(
      { name: "harness-lab", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    this.connected.push({ spec, client, transport });

    const { tools } = await client.listTools();
    for (const t of tools) {
      const fullName = `mcp__${spec.name}__${t.name}`;
      const description = t.description ?? `[${spec.name}] ${t.name}`;
      this.tools.push({
        name: fullName,
        description,
        inputSchema: z.any(),
        jsonSchema: t.inputSchema,
        risk: "execute",
        source: "mcp",
        async run(input) {
          try {
            const res = await client.callTool({
              name: t.name,
              arguments: (input ?? {}) as Record<string, unknown>,
            });
            const text = extractText(res.content);
            const ok = res.isError !== true;
            return { ok, output: text || (ok ? "(no output)" : "MCP tool error") };
          } catch (err) {
            return {
              ok: false,
              output: `MCP call failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });
    }
  }

  registerInto(registry: ToolRegistry): void {
    for (const t of this.tools) registry.register(t);
  }

  list(): ToolDefinition[] {
    return [...this.tools];
  }

  async close(): Promise<void> {
    for (const c of this.connected) {
      try {
        await c.client.close();
      } catch {
        // ignore
      }
    }
    this.connected.length = 0;
    this.tools.length = 0;
  }
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object" && (c as { type?: string }).type === "text") {
      const text = (c as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}
