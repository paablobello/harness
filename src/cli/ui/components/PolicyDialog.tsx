import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";

import type { PolicyRequest } from "../state.js";
import { useTheme } from "../theme.js";

type Props = {
  readonly request: PolicyRequest;
  readonly onResolve: (allow: boolean) => void;
};

export function PolicyDialog({ request, onResolve }: Props): ReactNode {
  const theme = useTheme();

  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === "y" || key.return) onResolve(true);
    else if (ch === "n" || key.escape) onResolve(false);
  });

  const summary = summarizeInput(request.tool, request.input);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.status.ask}
      paddingX={1}
      marginY={1}
    >
      <Box>
        <Text color={theme.status.ask} bold>
          ? Permission required
        </Text>
      </Box>
      <Box>
        <Text color={theme.textMuted}>tool </Text>
        <Text bold>{request.tool}</Text>
      </Box>
      {summary && (
        <Box>
          <Text color={theme.textMuted}>input </Text>
          <Text>{summary}</Text>
        </Box>
      )}
      {request.reason && (
        <Box>
          <Text color={theme.textMuted}>reason </Text>
          <Text>{request.reason}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.success} bold>
          [Y]
        </Text>
        <Text color={theme.textMuted}> allow </Text>
        <Text color={theme.error} bold>
          [N]
        </Text>
        <Text color={theme.textMuted}> deny (Enter = allow · Esc = deny)</Text>
      </Box>
    </Box>
  );
}

function summarizeInput(tool: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (tool === "run_command" && typeof o["command"] === "string") return `$ ${o["command"]}`;
    if (typeof o["path"] === "string") return `path: ${o["path"]}`;
  }
  try {
    const str = JSON.stringify(input);
    return str ? str.slice(0, 200) : "";
  } catch {
    return "";
  }
}
