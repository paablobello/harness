import type { Theme } from "../theme.js";

export const darkTheme: Theme = {
  name: "dark",
  text: "white",
  textMuted: "gray",
  primary: "cyan",
  secondary: "yellow",
  border: "gray",
  borderFocus: "cyan",
  error: "red",
  success: "green",
  warning: "yellow",
  user: "cyan",
  assistant: "yellow",
  tool: "blue",
  toolRunning: "magenta",
  diff: {
    add: "green",
    del: "red",
    hunk: "cyan",
  },
  status: {
    allow: "green",
    deny: "red",
    ask: "magenta",
  },
};
