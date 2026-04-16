import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { SlashCommand } from "../commands.js";
import { useTheme } from "../theme.js";

type Props = {
  readonly suggestions: readonly SlashCommand[];
  readonly activeIndex: number;
  readonly historyMode?: boolean;
  readonly historyMatches?: readonly string[];
};

const MAX_SHOW = 8;

export function SuggestionsPanel({
  suggestions,
  activeIndex,
  historyMode,
  historyMatches,
}: Props): ReactNode {
  const theme = useTheme();

  if (historyMode) {
    const matches = historyMatches ?? [];
    if (matches.length === 0) {
      return (
        <Box paddingX={1}>
          <Text color={theme.textMuted}>No history match.</Text>
        </Box>
      );
    }
    const visible = matches.slice(0, MAX_SHOW);
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.textMuted}>
          reverse-i-search ({matches.length} match{matches.length === 1 ? "" : "es"})
        </Text>
        {visible.map((text, i) => {
          const active = i === activeIndex;
          return (
            <Box key={i}>
              <Text color={active ? theme.borderFocus : theme.textMuted} bold={active}>
                {active ? "➤ " : "  "}
              </Text>
              <Text color={active ? theme.text : theme.textMuted}>{truncate(text, 96)}</Text>
            </Box>
          );
        })}
        {matches.length > MAX_SHOW && (
          <Text color={theme.textMuted}>
            ({activeIndex + 1}/{matches.length}) Ctrl+R next · Esc cancel
          </Text>
        )}
      </Box>
    );
  }

  if (suggestions.length === 0) return null;

  const maxTitle = Math.max(...suggestions.map((s) => s.title.length));
  const visible = suggestions.slice(0, MAX_SHOW);
  return (
    <Box flexDirection="column" paddingX={1}>
      {visible.map((s, i) => {
        const active = i === activeIndex;
        return (
          <Box key={s.id}>
            <Text color={active ? theme.borderFocus : theme.textMuted} bold={active}>
              {active ? "➤ " : "  "}
            </Text>
            <Box width={maxTitle + 2}>
              <Text color={active ? theme.primary : theme.text} bold={active}>
                {s.title}
              </Text>
            </Box>
            <Text color={active ? theme.text : theme.textMuted}>{s.description}</Text>
          </Box>
        );
      })}
      {suggestions.length > MAX_SHOW && (
        <Text color={theme.textMuted}>
          ({activeIndex + 1}/{suggestions.length}) ↑/↓ navigate · Tab complete · Enter run
        </Text>
      )}
    </Box>
  );
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\n/g, " ⏎ ");
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}
