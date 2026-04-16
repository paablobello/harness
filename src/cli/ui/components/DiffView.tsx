import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { useTheme } from "../theme.js";

export function DiffView({
  diff,
  maxLines = 20,
  expanded = false,
}: {
  readonly diff: string;
  readonly maxLines?: number;
  readonly expanded?: boolean;
}): ReactNode {
  const theme = useTheme();
  const allLines = diff.split("\n");
  const lines = expanded ? allLines : allLines.slice(0, maxLines);
  const overflow = allLines.length - lines.length;
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const color = colorForLine(line, theme);
        return (
          <Text key={i} color={color}>
            {line || " "}
          </Text>
        );
      })}
      {overflow > 0 && (
        <Text color={theme.textMuted}>
          … +{overflow} more line{overflow === 1 ? "" : "s"} (Ctrl+O to expand)
        </Text>
      )}
    </Box>
  );
}

function colorForLine(line: string, theme: ReturnType<typeof useTheme>): string | undefined {
  if (line.startsWith("@@")) return theme.diff.hunk;
  if (line.startsWith("+") && !line.startsWith("+++")) return theme.diff.add;
  if (line.startsWith("-") && !line.startsWith("---")) return theme.diff.del;
  return undefined;
}
