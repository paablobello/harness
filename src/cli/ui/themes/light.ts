import type { Theme } from "../theme.js";

export const lightTheme: Theme = {
  name: "light",
  text: "black",
  textMuted: "#5a5a5a",
  primary: "#005f87",
  secondary: "#8700af",
  border: "#8a8a8a",
  borderFocus: "#005f87",
  error: "#af0000",
  success: "#008700",
  warning: "#af5f00",
  user: "#005f87",
  assistant: "#8700af",
  tool: "#005faf",
  toolRunning: "#af5f00",
  diff: {
    add: "#008700",
    del: "#af0000",
    hunk: "#005f87",
  },
  status: {
    allow: "#008700",
    deny: "#af0000",
    ask: "#8700af",
  },
};
