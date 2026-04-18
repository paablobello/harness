import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { UserMsg } from "../state.js";
import { useTheme } from "../theme.js";

export function UserMessage({ msg }: { msg: UserMsg }): ReactNode {
  const theme = useTheme();
  const lines = msg.text.split("\n");
  const bg = theme.userBg ?? theme.border;
  return (
    <Box marginBottom={1} marginTop={1} flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i} backgroundColor={bg} paddingX={1} width="100%">
          <Text color={theme.textMuted} backgroundColor={bg}>
            {i === 0 ? "> " : "  "}
          </Text>
          <Text color={theme.text} backgroundColor={bg}>
            {line || " "}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
