import type { Theme } from "../theme.js";

export const darkTheme: Theme = {
  name: "dark",
  text: "#e6e6e6",
  textMuted: "#9a9a9a",
  primary: "#a474fc",
  secondary: "#7dd3fc",
  border: "#3f3f46",
  borderFocus: "#a474fc",
  error: "#f87171",
  success: "#4ade80",
  warning: "#fbbf24",
  user: "#c4b5fd",
  assistant: "#a474fc",
  tool: "#7dd3fc",
  toolRunning: "#a474fc",
  diff: {
    add: "#4ade80",
    del: "#f87171",
    hunk: "#a474fc",
  },
  status: {
    allow: "#4ade80",
    deny: "#f87171",
    ask: "#a474fc",
  },
};
