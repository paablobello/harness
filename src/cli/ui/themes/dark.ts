import type { Theme } from "../theme.js";

export const darkTheme: Theme = {
  name: "dark",
  text: "#e6e6e6",
  textMuted: "#8a8a92",
  textDim: "#5a5a62",
  primary: "#a474fc",
  accentDim: "#7c5bc8",
  accentSoft: "#c4b5fd",
  secondary: "#7dd3fc",
  border: "#2a2a2e",
  borderFocus: "#a474fc",
  error: "#fca5a5",
  success: "#6ee7b7",
  warning: "#fbbf24",
  user: "#c4b5fd",
  userBg: "#3f3d4e",
  assistant: "#a474fc",
  tool: "#7dd3fc",
  toolRunning: "#a474fc",
  diff: {
    add: "#a7f3d0",
    addBg: "#0f3b2d",
    del: "#fecaca",
    delBg: "#4a1d1d",
    hunk: "#a474fc",
  },
  status: {
    allow: "#6ee7b7",
    deny: "#fca5a5",
    ask: "#a474fc",
  },
};
