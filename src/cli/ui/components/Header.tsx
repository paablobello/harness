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
          ▍
        </Text>
        <Text bold color={theme.text}>
          {" harness"}
        </Text>
        <Text color={theme.textMuted}>
          {"   "}
          {session.adapter.name}:{session.adapter.model} · {session.permissionMode} · {tools}
        </Text>
      </Box>
      <Box>
        <Text color={theme.textDim}>
          {"  "}
          {session.cwd} · {log}
        </Text>
      </Box>
      <Box>
        <Text color={theme.textDim}>
          {"  "}
          <Text color={theme.primary}>/help</Text> for commands · Esc to cancel · Ctrl+C twice to
          exit
        </Text>
      </Box>
    </Box>
  );
}
