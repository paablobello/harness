import { Box, Text, useInput, useStdin } from "ink";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { Markdown } from "../markdown.js";
import type { PlanRequest } from "../state.js";
import { useTheme, type Theme } from "../theme.js";
import { openInExternalEditor } from "../util/external-editor.js";

type Decision = {
  readonly approved: boolean;
  readonly feedback?: string;
  readonly editedPlan?: string;
};

type Props = {
  readonly request: PlanRequest;
  readonly onResolve: (decision: Decision) => void;
};

const PREVIEW_LINES = 22;

/**
 * Approval dialog surfaced when the model calls `exit_plan_mode`.
 *
 * Visual language (aligned with the rest of the Ink UI):
 *   - `Badge` header (▍ + label) — same anchor used by Overlay cards
 *   - Rounded border surface for the plan body — same style as `CodeBlock`
 *   - Meta row in textMuted with `·` separators and a `⏸` plan-mode glyph
 *     (matches StatusBar)
 *   - Hotkey rail identical to `PolicyDialog.HotkeyRail`
 *   - Block cursor `▌` in primary for the feedback input (matches InputPrompt)
 *
 * Modes:
 *   review  → a approve · v expand/collapse · e edit in $EDITOR · r reject · Esc
 *   editing → non-interactive while $EDITOR owns the TTY (status line only)
 *   feedback → free-text input · ↵ submit · Esc back to review
 */
export function PlanApprovalDialog({ request, onResolve }: Props): ReactNode {
  const theme = useTheme();
  const { isRawModeSupported, setRawMode } = useStdin();

  const [stage, setStage] = useState<"review" | "feedback" | "editing">("review");
  const [expanded, setExpanded] = useState(false);
  const [editedPlan, setEditedPlan] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const editingRef = useRef(false);

  const currentPlan = editedPlan ?? request.plan;
  const edited = editedPlan !== null && editedPlan.trim() !== request.plan.trim();

  const approve = useCallback(() => {
    onResolve(edited ? { approved: true, editedPlan: currentPlan } : { approved: true });
  }, [edited, currentPlan, onResolve]);

  const launchEditor = useCallback(async () => {
    if (editingRef.current) return;
    editingRef.current = true;
    setStage("editing");
    try {
      const next = await openInExternalEditor({
        initial: currentPlan,
        filename: "plan.md",
        pauseInk: () => {
          if (isRawModeSupported) setRawMode(false);
        },
        resumeInk: () => {
          if (isRawModeSupported) setRawMode(true);
        },
      });
      if (next.trim().length > 0) {
        setEditedPlan(next);
      }
    } catch {
      // Editor spawn failed — swallow; returning to review keeps the user
      // unblocked. The outer bridge logs a more visible error for us via
      // onPlanResolve if needed, but we don't surface one from here.
    } finally {
      editingRef.current = false;
      setStage("review");
    }
  }, [currentPlan, isRawModeSupported, setRawMode]);

  useInput(
    (input, key) => {
      if (stage === "editing") return;

      if (stage === "review") {
        const ch = input.toLowerCase();
        if (ch === "a" || key.return) approve();
        else if (ch === "v") setExpanded((e) => !e);
        else if (ch === "e") void launchEditor();
        else if (ch === "r") setStage("feedback");
        else if (key.escape) onResolve({ approved: false, feedback: "User cancelled." });
        return;
      }

      if (key.escape) {
        setStage("review");
        setFeedback("");
        return;
      }
      if (key.return) {
        onResolve({ approved: false, feedback: feedback.trim() || "(no feedback given)" });
        return;
      }
      if (key.backspace || key.delete) {
        setFeedback((f) => f.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFeedback((f) => f + input);
      }
    },
    { isActive: stage !== "editing" },
  );

  if (stage === "editing") {
    return <EditingPlaceholder theme={theme} />;
  }
  if (stage === "feedback") {
    return <FeedbackStage theme={theme} plan={currentPlan} feedback={feedback} />;
  }
  return <ReviewStage theme={theme} plan={currentPlan} expanded={expanded} edited={edited} />;
}

// ────────────────────────────────────────────────────────────────────────────
// Review stage
// ────────────────────────────────────────────────────────────────────────────

function ReviewStage({
  theme,
  plan,
  expanded,
  edited,
}: {
  readonly theme: Theme;
  readonly plan: string;
  readonly expanded: boolean;
  readonly edited: boolean;
}): ReactNode {
  const stats = analyzePlan(plan);
  const { visible, hiddenLines } = clipPlan(plan, expanded ? Number.POSITIVE_INFINITY : PREVIEW_LINES);

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Badge theme={theme} label="plan ready for approval" />
        {edited && (
          <>
            <Text color={theme.textDim}>{"   "}</Text>
            <Text color={theme.warning} bold>
              ✎ edited
            </Text>
          </>
        )}
      </Box>
      <MetaRow theme={theme} stats={stats} expanded={expanded} hiddenLines={hiddenLines} />

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border}
        borderDimColor
        paddingX={1}
        marginTop={1}
      >
        <Markdown text={visible} />
        {hiddenLines > 0 && !expanded && (
          <Box marginTop={1}>
            <Text color={theme.textDim}>
              … {hiddenLines} more line{hiddenLines === 1 ? "" : "s"} hidden · press{" "}
            </Text>
            <Text color={theme.primary} bold>
              v
            </Text>
            <Text color={theme.textDim}> to expand · full plan saved on approval</Text>
          </Box>
        )}
      </Box>

      <HotkeyRail
        theme={theme}
        items={[
          { char: "a", label: "approve" },
          { char: "v", label: expanded ? "collapse" : "expand" },
          { char: "e", label: edited ? "re-edit" : "edit in $EDITOR" },
          { char: "r", label: "reject" },
        ]}
        trailing="Esc cancel"
      />
    </Box>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Editing placeholder — shown while $EDITOR owns the TTY
// ────────────────────────────────────────────────────────────────────────────

function EditingPlaceholder({ theme }: { readonly theme: Theme }): ReactNode {
  const editor = process.env["EDITOR"] || process.env["VISUAL"] || "nano";
  return (
    <Box flexDirection="column" marginY={1}>
      <Badge theme={theme} label="editing plan" color={theme.warning} />
      <Box marginTop={0}>
        <Text color={theme.textMuted}>
          {"  "}opened <Text color={theme.accentSoft}>{editor}</Text>
          <Text color={theme.textDim}>{" · "}</Text>
          save and close the file to continue
        </Text>
      </Box>
    </Box>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Feedback stage
// ────────────────────────────────────────────────────────────────────────────

function FeedbackStage({
  theme,
  plan,
  feedback,
}: {
  readonly theme: Theme;
  readonly plan: string;
  readonly feedback: string;
}): ReactNode {
  const planTitle = firstHeading(plan) ?? "(untitled plan)";

  return (
    <Box flexDirection="column" marginY={1}>
      <Badge theme={theme} label="reject plan · feedback" color={theme.warning} />
      <Box marginTop={0}>
        <Text color={theme.textMuted}>
          {"  "}rejecting <Text color={theme.accentSoft}>{truncate(planTitle, 48)}</Text>
          <Text color={theme.textDim}>{" · "}</Text>
          plan mode stays on; the model will iterate
        </Text>
      </Box>

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border}
        borderDimColor
        paddingX={1}
        marginTop={1}
      >
        {feedback.length === 0 ? (
          <Box>
            <Text color={theme.textDim} italic>
              what should the model change?{" "}
            </Text>
            <Text color={theme.primary}>▌</Text>
          </Box>
        ) : (
          <Box>
            <Text>{feedback}</Text>
            <Text color={theme.primary}>▌</Text>
          </Box>
        )}
      </Box>

      <HotkeyRail
        theme={theme}
        items={[{ char: "↵", label: "submit" }]}
        trailing="Esc back to review"
      />
    </Box>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Shared chrome
// ────────────────────────────────────────────────────────────────────────────

function Badge({
  theme,
  label,
  color,
}: {
  readonly theme: Theme;
  readonly label: string;
  readonly color?: string;
}): ReactNode {
  const c = color ?? theme.primary;
  return (
    <Box>
      <Text bold color={c}>
        ▍
      </Text>
      <Text bold color={theme.text}>
        {" "}
        {label}
      </Text>
    </Box>
  );
}

function MetaRow({
  theme,
  stats,
  expanded,
  hiddenLines,
}: {
  readonly theme: Theme;
  readonly stats: PlanStats;
  readonly expanded: boolean;
  readonly hiddenLines: number;
}): ReactNode {
  const parts: ReactNode[] = [
    <Text key="mode" color={theme.warning}>
      ⏸ plan mode
    </Text>,
  ];
  if (stats.steps > 0) {
    parts.push(
      <Text key="steps-sep" color={theme.textDim}>
        {"  ·  "}
      </Text>,
      <Text key="steps" color={theme.textMuted}>
        {stats.steps} step{stats.steps === 1 ? "" : "s"}
      </Text>,
    );
  }
  if (stats.fileRefs.length > 0) {
    parts.push(
      <Text key="files-sep" color={theme.textDim}>
        {"  ·  "}
      </Text>,
      <Text key="files" color={theme.textMuted}>
        {stats.fileRefs.length} file{stats.fileRefs.length === 1 ? "" : "s"}
      </Text>,
    );
  }
  parts.push(
    <Text key="words-sep" color={theme.textDim}>
      {"  ·  "}
    </Text>,
    <Text key="words" color={theme.textMuted}>
      {stats.words.toLocaleString()} word{stats.words === 1 ? "" : "s"}
    </Text>,
  );
  if (expanded || hiddenLines === 0) {
    parts.push(
      <Text key="view-sep" color={theme.textDim}>
        {"  ·  "}
      </Text>,
      <Text key="view" color={theme.success}>
        full view
      </Text>,
    );
  }

  return (
    <Box marginTop={0}>
      <Text color={theme.textDim}>{"  "}</Text>
      {parts}
    </Box>
  );
}

function HotkeyRail({
  theme,
  items,
  trailing,
}: {
  readonly theme: Theme;
  readonly items: readonly { char: string; label: string }[];
  readonly trailing?: string;
}): ReactNode {
  return (
    <Box marginTop={1}>
      <Text color={theme.accentDim}>{"│ "}</Text>
      {items.map((it, i) => (
        <Box key={it.char}>
          {i > 0 && <Text color={theme.textDim}>{"  ·  "}</Text>}
          <Text color={theme.primary} bold>
            {it.char}
          </Text>
          <Text color={theme.text}>{" "}{it.label}</Text>
        </Box>
      ))}
      {trailing && (
        <>
          <Text color={theme.textDim}>{"  ·  "}</Text>
          <Text color={theme.textDim}>{trailing}</Text>
        </>
      )}
    </Box>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Plan analysis
// ────────────────────────────────────────────────────────────────────────────

type PlanStats = {
  readonly steps: number;
  readonly fileRefs: readonly string[];
  readonly words: number;
};

function analyzePlan(plan: string): PlanStats {
  const lines = plan.split(/\r?\n/);

  let steps = 0;
  for (const line of lines) {
    if (/^\s*\d+\.\s+\S/.test(line)) steps += 1;
  }
  if (steps === 0) {
    for (const line of lines) {
      if (/^\s*[-*]\s+\S/.test(line)) steps += 1;
    }
  }

  const refSet = new Set<string>();
  const pathRe =
    /\b(?:[\w.@-]+\/)+[\w.@-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|ya?ml|toml|py|rs|go|sh|css|html?)\b/g;
  for (const m of plan.matchAll(pathRe)) refSet.add(m[0]);

  const words = plan.trim().split(/\s+/).filter(Boolean).length;

  return { steps, fileRefs: [...refSet], words };
}

function clipPlan(plan: string, max: number): { visible: string; hiddenLines: number } {
  const lines = plan.split(/\r?\n/);
  if (lines.length <= max) return { visible: plan, hiddenLines: 0 };
  return {
    visible: lines.slice(0, max).join("\n"),
    hiddenLines: lines.length - max,
  };
}

function firstHeading(plan: string): string | null {
  const m = plan.match(/^\s*#+\s+(.+)$/m);
  return m?.[1]?.trim() ?? null;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
