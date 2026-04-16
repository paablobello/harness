import type { Theme } from "../theme.js";

export const highContrastTheme: Theme = {
  name: "high-contrast",
  text: "white",
  textMuted: "white",
  primary: "cyanBright",
  secondary: "yellowBright",
  border: "white",
  borderFocus: "cyanBright",
  error: "redBright",
  success: "greenBright",
  warning: "yellowBright",
  user: "cyanBright",
  assistant: "yellowBright",
  tool: "blueBright",
  toolRunning: "magentaBright",
  diff: {
    add: "greenBright",
    del: "redBright",
    hunk: "cyanBright",
  },
  status: {
    allow: "greenBright",
    deny: "redBright",
    ask: "magentaBright",
  },
};
