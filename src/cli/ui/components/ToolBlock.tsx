import { highlight, supportsLanguage } from "cli-highlight";
import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { ToolMsg } from "../state.js";
import { useTheme, type Theme } from "../theme.js";
import { DiffView } from "./DiffView.js";
import { Spinner } from "./Spinner.js";

const DEFAULT_MAX_LINES = 8;

type Props = {
  readonly msg: ToolMsg;
  readonly focused: boolean;
  readonly details: boolean;
  readonly connector?: boolean;
};

export function ToolBlock({ msg, focused, details, connector = false }: Props): ReactNode {
  const theme = useTheme();
  const expanded = msg.expanded || details;
  const summary = formatInputSummary(msg.name, msg.input);
  const hasOutput = (msg.status === "ok" || msg.status === "fail") && msg.output.length > 0;
  const showJson = details;

  return (
    <Box flexDirection="column" marginBottom={connector ? 0 : 1}>
      <Box>
        <StatusBadge status={msg.status} />
        <Text> </Text>
        <Text color={focused ? theme.primary : theme.text} bold={focused}>
          {msg.name}
        </Text>
        {summary && (
          <>
            <Text color={theme.textMuted}>{"  "}</Text>
            <Text color={theme.textMuted}>{summary}</Text>
          </>
        )}
        {msg.status === "ok" || msg.status === "fail"
          ? msg.durationMs !== undefined && (
              <Text color={theme.textDim}>{"  "}({formatDuration(msg.durationMs)})</Text>
            )
          : null}
      </Box>
      {showJson &&
        safeJson(msg.input)
          .split("\n")
          .map((line, i) => (
            <Box key={`j${i}`}>
              <Text color={theme.accentDim}>{"│ "}</Text>
              <Text color={theme.textMuted}>{line || " "}</Text>
            </Box>
          ))}
      {!hasOutput && msg.status === "running" && msg.streamingOutput && (
        <StreamingOutput text={msg.streamingOutput} expanded={expanded} />
      )}
      {hasOutput && (
        <ToolOutput
          msg={msg}
          expanded={expanded}
          statusColor={colorForStatus(msg.status, theme)}
        />
      )}
      {connector && (
        <Box>
          <Text color={theme.accentDim}>{"│"}</Text>
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
  if (!output) return null;

  if (msg.status === "fail") {
    const allLines = output.split("\n");
    const visible = expanded ? allLines : allLines.slice(0, 2);
    const rest = allLines.length - visible.length;
    return (
      <>
        {visible.map((line, i) => (
          <Box key={i}>
            <Text color={theme.accentDim}>{"│ "}</Text>
            <Text color={statusColor}>{line || " "}</Text>
          </Box>
        ))}
        {rest > 0 && (
          <Box>
            <Text color={theme.accentDim}>{"│ "}</Text>
            <Text color={theme.textDim}>… +{rest} more lines (Ctrl+O to expand)</Text>
          </Box>
        )}
      </>
    );
  }

  if (isDiffOutput(msg)) {
    const { header, body } = splitDiff(output);
    return (
      <>
        {header && (
          <Box>
            <Text color={theme.accentDim}>{"│ "}</Text>
            <Text color={theme.textMuted}>{header}</Text>
          </Box>
        )}
        {body && <DiffView diff={body} expanded={expanded} />}
      </>
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
    <>
      {renderedLines.map((line, i) => (
        <Box key={i}>
          <Text color={theme.accentDim}>{"│ "}</Text>
          <Text color={theme.textMuted}>{line || " "}</Text>
        </Box>
      ))}
      {rest > 0 && (
        <Box>
          <Text color={theme.accentDim}>{"│ "}</Text>
          <Text color={theme.textDim}>
            … +{rest} more line{rest === 1 ? "" : "s"} (Ctrl+O to expand)
          </Text>
        </Box>
      )}
    </>
  );
}

function StreamingOutput({
  text,
  expanded,
}: {
  readonly text: string;
  readonly expanded: boolean;
}): ReactNode {
  const theme = useTheme();
  const lines = text.split("\n");
  // Tail-bias the live view: most recent N lines (default 6 collapsed, all expanded).
  const visible = expanded ? lines : lines.slice(-6);
  const hidden = lines.length - visible.length;
  return (
    <>
      {hidden > 0 && (
        <Box>
          <Text color={theme.accentDim}>{"│ "}</Text>
          <Text color={theme.textDim}>… +{hidden} earlier line(s)</Text>
        </Box>
      )}
      {visible.map((line, i) => (
        <Box key={`s${i}`}>
          <Text color={theme.accentDim}>{"│ "}</Text>
          <Text color={theme.textMuted}>{line || " "}</Text>
        </Box>
      ))}
    </>
  );
}

function StatusBadge({ status }: { status: ToolMsg["status"] }): ReactNode {
  const theme = useTheme();
  switch (status) {
    case "pending":
      return <Text color={theme.textMuted}>○</Text>;
    case "running":
      return <Spinner color={theme.toolRunning} />;
    case "ok":
      return <Text color={theme.success}>●</Text>;
    case "fail":
      return <Text color={theme.error}>●</Text>;
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
      return `$ ${truncateLine(o["command"], 120)}`;
    }
    if (typeof o["path"] === "string") return o["path"];
    if (typeof o["pattern"] === "string") return `/${o["pattern"]}/`;
    if (tool === "apply_patch" && typeof o["patch"] === "string") {
      return `${countPatchFiles(o["patch"])} file(s)`;
    }
    if (typeof o["prompt"] === "string") return truncateLine(o["prompt"], 100);
  }
  try {
    return truncateLine(JSON.stringify(input) ?? "", 120);
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
  if (msg.name === "apply_patch" || msg.name === "edit" || msg.name === "edit_file") {
    return /@@.*@@/.test(msg.output) || /^[+-]/m.test(msg.output);
  }
  if (/^@@.*@@/m.test(msg.output)) return true;
  if (/^---\s.*\n\+\+\+\s/m.test(msg.output)) return true;
  return false;
}

function splitDiff(output: string): { header: string; body: string } {
  const lines = output.split("\n");
  const hunkIdx = lines.findIndex((l) => l.startsWith("@@"));
  if (hunkIdx <= 0) return { header: "", body: output };
  return {
    header: lines.slice(0, hunkIdx).join("\n").trim(),
    body: lines.slice(hunkIdx).join("\n"),
  };
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
