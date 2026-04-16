import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { UserMsg } from "../state.js";
import { useTheme } from "../theme.js";

export function UserMessage({ msg }: { msg: UserMsg }): ReactNode {
  const theme = useTheme();
  const lines = msg.text.split("\n");
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Text color={theme.user} bold>
        {"› "}
      </Text>
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
    </Box>
  );
}
