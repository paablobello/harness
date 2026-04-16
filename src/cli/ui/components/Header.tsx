import { Box, Text } from "ink";
import { basename, relative } from "node:path";
import type { ReactNode } from "react";

import type { SessionMeta } from "../state.js";
import { useTheme } from "../theme.js";

type Props = {
  readonly session: SessionMeta;
};

export function Header({ session }: Props): ReactNode {
  const theme = useTheme();
  const repo = basename(session.cwd) || session.cwd;
  const log = relative(session.cwd, session.logPath) || session.logPath;
  const config = session.configPath
    ? relative(session.cwd, session.configPath) || session.configPath
    : "none";
  const tools = session.withTools ? `${session.toolCount} on` : "off";
  const label = session.mode === "chat" ? "interactive" : "one-shot";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      borderDimColor
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text bold color={theme.primary}>
          Harness
        </Text>
        <Text color={theme.textMuted}> · </Text>
        <Text color={theme.textMuted}>{label}</Text>
        <Text color={theme.textMuted}> · </Text>
        <Text color={theme.primary}>
          {session.adapter.name}:{session.adapter.model}
        </Text>
      </Box>
      <Box>
        <Text color={theme.textMuted}>repo </Text>
        <Text>{repo}</Text>
      </Box>
      <Box>
        <Text color={theme.textMuted}>mode </Text>
        <Text>{session.permissionMode}</Text>
        <Text color={theme.textMuted}> tools </Text>
        <Text>{tools}</Text>
      </Box>
      <Box>
        <Text color={theme.textMuted}>cwd </Text>
        <Text>{session.cwd}</Text>
      </Box>
      <Box>
        <Text color={theme.textMuted}>config </Text>
        <Text>{config}</Text>
      </Box>
      <Box>
        <Text color={theme.textMuted}>log </Text>
        <Text>{log}</Text>
      </Box>
      {session.mode === "chat" && (
        <Box marginTop={1}>
          <Text color={theme.textMuted}>/help for commands · Ctrl+C twice to quit</Text>
        </Box>
      )}
    </Box>
  );
}
