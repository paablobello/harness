import { Box, Text, useInput } from "ink";
import { relative } from "node:path";
import type { ReactNode } from "react";

import {
  classifyContext,
  contextWindowFor,
  DEFAULT_CONTEXT_THRESHOLDS,
} from "../../../runtime/context-window.js";
import { hasPricing } from "../../../runtime/cost.js";
import { SLASH_COMMANDS } from "../commands.js";
import type { Message, Overlay as OverlayState, ToolStat, TurnStat, UiState } from "../state.js";
import { useTheme, type Theme } from "../theme.js";
import { copyToClipboard, openInOs } from "../util/clipboard.js";

type ToolListItem = { name: string; risk: string; source: string; description: string };

type Props = {
  readonly overlay: OverlayState;
  readonly state: UiState;
  readonly tools?: readonly ToolListItem[];
};

export function Overlay({ overlay, state, tools }: Props): ReactNode {
  switch (overlay.type) {
    case "status":
      return <StatusOverlay state={state} />;
    case "tools":
      return <ToolsOverlay tools={tools ?? []} />;
    case "model":
      return <ModelOverlay state={state} />;
    case "log":
      return <LogOverlay state={state} />;
    case "help":
      return <HelpOverlay />;
    case "details":
      return <DetailsOverlay state={state} />;
    case "usage":
      return <UsageOverlay state={state} />;
    case "context":
      return <ContextOverlay state={state} />;
    case "message":
      return <MessageOverlay overlay={overlay} />;
    default:
      return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Shared chrome
// ────────────────────────────────────────────────────────────────────────────

function Badge({ label }: { readonly label: string }): ReactNode {
  const theme = useTheme();
  return (
    <Box>
      <Text bold color={theme.primary}>
        ▍
      </Text>
      <Text bold color={theme.text}>
        {" "}
        {label}
      </Text>
    </Box>
  );
}

function FooterEsc({
  hotkeys = [],
}: {
  readonly hotkeys?: readonly { char: string; label: string }[];
}): ReactNode {
  const theme = useTheme();
  return (
    <Box marginTop={1}>
      <Text color={theme.primary}>Esc</Text>
      <Text color={theme.textMuted}> close</Text>
      {hotkeys.map((h) => (
        <Box key={h.char}>
          <Text color={theme.textMuted}>{"  ·  "}</Text>
          <Text color={theme.primary}>{h.char}</Text>
          <Text color={theme.textMuted}> {h.label}</Text>
        </Box>
      ))}
    </Box>
  );
}

function useLogHotkeys(state: UiState): void {
  useInput((input) => {
    const ch = input.toLowerCase();
    if (ch === "c") void copyToClipboard(state.session.logPath);
    else if (ch === "o") void openInOs(state.session.logPath);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// status — editorial
// ────────────────────────────────────────────────────────────────────────────

function StatusOverlay({ state }: { readonly state: UiState }): ReactNode {
  const theme = useTheme();
  useLogHotkeys(state);

  const { session } = state;
  const tools = session.withTools ? `${session.toolCount} tools` : "no tools";
  const log = relative(session.cwd, session.logPath) || session.logPath;
  const sensors = countSensors(state.messages);

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Badge label="status" />
        <Text color={theme.textMuted}>
          {"   "}
          {session.adapter.name}:{session.adapter.model} · {session.permissionMode} · {tools}
        </Text>
      </Box>
      <Box height={1} />
      <KvRow label="cwd" value={session.cwd} />
      <KvRow label="config" value={session.configPath ?? "none"} />
      <KvRow label="log" value={shortenLogPath(log)} />
      <Box marginTop={1}>
        <Text color={theme.accentDim}>{"─".repeat(46)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text}>turns {state.stats.turns}</Text>
        <Text color={theme.textDim}>{"  ·  "}</Text>
        <Text color={theme.text}>
          tokens {formatTokens(state.stats.tokensIn)} in / {formatTokens(state.stats.tokensOut)} out
        </Text>
        <Text color={theme.textDim}>{"  ·  "}</Text>
        <Text color={theme.text}>
          cost {formatCost(state.stats.costUsd, hasPricing(session.adapter.model))}
        </Text>
        <Text color={theme.textDim}>{"  ·  sensors "}</Text>
        <Text color={sensors.pass > 0 ? theme.success : theme.textDim}>{sensors.pass}</Text>
        <Text color={theme.textDim}> pass / </Text>
        <Text color={sensors.fail > 0 ? theme.error : theme.textDim}>{sensors.fail}</Text>
        <Text color={theme.textDim}> fail</Text>
      </Box>
      <FooterEsc
        hotkeys={[
          { char: "c", label: "copy log" },
          { char: "o", label: "open log" },
        ]}
      />
    </Box>
  );
}

function KvRow({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  const theme = useTheme();
  return (
    <Box>
      <Text color={theme.textDim}>{"  "}</Text>
      <Box width={9}>
        <Text color={theme.textDim}>{label}</Text>
      </Box>
      <Text color={theme.text}>{value}</Text>
    </Box>
  );
}

function countSensors(messages: readonly Message[]): { pass: number; fail: number } {
  let pass = 0;
  let fail = 0;
  for (const m of messages) {
    if (m.kind !== "sensor") continue;
    if (m.ok) pass++;
    else fail++;
  }
  return { pass, fail };
}

function shortenLogPath(path: string): string {
  // Compact UUID-like segments (≥8 hex chars) so .harness/runs/<run-id>/events.jsonl
  // doesn't overflow the row.
  return path.replace(/([a-f0-9]{6})[a-f0-9]{2,}/gi, "$1…");
}

// ────────────────────────────────────────────────────────────────────────────
// tools — cards (2-column grid)
// ────────────────────────────────────────────────────────────────────────────

function ToolsOverlay({ tools }: { readonly tools: readonly ToolListItem[] }): ReactNode {
  const theme = useTheme();
  return (
    <Box flexDirection="column" marginY={1}>
      <Badge label="tools" />
      {tools.length === 0 ? (
        <Box marginTop={1}>
          <Text color={theme.textMuted}>No tools registered.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {pairs(tools).map((row, i) => (
            <Box key={i} flexDirection="row">
              {row.map((tool, j) => (
                <Box key={tool.name} width="50%" paddingRight={j === 0 ? 1 : 0}>
                  <ToolCard tool={tool} accent={i === 0 && j === 0} />
                </Box>
              ))}
              {row.length === 1 && <Box width="50%" />}
            </Box>
          ))}
        </Box>
      )}
      <FooterEsc />
    </Box>
  );
}

function ToolCard({
  tool,
  accent,
}: {
  readonly tool: ToolListItem;
  readonly accent: boolean;
}): ReactNode {
  const theme = useTheme();
  return (
    <Box
      borderLeft
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderStyle="single"
      borderLeftColor={accent ? theme.primary : theme.accentDim}
      paddingLeft={1}
      flexDirection="column"
    >
      <Box>
        <Text bold color={theme.text}>
          {tool.name}
        </Text>
        <Text color={theme.textMuted}>{"  "}</Text>
        <Text color={riskColor(tool.risk, theme)}>{tool.risk}</Text>
      </Box>
      <Text color={theme.textMuted}>
        {tool.source} · {firstLine(tool.description, 60)}
      </Text>
    </Box>
  );
}

function pairs<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 2) {
    const a = items[i];
    const b = items[i + 1];
    if (a !== undefined && b !== undefined) out.push([a, b]);
    else if (a !== undefined) out.push([a]);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// model & log — strip
// ────────────────────────────────────────────────────────────────────────────

function ModelOverlay({ state }: { readonly state: UiState }): ReactNode {
  const theme = useTheme();
  return (
    <Box flexDirection="column" marginY={1}>
      <Box
        borderLeft
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderStyle="single"
        borderLeftColor={theme.primary}
        paddingX={1}
        flexDirection="column"
      >
        <Box>
          <Text color={theme.textDim}>model </Text>
          <Text color={theme.text}>
            {state.session.adapter.name}:{state.session.adapter.model}
          </Text>
          <Box flexGrow={1} />
          <Text color={theme.primary}>Esc</Text>
          <Text color={theme.textMuted}> close</Text>
        </Box>
        <Text color={theme.textMuted}>Restart with --provider/--model to change.</Text>
      </Box>
    </Box>
  );
}

function LogOverlay({ state }: { readonly state: UiState }): ReactNode {
  const theme = useTheme();
  useLogHotkeys(state);
  return (
    <Box flexDirection="column" marginY={1}>
      <Box
        borderLeft
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderStyle="single"
        borderLeftColor={theme.primary}
        paddingX={1}
      >
        <Text color={theme.textDim}>log </Text>
        <Text color={theme.text}>{state.session.logPath}</Text>
        <Box flexGrow={1} />
        <Text color={theme.primary}>c</Text>
        <Text color={theme.textMuted}> copy </Text>
        <Text color={theme.primary}>o</Text>
        <Text color={theme.textMuted}> open </Text>
        <Text color={theme.primary}>Esc</Text>
        <Text color={theme.textMuted}> close</Text>
      </Box>
    </Box>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// help — grouped inline rail
// ────────────────────────────────────────────────────────────────────────────

const HELP_GROUPS: { label: string; ids: string[] }[] = [
  { label: "navigation", ids: ["help", "status", "tools", "model", "log", "usage"] },
  { label: "session", ids: ["details", "clear", "exit"] },
];

function HelpOverlay(): ReactNode {
  const theme = useTheme();
  return (
    <Box flexDirection="column" marginY={1}>
      <Badge label="commands" />
      {HELP_GROUPS.map((group) => {
        const cmds = group.ids
          .map((id) => SLASH_COMMANDS.find((c) => c.id === id))
          .filter((c): c is (typeof SLASH_COMMANDS)[number] => c !== undefined);
        if (cmds.length === 0) return null;
        return (
          <Box key={group.label} flexDirection="column" marginTop={1}>
            <Text color={theme.textMuted}>{group.label}</Text>
            {cmds.map((c) => (
              <Box key={c.id}>
                <Text color={theme.accentDim}>{"│ "}</Text>
                <Box width={12}>
                  <Text color={theme.primary}>{c.title}</Text>
                </Box>
                <Text color={theme.textMuted}>{c.description}</Text>
              </Box>
            ))}
          </Box>
        );
      })}
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.textMuted}>keyboard</Text>
        <Box>
          <Text color={theme.accentDim}>{"│ "}</Text>
          <Text color={theme.textMuted}>
            Enter send · \\ + Enter newline · Ctrl+E open $EDITOR · Ctrl+R history search
          </Text>
        </Box>
        <Box>
          <Text color={theme.accentDim}>{"│ "}</Text>
          <Text color={theme.textMuted}>
            Ctrl+O toggle expand on focused tool · Shift+Tab focus next tool
          </Text>
        </Box>
      </Box>
      <FooterEsc />
    </Box>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// details, message — minimal
// ────────────────────────────────────────────────────────────────────────────

function DetailsOverlay({ state }: { readonly state: UiState }): ReactNode {
  const theme = useTheme();
  return (
    <Box flexDirection="column" marginY={1}>
      <Badge label={`details ${state.details ? "enabled" : "disabled"}`} />
      <Box marginTop={1}>
        <Text color={theme.textMuted}>
          {state.details
            ? "Tool blocks show input JSON and expanded output."
            : "Tool blocks are back to compact summaries."}
        </Text>
      </Box>
      <FooterEsc />
    </Box>
  );
}

function MessageOverlay({
  overlay,
}: {
  readonly overlay: Extract<OverlayState, { type: "message" }>;
}): ReactNode {
  const theme = useTheme();
  const color =
    overlay.level === "error"
      ? theme.error
      : overlay.level === "warn"
        ? theme.warning
        : theme.primary;
  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text bold color={color}>
          ▍
        </Text>
        <Text bold color={color}>
          {" "}
          {overlay.level}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text}>{overlay.text}</Text>
      </Box>
      <FooterEsc />
    </Box>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// usage — chrome only (body unchanged)
// ────────────────────────────────────────────────────────────────────────────

function UsageOverlay({ state }: { readonly state: UiState }): ReactNode {
  const theme = useTheme();
  useLogHotkeys(state);
  return (
    <Box flexDirection="column" marginY={1}>
      <Badge label="usage" />
      <UsageBody state={state} theme={theme} />
      <FooterEsc
        hotkeys={[
          { char: "c", label: "copy log" },
          { char: "o", label: "open log" },
        ]}
      />
    </Box>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// context — breakdown + segmented bar
// ────────────────────────────────────────────────────────────────────────────

function ContextOverlay({ state }: { readonly state: UiState }): ReactNode {
  const theme = useTheme();
  const { session, usage } = state;
  const ctx = classifyContext(usage.lastInputTokens, session.adapter.model);
  const compactPct = Math.round(DEFAULT_CONTEXT_THRESHOLDS.compact * 100);
  return (
    <Box flexDirection="column" marginY={1}>
      <Badge label="context" />
      <Box>
        <Text color={theme.textMuted}>
          {"   "}
          {session.adapter.name}:{session.adapter.model}
        </Text>
      </Box>
      <Box height={1} />
      {ctx.contextWindow === undefined ? (
        <Box flexDirection="column">
          <Text color={theme.textDim}>
            Context window size is unknown for this model. Last reported input:{" "}
            {formatTokens(usage.lastInputTokens)}.
          </Text>
          <Text color={theme.textDim}>
            Update src/runtime/context-window.ts to add a known size.
          </Text>
        </Box>
      ) : (
        <ContextBreakdown
          state={state}
          contextWindow={ctx.contextWindow}
          ratio={ctx.ratio ?? 0}
          theme={theme}
        />
      )}
      <Box marginTop={1}>
        <Text color={theme.textMuted}>
          Auto-compact at {compactPct}% · /compact to run manually
        </Text>
      </Box>
      <FooterEsc
        hotkeys={[
          { char: "c", label: "copy log" },
          { char: "o", label: "open log" },
        ]}
      />
    </Box>
  );
}

function ContextBreakdown({
  state,
  contextWindow,
  ratio,
  theme,
}: {
  readonly state: UiState;
  readonly contextWindow: number;
  readonly ratio: number;
  readonly theme: Theme;
}): ReactNode {
  const { usage } = state;
  const total = contextWindow;
  const used = Math.min(total, Math.max(0, usage.lastInputTokens));

  // The provider reports total input tokens per turn; it does not expose a
  // breakdown. We estimate the fixed overhead (system prompt + tool schemas +
  // AGENTS.md) from the latest turn so the overlay can show a rough split.
  // The "conversation" slice is whatever is left after overhead.
  const systemAndTools = estimateOverheadTokens(state);
  const overheadUsed = Math.min(used, systemAndTools);
  const conversationUsed = Math.max(0, used - overheadUsed);
  const free = Math.max(0, total - used);

  return (
    <Box flexDirection="column">
      <BreakdownRow
        label="system + tools"
        tokens={overheadUsed}
        total={total}
        color={theme.primary}
        theme={theme}
      />
      <BreakdownRow
        label="conversation"
        tokens={conversationUsed}
        total={total}
        color={theme.secondary}
        theme={theme}
      />
      <BreakdownRow label="free" tokens={free} total={total} color={theme.textDim} theme={theme} />
      <Box marginTop={1}>
        <Text color={theme.text}>
          {formatTokens(used)} / {formatTokens(total)}
        </Text>
        <Text color={theme.textMuted}>
          {"  "}
          {(ratio * 100).toFixed(1)}%
        </Text>
      </Box>
    </Box>
  );
}

function BreakdownRow({
  label,
  tokens,
  total,
  color,
  theme,
}: {
  readonly label: string;
  readonly tokens: number;
  readonly total: number;
  readonly color: string;
  readonly theme: Theme;
}): ReactNode {
  const width = 24;
  const ratio = total > 0 ? Math.max(0, Math.min(1, tokens / total)) : 0;
  const filled = Math.round(ratio * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return (
    <Box>
      <Box width={18}>
        <Text color={theme.textMuted}>{label}</Text>
      </Box>
      <Box width={10}>
        <Text color={theme.text}>{formatTokens(tokens)}</Text>
      </Box>
      <Text color={color}>{bar}</Text>
    </Box>
  );
}

/**
 * Rough estimate of fixed overhead (system prompt + tool schemas) in tokens.
 * `turnHistory[0]` is the first completed turn and its `tokensIn` is the
 * smallest input size we'll ever see (it had no prior conversation). Using
 * that as a floor is accurate enough for a breakdown we label "approx." and
 * avoids importing a tokenizer into the UI.
 */
function estimateOverheadTokens(state: UiState): number {
  const first = state.usage.turnHistory[0];
  if (!first) return 0;
  return Math.max(0, first.tokensIn);
}

// ────────────────────────────────────────────────────────────────────────────
// helpers (reused — formerly module-level in this file)
// ────────────────────────────────────────────────────────────────────────────

function riskColor(risk: string, theme: Theme): string {
  if (risk === "read") return theme.success;
  if (risk === "write") return theme.warning;
  if (risk === "execute") return theme.error;
  return theme.textMuted;
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

// ────────────────────────────────────────────────────────────────────────────
// usage body (kept verbatim from previous implementation)
// ────────────────────────────────────────────────────────────────────────────

function UsageBody({
  state,
  theme,
}: {
  readonly state: UiState;
  readonly theme: Theme;
}): ReactNode {
  const { stats, usage, session } = state;
  const sessionMs = Date.now() - usage.sessionStartedAt;
  const ctxWindow = contextWindowFor(session.adapter.model);
  const modelPriced = hasPricing(session.adapter.model);
  const toolEntries = Object.entries(usage.toolUsage).sort(([, a], [, b]) => b.count - a.count);
  const recentTurns = usage.turnHistory.slice(-5).reverse();
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.textMuted}>Session</Text>
        <UsageRow label="duration" value={formatDuration(sessionMs)} theme={theme} />
        <UsageRow label="turns" value={String(stats.turns)} theme={theme} />
        <UsageRow
          label="tokens"
          value={`${formatTokens(stats.tokensIn)} in  ·  ${formatTokens(stats.tokensOut)} out`}
          theme={theme}
        />
        <UsageRow label="cost" value={formatCost(stats.costUsd, modelPriced)} theme={theme} />
        <Box>
          <Box width={11}>
            <Text color={theme.textMuted}>tools</Text>
          </Box>
          <Text color={theme.text}>{stats.toolCalls} calls</Text>
          {stats.toolFailures > 0 && (
            <>
              <Text color={theme.textDim}>{"  ·  "}</Text>
              <Text color={theme.error}>{stats.toolFailures} failed</Text>
            </>
          )}
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.textMuted}>Context window</Text>
        {ctxWindow ? (
          <ContextBar used={usage.lastInputTokens} total={ctxWindow} theme={theme} />
        ) : (
          <Text color={theme.textDim}>
            Unknown for {session.adapter.name}:{session.adapter.model} · last input{" "}
            {formatTokens(usage.lastInputTokens)}
          </Text>
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.textMuted}>Tools</Text>
        {toolEntries.length === 0 ? (
          <Text color={theme.textDim}>No tool calls yet.</Text>
        ) : (
          <>
            <ToolHeader theme={theme} />
            {toolEntries.map(([name, stat]) => (
              <ToolRow key={name} name={name} stat={stat} theme={theme} />
            ))}
          </>
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.textMuted}>Recent turns</Text>
        {recentTurns.length === 0 ? (
          <Text color={theme.textDim}>No completed turns yet.</Text>
        ) : (
          <>
            <TurnHeader theme={theme} />
            {recentTurns.map((t) => (
              <TurnRow key={t.index} turn={t} theme={theme} modelPriced={modelPriced} />
            ))}
          </>
        )}
      </Box>
    </Box>
  );
}

function UsageRow({
  label,
  value,
  theme,
}: {
  readonly label: string;
  readonly value: string;
  readonly theme: Theme;
}): ReactNode {
  return (
    <Box>
      <Box width={11}>
        <Text color={theme.textMuted}>{label}</Text>
      </Box>
      <Text color={theme.text}>{value}</Text>
    </Box>
  );
}

function ContextBar({
  used,
  total,
  theme,
}: {
  readonly used: number;
  readonly total: number;
  readonly theme: Theme;
}): ReactNode {
  const ratio = total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
  const width = 28;
  const filled = Math.round(ratio * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const pct = (ratio * 100).toFixed(1);
  const usedFmt = formatTokens(used);
  const totalFmt = formatTokens(total);
  return (
    <Box>
      <Text color={theme.primary}>{bar}</Text>
      <Text color={theme.text}>
        {"  "}
        {pct}%
      </Text>
      <Text color={theme.textMuted}>
        {"  "}
        {usedFmt} / {totalFmt} (est.)
      </Text>
    </Box>
  );
}

function ToolHeader({ theme }: { readonly theme: Theme }): ReactNode {
  return (
    <Box>
      <Box width={18}>
        <Text color={theme.textDim}>name</Text>
      </Box>
      <Box width={8}>
        <Text color={theme.textDim}>calls</Text>
      </Box>
      <Box width={10}>
        <Text color={theme.textDim}>total</Text>
      </Box>
      <Box width={9}>
        <Text color={theme.textDim}>avg</Text>
      </Box>
      <Box width={8}>
        <Text color={theme.textDim}>fail</Text>
      </Box>
    </Box>
  );
}

function ToolRow({
  name,
  stat,
  theme,
}: {
  readonly name: string;
  readonly stat: ToolStat;
  readonly theme: Theme;
}): ReactNode {
  const avgMs = stat.count > 0 ? stat.totalMs / stat.count : 0;
  const failColor = stat.failures > 0 ? theme.error : theme.textDim;
  return (
    <Box>
      <Box width={18}>
        <Text color={theme.primary}>{name}</Text>
      </Box>
      <Box width={8}>
        <Text color={theme.text}>{stat.count}</Text>
      </Box>
      <Box width={10}>
        <Text color={theme.text}>{formatDuration(stat.totalMs)}</Text>
      </Box>
      <Box width={9}>
        <Text color={theme.text}>{formatDuration(avgMs)}</Text>
      </Box>
      <Box width={8}>
        <Text color={failColor}>{stat.failures}</Text>
      </Box>
    </Box>
  );
}

function TurnHeader({ theme }: { readonly theme: Theme }): ReactNode {
  return (
    <Box>
      <Box width={5}>
        <Text color={theme.textDim}>#</Text>
      </Box>
      <Box width={9}>
        <Text color={theme.textDim}>dur</Text>
      </Box>
      <Box width={20}>
        <Text color={theme.textDim}>tokens (in/out)</Text>
      </Box>
      <Box width={11}>
        <Text color={theme.textDim}>cost</Text>
      </Box>
      <Box width={8}>
        <Text color={theme.textDim}>tools</Text>
      </Box>
    </Box>
  );
}

function TurnRow({
  turn,
  theme,
  modelPriced,
}: {
  readonly turn: TurnStat;
  readonly theme: Theme;
  readonly modelPriced: boolean;
}): ReactNode {
  return (
    <Box>
      <Box width={5}>
        <Text color={theme.textMuted}>{turn.index}</Text>
      </Box>
      <Box width={9}>
        <Text color={theme.text}>{formatDuration(turn.durationMs)}</Text>
      </Box>
      <Box width={20}>
        <Text color={theme.text}>
          {formatTokens(turn.tokensIn)} / {formatTokens(turn.tokensOut)}
        </Text>
      </Box>
      <Box width={11}>
        <Text color={theme.text}>{formatCost(turn.costUsd, modelPriced)}</Text>
      </Box>
      <Box width={8}>
        <Text color={turn.toolFailures > 0 ? theme.error : theme.text}>
          {turn.toolCalls}
          {turn.toolFailures > 0 ? `/${turn.toolFailures}✗` : ""}
        </Text>
      </Box>
    </Box>
  );
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatCost(usd: number, modelPriced = true): string {
  if (!modelPriced) return "n/a";
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
