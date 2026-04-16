import type { Theme } from "../theme.js";
import { darkTheme } from "./dark.js";
import { highContrastTheme } from "./high-contrast.js";
import { lightTheme } from "./light.js";

export const THEMES: Record<string, Theme> = {
  dark: darkTheme,
  light: lightTheme,
  "high-contrast": highContrastTheme,
};

export function resolveTheme(name: string | undefined): Theme {
  if (!name) return darkTheme;
  return THEMES[name] ?? darkTheme;
}

export { darkTheme, lightTheme, highContrastTheme };
