import { Box, Text } from "ink";
import { useEffect, useState, type ReactNode } from "react";

import type { UiState } from "../state.js";
import { useTheme } from "../theme.js";
import { Spinner } from "./Spinner.js";

type Props = {
  readonly state: UiState;
};

/**
 * Inline activity indicator rendered directly above the input prompt so the
 * user always sees what the agent is doing, even when the message history
 * has scrolled past. Plain single-line row (no border) — visibility comes
 * from the spinner, bold primary-coloured label and elapsed timer.
 */
export function ActivityLine({ state }: Props): ReactNode {
  const theme = useTheme();
  const compacting = state.compaction !== null;
  const active = compacting || state.isTurnActive || state.isAssistantStreaming;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  if (!active) return null;

  const label = resolveLabel(state);
  const elapsed = formatElapsed(state);
  const cancelHint = compacting ? "" : "   esc to cancel";
  return (
    <Box marginTop={1} marginBottom={1} flexDirection="row">
      <Spinner color={theme.primary} />
      <Text color={theme.primary} bold>
        {"  "}
        {label}
      </Text>
      {elapsed && (
        <Text color={theme.textMuted}>
          {"  "}
          {elapsed}
        </Text>
      )}
      {cancelHint && <Text color={theme.textDim}>{cancelHint}</Text>}
    </Box>
  );
}

function resolveLabel(state: UiState): string {
  if (state.compaction) {
    const reason = state.compaction.reason === "manual" ? "manually" : "automatically";
    return `Compacting context ${reason} · ${state.compaction.phase}`;
  }
  const activeTool = findActiveTool(state);
  if (activeTool) return `Running ${activeTool}`;
  if (state.isAssistantStreaming) return "Thinking";
  return "Working";
}

function findActiveTool(state: UiState): string | null {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const m = state.messages[i];
    if (m?.kind === "tool" && (m.status === "pending" || m.status === "running")) {
      return m.name;
    }
  }
  return null;
}

function formatElapsed(state: UiState): string | null {
  const start = state.compaction?.startedAt ?? state.turnStartedAt;
  if (!start) return null;
  const ms = Date.now() - start;
  if (ms < 1000) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
