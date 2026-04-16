import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { UiState } from "../state.js";
import { useTheme } from "../theme.js";
import { Spinner } from "./Spinner.js";

export function StatusBar({ state }: { state: UiState }): ReactNode {
  const theme = useTheme();
  const { session, stats, isAssistantStreaming, isTurnActive, themeName } = state;
  const cost = stats.costUsd > 0 ? `$${stats.costUsd.toFixed(4)}` : "$0";
  const tokens = `${stats.tokensIn}→${stats.tokensOut}`;
  return (
    <Box borderStyle="round" borderColor={theme.border} borderDimColor paddingX={1}>
      <Text color={theme.primary} bold>
        [{session.permissionMode}]
      </Text>
      <Text color={theme.textMuted}> · </Text>
      <Text>
        {session.adapter.name}:{session.adapter.model}
      </Text>
      <Text color={theme.textMuted}> · turns </Text>
      <Text>{stats.turns}</Text>
      <Text color={theme.textMuted}> · tokens </Text>
      <Text>{tokens}</Text>
      <Text color={theme.textMuted}> · cost </Text>
      <Text>{cost}</Text>
      <Text color={theme.textMuted}> · tools </Text>
      <Text>
        {stats.toolCalls}
        {stats.toolFailures > 0 ? (
          <>
            /<Text color={theme.error}>{stats.toolFailures}</Text>
          </>
        ) : null}
      </Text>
      <Text color={theme.textMuted}> · theme </Text>
      <Text>{themeName}</Text>
      {(isAssistantStreaming || isTurnActive) && (
        <>
          <Text color={theme.textMuted}> · </Text>
          <Spinner color={theme.toolRunning} />
          <Text color={theme.textMuted}>{isAssistantStreaming ? " thinking" : " working"}</Text>
        </>
      )}
    </Box>
  );
}
