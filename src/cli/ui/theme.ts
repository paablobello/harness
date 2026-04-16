import { createContext, useContext } from "react";

import { darkTheme } from "./themes/dark.js";

/**
 * Semantic design tokens the Ink UI reads instead of hard-coding ANSI colors.
 * Values are any string Ink accepts (named colors, hex, RGB); see `ink`'s docs
 * on supported color formats.
 */
export type Theme = {
  readonly name: string;
  readonly background?: string;
  readonly text: string;
  readonly textMuted: string;
  readonly primary: string;
  readonly secondary: string;
  readonly border: string;
  readonly borderFocus: string;
  readonly error: string;
  readonly success: string;
  readonly warning: string;
  readonly user: string;
  readonly assistant: string;
  readonly tool: string;
  readonly toolRunning: string;
  readonly diff: {
    readonly add: string;
    readonly del: string;
    readonly hunk: string;
  };
  readonly status: {
    readonly allow: string;
    readonly deny: string;
    readonly ask: string;
  };
};

const ThemeContext = createContext<Theme>(darkTheme);

export const ThemeProvider = ThemeContext.Provider;

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
