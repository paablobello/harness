import { Box, Text } from "ink";
import { relative } from "node:path";
import type { ReactNode } from "react";

import { SLASH_COMMANDS } from "../commands.js";
import type { Overlay as OverlayState, UiState } from "../state.js";
import { useTheme } from "../theme.js";

type Props = {
  readonly overlay: OverlayState;
  readonly state: UiState;
  readonly tools?: readonly { name: string; risk: string; source: string; description: string }[];
};

export function Overlay({ overlay, state, tools }: Props): ReactNode {
  const theme = useTheme();
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.primary}
      paddingX={1}
      marginY={1}
    >
      {renderBody(overlay, state, theme, tools)}
      <Box marginTop={1}>
        <Text color={theme.textMuted}>Esc to close</Text>
      </Box>
    </Box>
  );
}

function renderBody(
  overlay: OverlayState,
  state: UiState,
  theme: ReturnType<typeof useTheme>,
  tools?: readonly { name: string; risk: string; source: string; description: string }[],
): ReactNode {
  switch (overlay.type) {
    case "help":
      return (
        <Box flexDirection="column">
          <Text bold color={theme.primary}>
            Commands
          </Text>
          {SLASH_COMMANDS.map((c) => (
            <Box key={c.id}>
              <Box width={12}>
                <Text color={theme.primary}>{c.title}</Text>
              </Box>
              <Text color={theme.textMuted}>{c.description}</Text>
            </Box>
          ))}
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.textMuted}>
              Enter to send · \ + Enter for newline · Ctrl+E open $EDITOR · Ctrl+R history search
            </Text>
            <Text color={theme.textMuted}>
              Ctrl+O toggle expand on focused tool · Shift+Tab focus next tool
            </Text>
          </Box>
        </Box>
      );
    case "status":
      return (
        <Box flexDirection="column">
          <Text bold color={theme.primary}>
            Status
          </Text>
          <Kv
            label="model"
            value={`${state.session.adapter.name}:${state.session.adapter.model}`}
          />
          <Kv label="cwd" value={state.session.cwd} />
          <Kv label="mode" value={state.session.permissionMode} />
          <Kv
            label="tools"
            value={state.session.withTools ? `${state.session.toolCount} on` : "off"}
          />
          <Kv label="details" value={state.details ? "on" : "off"} />
          <Kv label="config" value={state.session.configPath ?? "none"} />
          <Kv
            label="log"
            value={relative(state.session.cwd, state.session.logPath) || state.session.logPath}
          />
        </Box>
      );
    case "model":
      return (
        <Box flexDirection="column">
          <Text bold color={theme.primary}>
            Model
          </Text>
          <Text>
            {state.session.adapter.name}:{state.session.adapter.model}
          </Text>
          <Text color={theme.textMuted}>
            Restart with --provider/--model to change it for the next session.
          </Text>
        </Box>
      );
    case "tools":
      return (
        <Box flexDirection="column">
          <Text bold color={theme.primary}>
            Tools
          </Text>
          {(tools ?? []).length === 0 ? (
            <Text color={theme.textMuted}>No tools registered.</Text>
          ) : (
            (tools ?? []).map((t) => (
              <Box key={t.name}>
                <Box width={16}>
                  <Text color={theme.primary}>{t.name}</Text>
                </Box>
                <Box width={8}>
                  <Text color={riskColor(t.risk, theme)}>{t.risk}</Text>
                </Box>
                <Text color={theme.textMuted}>
                  {t.source} · {firstLine(t.description, 80)}
                </Text>
              </Box>
            ))
          )}
        </Box>
      );
    case "details":
      return (
        <Box flexDirection="column">
          <Text bold color={theme.primary}>
            Details {state.details ? "enabled" : "disabled"}
          </Text>
          <Text color={theme.textMuted}>
            {state.details
              ? "Tool blocks show input JSON and expanded output."
              : "Tool blocks are back to compact summaries."}
          </Text>
        </Box>
      );
    case "log":
      return (
        <Box flexDirection="column">
          <Text bold color={theme.primary}>
            Events log
          </Text>
          <Text>{state.session.logPath}</Text>
        </Box>
      );
    case "message":
      return (
        <Box flexDirection="column">
          <Text
            bold
            color={
              overlay.level === "error"
                ? theme.error
                : overlay.level === "warn"
                  ? theme.warning
                  : theme.primary
            }
          >
            {overlay.level}
          </Text>
          <Text>{overlay.text}</Text>
        </Box>
      );
    default:
      return null;
  }
}

function Kv({ label, value }: { label: string; value: string }): ReactNode {
  const theme = useTheme();
  return (
    <Box>
      <Box width={9}>
        <Text color={theme.textMuted}>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}

function riskColor(risk: string, theme: ReturnType<typeof useTheme>): string {
  if (risk === "read") return theme.success;
  if (risk === "write") return theme.warning;
  if (risk === "execute") return theme.error;
  return theme.textMuted;
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}
