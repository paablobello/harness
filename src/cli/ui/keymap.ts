/** Key names / chords used by the Ink UI. */
export const KEYS = {
  SEND: { label: "Enter", help: "send message" },
  NEWLINE: { label: "\\ + Enter", help: "insert a newline" },
  OPEN_EDITOR: { label: "Ctrl+E", help: "open $EDITOR for a long prompt" },
  HISTORY_PREV: { label: "↑", help: "previous message in history" },
  HISTORY_NEXT: { label: "↓", help: "next message in history" },
  REVERSE_SEARCH: { label: "Ctrl+R", help: "search previous messages" },
  EXPAND_TOOL: { label: "Ctrl+O", help: "toggle expand on the focused tool" },
  FOCUS_NEXT_TOOL: { label: "Ctrl+]", help: "move focus to the next tool block" },
  TOGGLE_PLAN: { label: "Shift+Tab", help: "toggle plan mode (read-only planning)" },
  CANCEL: { label: "Esc", help: "cancel the current turn" },
  QUIT: { label: "Ctrl+C", help: "exit Harness (twice to confirm)" },
} as const;
