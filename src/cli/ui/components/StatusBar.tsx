import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { UiState } from "../state.js";
import { useTheme } from "../theme.js";
import { Spinner } from "./Spinner.js";

export function StatusBar({ state }: { state: UiState }): ReactNode {
  const theme = useTheme();
  const { session, stats, isAssistantStreaming, isTurnActive } = state;
  const cost = stats.costUsd > 0 ? `$${stats.costUsd.toFixed(4)}` : "$0";
  const tokens = formatTokens(stats.tokensIn, stats.tokensOut);
  const parts: ReactNode[] = [
    <Text key="mode" color={theme.textMuted}>
      {session.permissionMode}
    </Text>,
    sep(theme.textMuted, 0),
    <Text key="model" color={theme.textMuted}>
      {session.adapter.name}:{session.adapter.model}
    </Text>,
  ];
  if (stats.turns > 0) {
    parts.push(sep(theme.textMuted, 1));
    parts.push(
      <Text key="tokens" color={theme.textMuted}>
        {tokens}
      </Text>,
    );
    parts.push(sep(theme.textMuted, 2));
    parts.push(
      <Text key="cost" color={theme.textMuted}>
        {cost}
      </Text>,
    );
  }
  if (stats.toolCalls > 0) {
    parts.push(sep(theme.textMuted, 3));
    parts.push(
      <Text key="tools" color={theme.textMuted}>
        {stats.toolCalls}
        {stats.toolFailures > 0 ? `/${stats.toolFailures} fail` : ""} tools
      </Text>,
    );
  }
  return (
    <Box paddingX={1}>
      {parts}
      {(isAssistantStreaming || isTurnActive) && (
        <>
          {sep(theme.textMuted, 99)}
          <Spinner color={theme.toolRunning} />
          <Text color={theme.textMuted}>
            {" "}
            {isAssistantStreaming ? "thinking" : "working"}
          </Text>
        </>
      )}
    </Box>
  );
}

function sep(color: string, key: number): ReactNode {
  return (
    <Text key={`s${key}`} color={color}>
      {" · "}
    </Text>
  );
}

function formatTokens(input: number, output: number): string {
  return `${compact(input)}→${compact(output)}`;
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
