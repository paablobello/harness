import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { useTheme, type Theme } from "../theme.js";

type Style = {
  readonly color?: string | undefined;
  readonly bg?: string | undefined;
  readonly bold?: boolean;
};

export function DiffView({
  diff,
  maxLines = 24,
  expanded = false,
  prefix = true,
}: {
  readonly diff: string;
  readonly maxLines?: number;
  readonly expanded?: boolean;
  readonly prefix?: boolean;
}): ReactNode {
  const theme = useTheme();
  const allLines = diff.split("\n");
  const lines = expanded ? allLines : allLines.slice(0, maxLines);
  const overflow = allLines.length - lines.length;
  return (
    <>
      {lines.map((line, i) => (
        <DiffLine key={i} line={line} prefix={prefix} theme={theme} />
      ))}
      {overflow > 0 && (
        <Box>
          {prefix && <Text color={theme.accentDim}>{"│ "}</Text>}
          <Text color={theme.textMuted}>
            … +{overflow} more line{overflow === 1 ? "" : "s"} (Ctrl+O to expand)
          </Text>
        </Box>
      )}
    </>
  );
}

function DiffLine({
  line,
  prefix,
  theme,
}: {
  readonly line: string;
  readonly prefix: boolean;
  readonly theme: Theme;
}): ReactNode {
  const style = styleForLine(line, theme);
  const textProps: { color?: string; backgroundColor?: string; bold?: boolean } = {};
  if (style.color) textProps.color = style.color;
  if (style.bg) textProps.backgroundColor = style.bg;
  if (style.bold) textProps.bold = true;

  if (style.bg) {
    // Full-bleed row: inner Box with flexGrow=1 + backgroundColor so the
    // color paints to the right edge of the terminal, not just under the
    // text — matches Claude Code's diff rendering.
    return (
      <Box>
        {prefix && <Text color={theme.accentDim}>{"│ "}</Text>}
        <Box backgroundColor={style.bg} flexGrow={1}>
          <Text {...textProps}>{line || " "}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box>
      {prefix && <Text color={theme.accentDim}>{"│ "}</Text>}
      <Text {...textProps}>{line || " "}</Text>
    </Box>
  );
}

function styleForLine(line: string, theme: Theme): Style {
  if (line.startsWith("@@")) return { color: theme.diff.hunk, bold: true };
  if (line.startsWith("+++") || line.startsWith("---")) {
    return { color: theme.textMuted, bold: true };
  }
  if (line.startsWith("+")) return { color: theme.diff.add, bg: theme.diff.addBg };
  if (line.startsWith("-")) return { color: theme.diff.del, bg: theme.diff.delBg };
  return { color: theme.textMuted };
}
