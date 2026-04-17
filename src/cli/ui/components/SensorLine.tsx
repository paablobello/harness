import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { SensorMsg } from "../state.js";
import { useTheme } from "../theme.js";

export function SensorLine({ msg }: { msg: SensorMsg }): ReactNode {
  const theme = useTheme();
  const icon = msg.ok ? "✔" : "✖";
  const color = msg.ok ? theme.success : theme.error;
  const preview = firstLine(msg.message, 120);
  return (
    <Box marginBottom={1}>
      <Text color={color}>{icon} </Text>
      <Text color={theme.textMuted}>
        sensor {msg.name}
        {preview ? ` · ${preview}` : ""}
      </Text>
    </Box>
  );
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}
