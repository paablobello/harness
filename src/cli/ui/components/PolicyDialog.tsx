import { Box, Text, useInput } from "ink";
import { useState, type ReactNode } from "react";

import type { PolicyRequest } from "../state.js";
import { useTheme, type Theme } from "../theme.js";
import { DiffView } from "./DiffView.js";

type Props = {
  readonly request: PolicyRequest;
  readonly onResolve: (allow: boolean) => void;
  /**
   * Optional — if present, the dialog offers an "always allow for session"
   * choice. When the user picks it, this is called before resolving so the
   * caller can register a runtime allow rule for the tool.
   */
  readonly onAlwaysAllow?: (tool: string) => void;
};

/**
 * Variant per tool:
 *   apply_patch / edit_file → P4 diff-first
 *   run_command         → P3 choice list (↑↓ + enter)
 *   everything else     → P1 inline rail
 *
 * Shared keymap: y allow · n deny · a always (when supported) · Esc/n cancel.
 */
export function PolicyDialog({ request, onResolve, onAlwaysAllow }: Props): ReactNode {
  const theme = useTheme();
  const [focus, setFocus] = useState(0);

  const isEdit =
    request.tool === "apply_patch" || request.tool === "edit_file" || request.tool === "edit";
  const isRunCmd = request.tool === "run_command";
  const canAlways = typeof onAlwaysAllow === "function";

  const confirm = (choice: "allow" | "deny" | "always"): void => {
    if (choice === "always" && canAlways) onAlwaysAllow!(request.tool);
    onResolve(choice !== "deny");
  };

  const choiceCount = isRunCmd ? (canAlways ? 3 : 2) : 0;

  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (isRunCmd) {
      if (key.upArrow) {
        setFocus((f) => Math.max(0, f - 1));
        return;
      }
      if (key.downArrow) {
        setFocus((f) => Math.min(choiceCount - 1, f + 1));
        return;
      }
      if (key.return) {
        const decision = runCmdDecisionAt(focus, canAlways);
        confirm(decision);
        return;
      }
    }
    if (ch === "y") confirm("allow");
    else if (ch === "a" && canAlways) confirm("always");
    else if (ch === "n" || key.escape) confirm("deny");
    else if (key.return && !isRunCmd) confirm("allow");
  });

  const target = describeTarget(request.tool, request.input);

  if (isEdit)
    return <DiffFirst request={request} target={target} canAlways={canAlways} theme={theme} />;
  if (isRunCmd)
    return (
      <ChoiceList
        request={request}
        target={target}
        canAlways={canAlways}
        focus={focus}
        theme={theme}
      />
    );
  return <InlineRail request={request} target={target} canAlways={canAlways} theme={theme} />;
}

function runCmdDecisionAt(idx: number, canAlways: boolean): "allow" | "always" | "deny" {
  if (idx === 0) return "allow";
  if (idx === 1) return canAlways ? "always" : "deny";
  return "deny";
}

// ────────────────────────────────────────────────────────────────────────────
// P4 — diff-first (apply_patch / edit)
// ────────────────────────────────────────────────────────────────────────────
function DiffFirst({
  request,
  target,
  canAlways,
  theme,
}: {
  readonly request: PolicyRequest;
  readonly target: string;
  readonly canAlways: boolean;
  readonly theme: Theme;
}): ReactNode {
  const patch = extractPatch(request.input);
  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color={theme.primary} bold>
          ?
        </Text>
        <Text bold> {request.tool}</Text>
        {target && (
          <>
            <Text color={theme.textDim}>{" → "}</Text>
            <Text color={theme.accentSoft}>{target}</Text>
          </>
        )}
      </Box>
      {patch && (
        <Box flexDirection="column" marginTop={1}>
          <DiffView diff={patch} expanded={false} maxLines={16} prefix />
        </Box>
      )}
      {request.reason && (
        <Box marginTop={1}>
          <Text color={theme.accentDim}>{"│ "}</Text>
          <Text color={theme.textMuted}>{request.reason}</Text>
        </Box>
      )}
      <HotkeyRail theme={theme} canAlways={canAlways} allowLabel="apply" denyLabel="deny" />
    </Box>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// P3 — choice list (run_command)
// ────────────────────────────────────────────────────────────────────────────
function ChoiceList({
  request,
  target,
  canAlways,
  focus,
  theme,
}: {
  readonly request: PolicyRequest;
  readonly target: string;
  readonly canAlways: boolean;
  readonly focus: number;
  readonly theme: Theme;
}): ReactNode {
  const choices: { key: string; label: string; note: string }[] = [
    { key: "y", label: "allow once", note: "run this command, ask again next time" },
  ];
  if (canAlways) {
    choices.push({
      key: "a",
      label: "allow for session",
      note: "run and stop asking for run_command",
    });
  }
  choices.push({ key: "n", label: "deny", note: "skip this call, continue turn" });

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color={theme.primary} bold>
          ?
        </Text>
        <Text bold> {request.tool}</Text>
        <Text color={theme.textDim}>{" wants to run "}</Text>
        <Text color={theme.accentSoft}>{target || "…"}</Text>
      </Box>
      {request.reason && (
        <Box>
          <Text color={theme.textDim}>{"  "}</Text>
          <Text color={theme.textMuted}>{request.reason}</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        {choices.map((c, i) => {
          const selected = i === focus;
          return (
            <Box key={c.key}>
              <Text color={selected ? theme.primary : theme.textDim} bold={selected}>
                {selected ? " ❯ " : "   "}
              </Text>
              <Text color={theme.primary} bold>
                {c.key}
              </Text>
              <Text color={selected ? theme.text : theme.textMuted} bold={selected}>
                {" "}
                {c.label}
              </Text>
              <Text color={theme.textDim}>
                {"    "}
                {c.note}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.textDim}> ↑↓ move · enter confirm · Esc cancel turn</Text>
      </Box>
    </Box>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// P1 — inline rail (default)
// ────────────────────────────────────────────────────────────────────────────
function InlineRail({
  request,
  target,
  canAlways,
  theme,
}: {
  readonly request: PolicyRequest;
  readonly target: string;
  readonly canAlways: boolean;
  readonly theme: Theme;
}): ReactNode {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.primary} bold>
          ?
        </Text>
        <Text bold> {request.tool}</Text>
        {target && (
          <>
            <Text color={theme.textDim}>{"  "}</Text>
            <Text color={theme.textMuted}>{target}</Text>
          </>
        )}
        <Text color={theme.textDim}>{"   "}</Text>
        <Text color={theme.accentSoft} italic>
          waiting for approval
        </Text>
      </Box>
      {request.reason && (
        <Box>
          <Text color={theme.accentDim}>{"│ "}</Text>
          <Text color={theme.textMuted}>{request.reason}</Text>
        </Box>
      )}
      <HotkeyRail theme={theme} canAlways={canAlways} allowLabel="allow" denyLabel="deny" />
    </Box>
  );
}

function HotkeyRail({
  theme,
  canAlways,
  allowLabel,
  denyLabel,
}: {
  readonly theme: Theme;
  readonly canAlways: boolean;
  readonly allowLabel: string;
  readonly denyLabel: string;
}): ReactNode {
  return (
    <Box>
      <Text color={theme.accentDim}>{"│ "}</Text>
      <Hotkey char="y" label={allowLabel} theme={theme} />
      <Text color={theme.textDim}>{"  ·  "}</Text>
      <Hotkey char="n" label={denyLabel} theme={theme} />
      {canAlways && (
        <>
          <Text color={theme.textDim}>{"  ·  "}</Text>
          <Hotkey char="a" label="always allow" theme={theme} />
        </>
      )}
      <Text color={theme.textDim}>{"  ·  Esc cancel"}</Text>
    </Box>
  );
}

function Hotkey({
  char,
  label,
  theme,
}: {
  readonly char: string;
  readonly label: string;
  readonly theme: Theme;
}): ReactNode {
  return (
    <>
      <Text color={theme.primary} bold>
        {char}
      </Text>
      <Text color={theme.text}> {label}</Text>
    </>
  );
}

function describeTarget(tool: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (tool === "run_command" && typeof o["command"] === "string") {
      return `$ ${truncate(o["command"], 120)}`;
    }
    if (typeof o["path"] === "string") return o["path"];
    const patchText =
      typeof o["patch"] === "string"
        ? o["patch"]
        : typeof o["unified_diff"] === "string"
          ? o["unified_diff"]
          : null;
    if (tool === "apply_patch" && patchText) {
      const m = patchText.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m);
      return m?.[1] ?? "patch";
    }
    if (typeof o["pattern"] === "string") return `/${o["pattern"]}/`;
  }
  return "";
}

function extractPatch(input: unknown): string | null {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o["patch"] === "string") return o["patch"];
    if (typeof o["diff"] === "string") return o["diff"];
    if (typeof o["unified_diff"] === "string") return o["unified_diff"];
    if (typeof o["new_str"] === "string" && typeof o["old_str"] === "string") {
      // Synthesize a tiny diff so edit_file can flow through DiffView too.
      return synthesizeEditDiff(o["old_str"], o["new_str"]);
    }
  }
  return null;
}

function synthesizeEditDiff(oldStr: string, newStr: string): string {
  const minus = oldStr
    .split("\n")
    .map((l) => `-${l}`)
    .join("\n");
  const plus = newStr
    .split("\n")
    .map((l) => `+${l}`)
    .join("\n");
  return `${minus}\n${plus}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
