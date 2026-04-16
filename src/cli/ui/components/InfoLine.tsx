import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { InfoMsg } from "../state.js";
import { useTheme } from "../theme.js";

export function InfoLine({ msg }: { msg: InfoMsg }): ReactNode {
  const theme = useTheme();
  const color =
    msg.level === "error" ? theme.error : msg.level === "warn" ? theme.warning : theme.textMuted;
  return (
    <Box marginBottom={1}>
      <Text color={color}>{msg.text}</Text>
    </Box>
  );
}
