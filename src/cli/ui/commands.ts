import type { Action } from "./state.js";

export type SlashCommandContext = {
  dispatch(action: Action): void;
  exit(): void;
  details: boolean;
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
    id: "clear",
    title: "/clear",
    description: "Clear the chat history from the screen",
    run(ctx) {
      ctx.dispatch({ type: "CLEAR" });
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
