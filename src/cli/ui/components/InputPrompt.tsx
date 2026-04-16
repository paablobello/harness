import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Box, Text, useInput, useStdin, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  dispatchSlash,
  filterCommands,
  isExitInput,
  isLikelyHarnessInvocation,
  type SlashCommand,
  type SlashCommandContext,
} from "../commands.js";
import { appendHistory } from "../history.js";
import type { Action } from "../state.js";
import { useTheme } from "../theme.js";
import { SuggestionsPanel } from "./SuggestionsPanel.js";

type Props = {
  readonly disabled: boolean;
  readonly history: readonly string[];
  readonly slashCtx: SlashCommandContext;
  readonly onSubmit: (text: string) => void;
  readonly onCancel: () => void;
  readonly onQuitSignal: () => void;
  readonly dispatch: (action: Action) => void;
};

export function InputPrompt({
  disabled,
  history,
  slashCtx,
  onSubmit,
  onCancel,
  onQuitSignal,
  dispatch,
}: Props): ReactNode {
  const theme = useTheme();
  const { stdout } = useStdout();
  const { setRawMode, isRawModeSupported } = useStdin();

  const [lines, setLines] = useState<string[]>([""]);
  const [row, setRow] = useState(0);
  const [col, setCol] = useState(0);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [draftBeforeHistory, setDraftBeforeHistory] = useState<string[] | null>(null);
  const [reverseSearch, setReverseSearch] = useState<{ query: string; idx: number } | null>(null);
  const editorRef = useRef(false);

  useEffect(() => {
    // Hint raw mode is desired; Ink manages it too, this is idempotent.
    if (isRawModeSupported) {
      setRawMode(true);
    }
  }, [isRawModeSupported, setRawMode]);

  const currentText = lines.join("\n");
  const trimmed = currentText.trim();
  const isSlashMode = trimmed.startsWith("/") && !currentText.includes("\n");
  const suggestions: readonly SlashCommand[] = useMemo(
    () => (isSlashMode ? filterCommands(trimmed) : []),
    [isSlashMode, trimmed],
  );

  useEffect(() => {
    if (suggestions.length === 0) setActiveSuggestion(0);
    else if (activeSuggestion >= suggestions.length) setActiveSuggestion(suggestions.length - 1);
  }, [suggestions, activeSuggestion]);

  const reverseMatches = useMemo(() => {
    if (!reverseSearch) return [] as readonly string[];
    const q = reverseSearch.query.toLowerCase();
    if (!q) return history;
    return history.filter((h) => h.toLowerCase().includes(q));
  }, [reverseSearch, history]);

  const resetInput = useCallback(() => {
    setLines([""]);
    setRow(0);
    setCol(0);
    setHistoryIdx(-1);
    setDraftBeforeHistory(null);
    setReverseSearch(null);
  }, []);

  const insertChar = useCallback(
    (ch: string) => {
      setLines((prev) => {
        const next = [...prev];
        const line = next[row] ?? "";
        next[row] = line.slice(0, col) + ch + line.slice(col);
        return next;
      });
      setCol((c) => c + ch.length);
    },
    [row, col],
  );

  const insertNewline = useCallback(() => {
    setLines((prev) => {
      const next = [...prev];
      const line = next[row] ?? "";
      next[row] = line.slice(0, col);
      next.splice(row + 1, 0, line.slice(col));
      return next;
    });
    setRow((r) => r + 1);
    setCol(0);
  }, [row, col]);

  const deletePrev = useCallback(() => {
    if (col > 0) {
      setLines((prev) => {
        const next = [...prev];
        const line = next[row] ?? "";
        next[row] = line.slice(0, col - 1) + line.slice(col);
        return next;
      });
      setCol((c) => Math.max(0, c - 1));
      return;
    }
    if (row === 0) return;
    setLines((prev) => {
      const next = [...prev];
      const prevLine = next[row - 1] ?? "";
      const curLine = next[row] ?? "";
      next[row - 1] = prevLine + curLine;
      next.splice(row, 1);
      return next;
    });
    setCol(lines[row - 1]?.length ?? 0);
    setRow((r) => Math.max(0, r - 1));
  }, [col, row, lines]);

  const moveHistory = useCallback(
    (direction: "up" | "down") => {
      if (history.length === 0) return;
      let nextIdx = historyIdx;
      if (direction === "up") {
        if (historyIdx === -1) {
          setDraftBeforeHistory(lines);
          nextIdx = 0;
        } else if (historyIdx + 1 < history.length) {
          nextIdx = historyIdx + 1;
        } else {
          return;
        }
      } else {
        if (historyIdx === -1) return;
        if (historyIdx === 0) {
          setHistoryIdx(-1);
          const restore = draftBeforeHistory ?? [""];
          setLines(restore);
          const last = restore[restore.length - 1] ?? "";
          setRow(restore.length - 1);
          setCol(last.length);
          setDraftBeforeHistory(null);
          return;
        }
        nextIdx = historyIdx - 1;
      }
      setHistoryIdx(nextIdx);
      const text = history[nextIdx] ?? "";
      const newLines = text.split("\n");
      setLines(newLines.length > 0 ? newLines : [""]);
      const last = newLines[newLines.length - 1] ?? "";
      setRow(newLines.length - 1);
      setCol(last.length);
    },
    [history, historyIdx, draftBeforeHistory, lines],
  );

  const submit = useCallback(() => {
    const text = currentText.trim();
    if (!text) return;
    if (isExitInput(text)) {
      slashCtx.exit();
      resetInput();
      return;
    }
    if (isLikelyHarnessInvocation(text)) {
      dispatch({
        type: "INFO",
        level: "warn",
        text: `That looks like a shell command. Exit Harness first, then run: ${text}`,
      });
      resetInput();
      return;
    }
    if (text.startsWith("/")) {
      const handled = dispatchSlash(text, slashCtx);
      if (handled) {
        void appendHistory(text);
        resetInput();
        return;
      }
    }
    void appendHistory(text);
    onSubmit(text);
    resetInput();
  }, [currentText, onSubmit, resetInput, slashCtx]);

  const completeSlash = useCallback(() => {
    const chosen = suggestions[activeSuggestion];
    if (!chosen) return;
    const newText = chosen.acceptsArgs ? `${chosen.title} ` : chosen.title;
    const newLines = [newText];
    setLines(newLines);
    setRow(0);
    setCol(newText.length);
    setActiveSuggestion(0);
  }, [suggestions, activeSuggestion]);

  const openExternalEditor = useCallback(async () => {
    if (editorRef.current) return;
    editorRef.current = true;
    const editor = process.env["EDITOR"] || process.env["VISUAL"] || "nano";
    const dir = mkdtempSync(join(tmpdir(), "harness-"));
    const file = join(dir, "message.md");
    try {
      if (currentText) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file, currentText, "utf8");
      } else {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file, "", "utf8");
      }
      if (isRawModeSupported) setRawMode(false);
      await new Promise<void>((resolveP, rejectP) => {
        const child = spawn(editor, [file], { stdio: "inherit" });
        child.on("error", rejectP);
        child.on("exit", () => resolveP());
      });
      if (isRawModeSupported) setRawMode(true);
      const contents = readFileSync(file, "utf8").replace(/\s+$/, "");
      if (contents) {
        const newLines = contents.split("\n");
        setLines(newLines);
        setRow(newLines.length - 1);
        setCol((newLines[newLines.length - 1] ?? "").length);
      }
    } catch (err) {
      dispatch({
        type: "INFO",
        level: "error",
        text: `Failed to open editor (${editor}): ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      try {
        unlinkSync(file);
      } catch {
        // ignore: best-effort tmp cleanup
      }
      editorRef.current = false;
    }
  }, [currentText, dispatch, isRawModeSupported, setRawMode]);

  // Re-render every time stdout resizes (Ink does this but we can force it via state if needed).
  useEffect(() => {
    const onResize = (): void => {
      // Trigger a rerender by toggling no-op; Ink already reflows, nothing needed.
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  useInput(
    (input, key) => {
      if (disabled) return;
      if (reverseSearch) {
        if (key.escape) {
          setReverseSearch(null);
          return;
        }
        if (key.return) {
          const match = reverseMatches[reverseSearch.idx];
          if (match) {
            const newLines = match.split("\n");
            setLines(newLines);
            const last = newLines[newLines.length - 1] ?? "";
            setRow(newLines.length - 1);
            setCol(last.length);
          }
          setReverseSearch(null);
          return;
        }
        if (key.ctrl && input === "r") {
          setReverseSearch({
            ...reverseSearch,
            idx: Math.min(reverseMatches.length - 1, reverseSearch.idx + 1),
          });
          return;
        }
        if (key.backspace || key.delete) {
          setReverseSearch({ query: reverseSearch.query.slice(0, -1), idx: 0 });
          return;
        }
        if (input && !key.meta && !key.ctrl) {
          setReverseSearch({ query: reverseSearch.query + input, idx: 0 });
        }
        return;
      }

      if (key.ctrl && input === "c") {
        onQuitSignal();
        return;
      }

      if (key.ctrl && input === "r") {
        setReverseSearch({ query: "", idx: 0 });
        return;
      }

      if (key.ctrl && input === "e") {
        void openExternalEditor();
        return;
      }

      if (key.escape) {
        onCancel();
        return;
      }

      if (suggestions.length > 0) {
        if (key.upArrow) {
          setActiveSuggestion((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setActiveSuggestion((i) => Math.min(suggestions.length - 1, i + 1));
          return;
        }
        if (key.tab) {
          completeSlash();
          return;
        }
      }

      if (key.return) {
        const line = lines[row] ?? "";
        if (col > 0 && line[col - 1] === "\\") {
          // strip the trailing backslash and split
          setLines((prev) => {
            const next = [...prev];
            const cur = next[row] ?? "";
            next[row] = cur.slice(0, col - 1);
            next.splice(row + 1, 0, cur.slice(col));
            return next;
          });
          setRow((r) => r + 1);
          setCol(0);
          return;
        }
        submit();
        return;
      }

      if (key.ctrl && input === "j") {
        insertNewline();
        return;
      }

      if (key.upArrow) {
        if (row === 0) moveHistory("up");
        else {
          setRow((r) => r - 1);
          setCol((c) => Math.min(c, lines[row - 1]?.length ?? 0));
        }
        return;
      }
      if (key.downArrow) {
        if (row === lines.length - 1) moveHistory("down");
        else {
          setRow((r) => r + 1);
          setCol((c) => Math.min(c, lines[row + 1]?.length ?? 0));
        }
        return;
      }
      if (key.leftArrow) {
        if (col > 0) setCol((c) => c - 1);
        else if (row > 0) {
          setRow((r) => r - 1);
          setCol(lines[row - 1]?.length ?? 0);
        }
        return;
      }
      if (key.rightArrow) {
        const curLine = lines[row] ?? "";
        if (col < curLine.length) setCol((c) => c + 1);
        else if (row < lines.length - 1) {
          setRow((r) => r + 1);
          setCol(0);
        }
        return;
      }
      if (key.backspace || key.delete) {
        deletePrev();
        return;
      }
      if (input && !key.meta) {
        insertChar(input);
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box flexDirection="column">
      {reverseSearch ? (
        <Box flexDirection="column">
          <Box>
            <Text color={theme.primary} bold>
              (reverse-i-search)
            </Text>
            <Text>{` \`${reverseSearch.query}\`: `}</Text>
            <Text>{reverseMatches[reverseSearch.idx] ?? ""}</Text>
          </Box>
          <SuggestionsPanel
            suggestions={[]}
            activeIndex={reverseSearch.idx}
            historyMode
            historyMatches={reverseMatches}
          />
        </Box>
      ) : (
        <>
          <PromptBody
            lines={lines}
            row={row}
            col={col}
            placeholder={disabled ? "Working…" : "Type a message, / for commands"}
            disabled={disabled}
          />
          {suggestions.length > 0 && (
            <SuggestionsPanel suggestions={suggestions} activeIndex={activeSuggestion} />
          )}
          {!disabled && lines.length === 1 && lines[0] === "" && (
            <Box paddingX={1}>
              <Text color={theme.textMuted}>
                Enter send · \ + Enter newline · Ctrl+E editor · Ctrl+R history · Esc cancel
              </Text>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}

function PromptBody({
  lines,
  row,
  col,
  placeholder,
  disabled,
}: {
  readonly lines: readonly string[];
  readonly row: number;
  readonly col: number;
  readonly placeholder: string;
  readonly disabled: boolean;
}): ReactNode {
  const theme = useTheme();
  const showPlaceholder = !disabled && lines.length === 1 && lines[0] === "";

  return (
    <Box
      borderStyle="round"
      borderColor={disabled ? theme.border : theme.borderFocus}
      borderDimColor={disabled}
      paddingX={1}
      flexDirection="column"
    >
      {showPlaceholder ? (
        <Box>
          <Text color={theme.primary} bold>
            ›{" "}
          </Text>
          <Text color={theme.textMuted}>{placeholder}</Text>
        </Box>
      ) : (
        lines.map((line, i) => {
          const isCursor = !disabled && i === row;
          return (
            <Box key={i}>
              <Text color={theme.primary} bold>
                {i === 0 ? "›" : "│"}{" "}
              </Text>
              <RenderLine text={line} showCursor={isCursor} col={col} />
            </Box>
          );
        })
      )}
    </Box>
  );
}

function RenderLine({
  text,
  showCursor,
  col,
}: {
  readonly text: string;
  readonly showCursor: boolean;
  readonly col: number;
}): ReactNode {
  if (!showCursor) return <Text>{text || " "}</Text>;
  const before = text.slice(0, col);
  const at = text.slice(col, col + 1) || " ";
  const after = text.slice(col + 1);
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
}
