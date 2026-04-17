import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { UserMsg } from "../state.js";
import { useTheme } from "../theme.js";

export function UserMessage({ msg }: { msg: UserMsg }): ReactNode {
  const theme = useTheme();
  const lines = msg.text.split("\n");
  return (
    <Box marginBottom={1}>
      <Text color={theme.textMuted}>{"> "}</Text>
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i} color={theme.user}>
            {line || " "}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
