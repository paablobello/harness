import type { Theme } from "../theme.js";
import { darkTheme } from "./dark.js";

export const THEMES: Record<string, Theme> = {
  dark: darkTheme,
};

export function resolveTheme(_name?: string | undefined): Theme {
  return darkTheme;
}

export { darkTheme };
