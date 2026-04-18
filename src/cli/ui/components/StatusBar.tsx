import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { classifyContext } from "../../../runtime/context-window.js";
import { hasPricing } from "../../../runtime/cost.js";
import type { UiState } from "../state.js";
import { useTheme } from "../theme.js";

export function StatusBar({ state }: { state: UiState }): ReactNode {
  const theme = useTheme();
  const { session, stats } = state;
  const modelPriced = hasPricing(session.adapter.model);
  const cost = modelPriced ? `$${stats.costUsd.toFixed(4)}` : "cost n/a";
  const tokens = formatTokens(stats.tokensIn, stats.tokensOut);
  const ctx = classifyContext(state.usage.lastInputTokens, session.adapter.model);
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
  if (ctx.ratio !== undefined && ctx.zone !== "unknown") {
    const color =
      ctx.zone === "critical"
        ? theme.error
        : ctx.zone === "warn"
          ? theme.warning
          : theme.textMuted;
    parts.push(sep(theme.textMuted, 5));
    parts.push(
      <Text key="ctx" color={color}>
        ctx {Math.round(ctx.ratio * 100)}%
      </Text>,
    );
  }
  if (stats.toolCalls > 0) {
    parts.push(sep(theme.textMuted, 3));
    parts.push(
      <Text key="tools" color={theme.textMuted}>
        {stats.toolCalls} tools
      </Text>,
    );
    if (stats.toolFailures > 0) {
      parts.push(sep(theme.textMuted, 4));
      parts.push(
        <Text key="tool-failures" color={theme.error}>
          {stats.toolFailures} failed
        </Text>,
      );
    }
  }
  if (state.compaction) {
    parts.push(sep(theme.textMuted, 6));
    parts.push(
      <Text key="compacting" color={theme.primary}>
        compacting…
      </Text>,
    );
  }
  return <Box paddingX={1}>{parts}</Box>;
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
