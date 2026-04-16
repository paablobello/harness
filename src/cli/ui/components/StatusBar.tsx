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
  const toolSummary =
    stats.toolFailures > 0 ? `${stats.toolCalls}/${stats.toolFailures} fail` : `${stats.toolCalls}`;
  const status = [
    `[${session.permissionMode}]`,
    `${session.adapter.name}:${session.adapter.model}`,
    `turns ${stats.turns}`,
    `tokens ${tokens}`,
    `cost ${cost}`,
    `tools ${toolSummary}`,
    `theme ${themeName}`,
  ].join(" · ");

  return (
    <Box borderStyle="round" borderColor={theme.border} borderDimColor paddingX={1}>
      <Text color={theme.textMuted}>{status}</Text>
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
