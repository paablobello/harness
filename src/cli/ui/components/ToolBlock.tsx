import { highlight, supportsLanguage } from "cli-highlight";
import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { ToolMsg } from "../state.js";
import { useTheme, type Theme } from "../theme.js";
import { DiffView } from "./DiffView.js";
import { Spinner } from "./Spinner.js";

const DEFAULT_MAX_LINES = 10;

type Props = {
  readonly msg: ToolMsg;
  readonly focused: boolean;
  readonly details: boolean;
};

export function ToolBlock({ msg, focused, details }: Props): ReactNode {
  const theme = useTheme();
  const borderColor = focused ? theme.borderFocus : theme.border;
  const expanded = msg.expanded || details;
  const statusColor = colorForStatus(msg.status, theme);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      borderDimColor={!focused}
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <StatusBadge status={msg.status} />
        <Text> </Text>
        <Text bold color={theme.tool}>
          {msg.name}
        </Text>
        <Text color={theme.textMuted}>
          {formatInputSummary(msg.name, msg.input)
            ? `  ${formatInputSummary(msg.name, msg.input)}`
            : ""}
        </Text>
        {msg.status !== "running" && msg.status !== "pending" && msg.durationMs !== undefined && (
          <Text color={theme.textMuted}> · {formatDuration(msg.durationMs)}</Text>
        )}
      </Box>
      {details && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.textMuted}>input</Text>
          <Text color={theme.textMuted}>{safeJson(msg.input)}</Text>
        </Box>
      )}
      {(msg.status === "ok" || msg.status === "fail") && (
        <ToolOutput msg={msg} expanded={expanded} statusColor={statusColor} />
      )}
      {focused && (
        <Box marginTop={1}>
          <Text color={theme.textMuted}>
            Ctrl+O {msg.expanded ? "collapse" : "expand"} · Shift+Tab focus next
          </Text>
        </Box>
      )}
    </Box>
  );
}

function ToolOutput({
  msg,
  expanded,
  statusColor,
}: {
  readonly msg: ToolMsg;
  readonly expanded: boolean;
  readonly statusColor: string;
}): ReactNode {
  const theme = useTheme();
  const output = msg.output;
  if (!output) {
    return (
      <Box>
        <Text color={theme.textMuted}>(no output)</Text>
      </Box>
    );
  }

  if (msg.status === "fail") {
    const allLines = output.split("\n");
    const visible = expanded ? allLines : allLines.slice(0, 2);
    const rest = allLines.length - visible.length;
    return (
      <Box flexDirection="column" marginTop={1}>
        {visible.map((line, i) => (
          <Text key={i} color={statusColor}>
            {line || " "}
          </Text>
        ))}
        {rest > 0 && <Text color={theme.textMuted}>… +{rest} more lines (Ctrl+O to expand)</Text>}
      </Box>
    );
  }

  if (isDiffOutput(msg)) {
    return (
      <Box marginTop={1}>
        <DiffView diff={output} expanded={expanded} />
      </Box>
    );
  }

  const language = languageForTool(msg);
  const lines = output.split("\n");
  const visible = expanded ? lines : lines.slice(0, DEFAULT_MAX_LINES);
  const rest = lines.length - visible.length;
  const body = visible.join("\n");
  const highlighted = language && supportsLanguage(language) ? safeHighlight(body, language) : body;
  const renderedLines = highlighted.split("\n");

  return (
    <Box flexDirection="column" marginTop={1}>
      {renderedLines.map((line, i) => (
        <Text key={i}>{line || " "}</Text>
      ))}
      {rest > 0 && (
        <Text color={theme.textMuted}>
          … +{rest} more line{rest === 1 ? "" : "s"} (Ctrl+O to expand)
        </Text>
      )}
    </Box>
  );
}

function StatusBadge({ status }: { status: ToolMsg["status"] }): ReactNode {
  const theme = useTheme();
  switch (status) {
    case "pending":
      return <Text color={theme.textMuted}>◌</Text>;
    case "running":
      return <Spinner color={theme.toolRunning} />;
    case "ok":
      return (
        <Text color={theme.success} bold>
          ✔
        </Text>
      );
    case "fail":
      return (
        <Text color={theme.error} bold>
          ✖
        </Text>
      );
    default:
      return <Text>·</Text>;
  }
}

function colorForStatus(status: ToolMsg["status"], theme: Theme): string {
  if (status === "ok") return theme.success;
  if (status === "fail") return theme.error;
  if (status === "running") return theme.toolRunning;
  return theme.textMuted;
}

export function formatInputSummary(tool: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (tool === "run_command" && typeof o["command"] === "string") {
      return `$ ${truncateLine(o["command"], 180)}`;
    }
    if (typeof o["path"] === "string") return o["path"];
    if (typeof o["pattern"] === "string") return `/${o["pattern"]}/`;
    if (tool === "apply_patch" && typeof o["patch"] === "string") {
      return `${countPatchFiles(o["patch"])} file(s)`;
    }
    if (typeof o["prompt"] === "string") return truncateLine(o["prompt"], 120);
  }
  try {
    return truncateLine(JSON.stringify(input) ?? "", 180);
  } catch {
    return "";
  }
}

function truncateLine(line: string, max: number): string {
  const single = line.replace(/\n/g, " ⏎ ");
  return single.length <= max ? single : single.slice(0, max - 1) + "…";
}

function countPatchFiles(patch: string): number {
  const matches = patch.match(/^\*\*\* (?:Add|Update|Delete) File: /gm);
  return matches?.length ?? 1;
}

function isDiffOutput(msg: ToolMsg): boolean {
  if (msg.name === "apply_patch" || msg.name === "edit") return true;
  if (/^---\s.*\n\+\+\+\s/m.test(msg.output)) return true;
  return false;
}

function languageForTool(msg: ToolMsg): string | undefined {
  if (msg.name === "read" || msg.name === "read_file") {
    const input = msg.input as Record<string, unknown> | undefined;
    const path = typeof input?.["path"] === "string" ? (input["path"] as string) : "";
    const ext = path.split(".").pop();
    return ext && ext !== path ? ext.toLowerCase() : undefined;
  }
  if (msg.name === "run_command") return "bash";
  return undefined;
}

function safeHighlight(text: string, lang: string): string {
  try {
    return highlight(text, { language: lang, ignoreIllegals: true });
  } catch {
    return text;
  }
}

function safeJson(value: unknown): string {
  try {
    const out = JSON.stringify(value, null, 2);
    return out ?? "";
  } catch {
    return String(value);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  return `${m.toFixed(1)}m`;
}
