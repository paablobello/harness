import { Box, Text } from "ink";
import { relative } from "node:path";
import type { ReactNode } from "react";

import type { SessionMeta } from "../state.js";
import { useTheme } from "../theme.js";

type Props = {
  readonly session: SessionMeta;
};

export function Header({ session }: Props): ReactNode {
  const theme = useTheme();
  const log = relative(session.cwd, session.logPath) || session.logPath;
  const tools = session.withTools ? `${session.toolCount} tools` : "no tools";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color={theme.primary}>
          Harness
        </Text>
        <Text color={theme.textMuted}>
          {"  "}
          {session.adapter.name}:{session.adapter.model} · {session.permissionMode} · {tools}
        </Text>
      </Box>
      <Box>
        <Text color={theme.textMuted}>
          {session.cwd}
        </Text>
      </Box>
      <Box>
        <Text color={theme.textMuted}>
          {log} · <Text color={theme.primary}>/help</Text> for commands
        </Text>
      </Box>
    </Box>
  );
}
