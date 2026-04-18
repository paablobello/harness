import type { Action } from "./state.js";

export type SlashCommandContext = {
  dispatch(action: Action): void;
  exit(): void;
  details: boolean;
  /** Optional hook the UI wires up to the runtime ControlChannel. */
  onCompact?: (instructions?: string) => void;
  /** Optional hook the UI wires up to the runtime ControlChannel. */
  onClear?: () => void;
};

export type SlashCommand = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly acceptsArgs?: boolean;
  run(ctx: SlashCommandContext, args: string): void;
};

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: "help",
    title: "/help",
    description: "Show available commands",
    run(ctx) {
      ctx.dispatch({ type: "OPEN_OVERLAY", overlay: { type: "help" } });
    },
  },
  {
    id: "status",
    title: "/status",
    description: "Show cwd, model, permission mode and log path",
    run(ctx) {
      ctx.dispatch({ type: "OPEN_OVERLAY", overlay: { type: "status" } });
    },
  },
  {
    id: "model",
    title: "/model",
    description: "Show the active model",
    run(ctx) {
      ctx.dispatch({ type: "OPEN_OVERLAY", overlay: { type: "model" } });
    },
  },
  {
    id: "tools",
    title: "/tools",
    description: "List available tools",
    run(ctx) {
      ctx.dispatch({ type: "OPEN_OVERLAY", overlay: { type: "tools" } });
    },
  },
  {
    id: "details",
    title: "/details",
    description: "Toggle detailed tool input/output",
    run(ctx) {
      ctx.dispatch({ type: "SET_DETAILS", value: !ctx.details });
      ctx.dispatch({ type: "OPEN_OVERLAY", overlay: { type: "details" } });
    },
  },
  {
    id: "log",
    title: "/log",
    description: "Print the current events.jsonl path",
    run(ctx) {
      ctx.dispatch({ type: "OPEN_OVERLAY", overlay: { type: "log" } });
    },
  },
  {
    id: "usage",
    title: "/usage",
    description: "Show tokens, cost, context window, and per-tool stats for this session",
    run(ctx) {
      ctx.dispatch({ type: "OPEN_OVERLAY", overlay: { type: "usage" } });
    },
  },
  {
    id: "context",
    title: "/context",
    description: "Show a breakdown of the current context window fill",
    run(ctx) {
      ctx.dispatch({ type: "OPEN_OVERLAY", overlay: { type: "context" } });
    },
  },
  {
    id: "compact",
    title: "/compact",
    description: "Summarise older messages to free context. Optional focus: /compact focus on X",
    acceptsArgs: true,
    run(ctx, args) {
      const instructions = args.trim();
      if (ctx.onCompact) {
        ctx.onCompact(instructions.length > 0 ? instructions : undefined);
      } else {
        ctx.dispatch({
          type: "INFO",
          level: "warn",
          text: "Compaction is not available in this session.",
        });
      }
    },
  },
  {
    id: "clear",
    title: "/clear",
    description: "Drop the runtime conversation history and clear the transcript",
    run(ctx) {
      ctx.dispatch({ type: "CLEAR" });
      ctx.onClear?.();
    },
  },
  {
    id: "exit",
    title: "/exit",
    description: "Quit Harness",
    run(ctx) {
      ctx.exit();
    },
  },
];

/** Return commands that start with the query after the leading slash, highest match first. */
export function filterCommands(input: string): readonly SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const firstSpace = input.indexOf(" ");
  const head = firstSpace === -1 ? input : input.slice(0, firstSpace);
  if (firstSpace !== -1) {
    // User has already committed to a command (typed a space). Only keep the exact one.
    const exact = SLASH_COMMANDS.find((c) => c.title === head);
    return exact ? [exact] : [];
  }
  const q = head.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.title.toLowerCase().startsWith(q));
}

/**
 * Dispatch a slash command string (e.g. "/model" or "/theme light").
 * Returns true if it was handled as a slash command, false if it should be sent as a prompt.
 */
export function dispatchSlash(line: string, ctx: SlashCommandContext): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return false;
  // Bare "/" with nothing after it: show help rather than complain.
  if (trimmed === "/") {
    ctx.dispatch({ type: "OPEN_OVERLAY", overlay: { type: "help" } });
    return true;
  }
  const firstSpace = trimmed.indexOf(" ");
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const args = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
  const aliases: Record<string, string> = {
    "/?": "/help",
    "/quit": "/exit",
    "/q": "/exit",
  };
  const resolved = aliases[head] ?? head;
  const cmd = SLASH_COMMANDS.find((c) => c.title === resolved);
  if (!cmd) {
    ctx.dispatch({
      type: "INFO",
      level: "warn",
      text: `Unknown command: ${head}. Type /help for available commands.`,
    });
    return true;
  }
  cmd.run(ctx, args);
  return true;
}

export function isExitInput(line: string): boolean {
  return ["exit", "quit", "q", "/exit", "/quit", "/q"].includes(line.trim().toLowerCase());
}

export function isLikelyHarnessInvocation(line: string): boolean {
  return /^harness(\s|$)/.test(line.trim());
}
