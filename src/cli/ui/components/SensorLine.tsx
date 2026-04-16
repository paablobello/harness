import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { SensorMsg } from "../state.js";
import { useTheme } from "../theme.js";

export function SensorLine({ msg }: { msg: SensorMsg }): ReactNode {
  const theme = useTheme();
  const color = msg.ok ? theme.success : theme.error;
  const preview = firstLine(msg.message, 140);
  return (
    <Box marginBottom={1}>
      <Text color={theme.textMuted}>sensor </Text>
      <Text color={color} bold>
        {msg.ok ? "ok" : "fail"}
      </Text>
      <Text> {msg.name}</Text>
      {preview && <Text color={theme.textMuted}> · {preview}</Text>}
    </Box>
  );
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}
