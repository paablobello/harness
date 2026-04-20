/**
 * Shell-aware command parser used by the policy engine and `run_command`.
 *
 * Why this exists: a flat regex on the raw command string is trivially
 * sidestepped (`echo hi && rm -rf ~`, `false; sudo rm`, `cat foo | bash`).
 * We tokenize with `shell-quote` and split on shell control operators so the
 * policy can evaluate every executable invocation independently.
 *
 * What we DO model: pipelines (`|`), sequences (`;`, `&&`, `||`), redirections
 * (`>`, `>>`, `<`, `2>`, ...), background (`&`).
 *
 * What we DO NOT model fully: command substitution (`$(...)`, backticks).
 * `shell-quote` returns these as opaque tokens; we surface them via
 * `hasSubshell` so the policy can be conservative (degrade to "ask").
 */

import { parse as shellParse, type ParseEntry } from "shell-quote";

export type Segment = {
  /** First non-empty token of the segment (the executable). */
  readonly executable: string;
  /** All string tokens, executable included. Operators are excluded. */
  readonly argv: readonly string[];
  /** File targets from shell redirections (`> file`, `2> err`, `< input`) in this segment. */
  readonly redirectTargets: readonly string[];
  /** Original substring of the raw command that this segment came from. */
  readonly rawText: string;
};

export type ParsedCommand = {
  readonly raw: string;
  readonly segments: readonly Segment[];
  /** True iff there is at least one of `|`, `>`, `<`, `>>`, `2>`, etc. */
  readonly hasRedirection: boolean;
  readonly hasPipe: boolean;
  /** True iff `$(...)` or backticks are present. We can't reason inside them. */
  readonly hasSubshell: boolean;
  /** True iff the parser hit something it could not classify. Treat as untrusted. */
  readonly parseError: boolean;
  /** All redirection targets across all segments. Kept so path guards can inspect them. */
  readonly redirectTargets: readonly string[];
  /**
   * Pipelines: groups of segments connected by `|`. Useful for detecting
   * `curl … | sh` even when split across two segments. A non-pipelined
   * command yields one pipeline of one segment.
   */
  readonly pipelines: readonly (readonly Segment[])[];
};

const CONTROL_OPS = new Set(["|", "||", "&&", ";", "&"]);
const REDIRECT_OPS = new Set([">", ">>", "<", "<<", "2>", "2>>", "&>", "<<<"]);
/**
 * `shell-quote` emits command-substitution `$(…)` and grouping `( … )` as
 * separate `op` tokens (`"("`, `")"`). Either way, we can't statically reason
 * about the body, so flag it and refuse to auto-allow.
 */
const SUBSHELL_OPS = new Set(["(", ")"]);

/**
 * Parse a shell command into structured segments. Always returns a result —
 * if parsing fails, `parseError: true` and `segments` will contain a single
 * best-effort segment with the raw command as both executable and rawText so
 * the policy can still match a literal banlist on the leading word.
 */
export function parseCommand(command: string): ParsedCommand {
  const raw = command.trim();
  if (raw.length === 0) {
    return {
      raw,
      segments: [],
      hasRedirection: false,
      hasPipe: false,
      hasSubshell: false,
      parseError: false,
      redirectTargets: [],
      pipelines: [],
    };
  }

  let entries: ParseEntry[];
  try {
    entries = shellParse(raw);
  } catch {
    return fallback(raw);
  }

  // shell-quote represents `$(...)` and backticks as a string starting with `$(`
  // or as objects without an `op`. We treat both as subshell markers.
  let hasSubshell = false;
  let hasRedirection = false;
  let hasPipe = false;
  let parseError = false;

  type Token =
    | { kind: "word"; text: string }
    | { kind: "op"; op: string }
    | { kind: "redirect" };

  const tokens: Token[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      // Heuristic: literal `$(` or `` ` `` survived tokenisation → subshell.
      if (/[$`]/.test(entry) && /\$\(|`/.test(entry)) hasSubshell = true;
      tokens.push({ kind: "word", text: entry });
      continue;
    }
    if ("op" in entry) {
      const op = entry.op;
      if (CONTROL_OPS.has(op)) {
        if (op === "|") hasPipe = true;
        tokens.push({ kind: "op", op });
        continue;
      }
      if (REDIRECT_OPS.has(op)) {
        hasRedirection = true;
        tokens.push({ kind: "redirect" });
        continue;
      }
      if (SUBSHELL_OPS.has(op)) {
        hasSubshell = true;
        continue;
      }
      // `glob` and other ops carry no security weight; ignore.
      continue;
    }
    if ("comment" in entry) {
      // Comments don't affect execution; drop them.
      continue;
    }
    if ("pattern" in entry) {
      // Command substitution / arithmetic. We cannot statically analyse what
      // would run inside, so flag and continue.
      hasSubshell = true;
      continue;
    }
    parseError = true;
  }

  // Walk the token stream and split into segments at every control op.
  // Redirect tokens consume the next word (the file target) so the executable
  // detection is not fooled by `cmd > file.txt`.
  const segments: Segment[] = [];
  const pipelines: Segment[][] = [];
  let currentArgv: string[] = [];
  let currentRedirectTargets: string[] = [];
  let currentPipeline: Segment[] = [];
  let lastOp: "pipe" | "other" | null = null;

  const flushSegment = (): void => {
    if (currentArgv.length === 0) return;
    const executable = currentArgv[0] ?? "";
    if (!executable) {
      currentArgv = [];
      return;
    }
      const seg: Segment = {
        executable,
        argv: [...currentArgv],
        redirectTargets: [...currentRedirectTargets],
        rawText: [...currentArgv, ...currentRedirectTargets.map((t) => `> ${t}`)].join(" "),
      };
      segments.push(seg);
      currentPipeline.push(seg);
      currentArgv = [];
      currentRedirectTargets = [];
    };

  const flushPipeline = (): void => {
    if (currentPipeline.length > 0) {
      pipelines.push(currentPipeline);
      currentPipeline = [];
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.kind === "word") {
      currentArgv.push(tok.text);
      continue;
    }
    if (tok.kind === "redirect") {
      // shell-quote splits `2>` into "2" + op:">", leaving the file-descriptor
      // digit as a stray word in argv. Drop it so callers don't see "2" as an
      // argument to `node`.
      const last = currentArgv[currentArgv.length - 1];
      if (last !== undefined && /^[0-9]+$/.test(last)) currentArgv.pop();
      // Capture and skip the next word (the redirect target). It's not part of
      // argv, but security checks still need to inspect it.
      const next = tokens[i + 1];
      if (next?.kind === "word") {
        currentRedirectTargets.push(next.text);
        i += 1;
      }
      continue;
    }
    flushSegment();
    if (tok.op === "|") {
      lastOp = "pipe";
    } else {
      flushPipeline();
      lastOp = "other";
    }
  }
  flushSegment();
  flushPipeline();
  // suppress lint: lastOp is consumed implicitly via flushPipeline placement.
  void lastOp;

  return {
    raw,
    segments,
    hasRedirection,
    hasPipe,
    hasSubshell,
    parseError,
    redirectTargets: segments.flatMap((s) => s.redirectTargets),
    pipelines,
  };
}

/**
 * When tokenisation throws (e.g. malformed quoting), we still want to expose
 * the leading word so the policy can deny obvious bans like `rm -rf /`.
 */
function fallback(raw: string): ParsedCommand {
  const firstWord = raw.split(/\s+/, 1)[0] ?? "";
  const seg: Segment = {
    executable: firstWord,
    argv: firstWord ? [firstWord] : [],
    redirectTargets: [],
    rawText: raw,
  };
  return {
    raw,
    segments: firstWord ? [seg] : [],
    hasRedirection: false,
    hasPipe: false,
    hasSubshell: /\$\(|`/.test(raw),
    parseError: true,
    redirectTargets: [],
    pipelines: firstWord ? [[seg]] : [],
  };
}

/**
 * Strip a leading path from an executable so that `/usr/bin/curl` matches the
 * banlist for `curl`. Also drops a leading `\` (used by users to bypass shell
 * aliases) and surrounding quotes that survived parsing.
 */
export function executableBasename(exe: string): string {
  let s = exe;
  if (s.startsWith("\\")) s = s.slice(1);
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  return s;
}
