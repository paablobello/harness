import { zodToJsonSchema } from "zod-to-json-schema";

import type { ToolDefinition, ToolSpec } from "../types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<I>(tool: ToolDefinition<I>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as ToolDefinition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  specs(): ToolSpec[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.jsonSchema ?? zodToJsonSchema(t.inputSchema, { target: "jsonSchema7" }),
    }));
  }
}
