/**
 * Filesystem-aware guard for `run_command`. Independent from `PolicyEngine`
 * because the policy operates on tool-name + raw command string, while this
 * looks at every argv token of every parsed segment, normalises it against
 * the user's home and the current cwd, and matches against a fixed list of
 * sensitive paths.
 *
 * The intent is *not* to enforce a strict sandbox (we can't, without OS-level
 * primitives — see plan §"Fuera de scope") but to catch the obvious shapes:
 *
 *   - reading or copying SSH/AWS/GPG keys
 *   - writing inside `.git/` or `.harness/runs/`
 *   - touching `.env*` or `*.pem` files
 *
 * Paths are matched as **path prefixes** after normalisation, so
 * `cat ~/.ssh/id_rsa`, `cat $HOME/.ssh/id_rsa`, `cat /Users/x/.ssh/id_rsa`
 * and `cat ./.ssh/id_rsa` (when cwd happens to be $HOME) all hit.
 */

import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";

import type { ParsedCommand } from "../tools/command-parser.js";
import { executableBasename } from "../tools/command-parser.js";

export type ProtectedPathHit = {
  /** The argv token (post-expansion) that matched. */
  readonly token: string;
  /** The protected path entry that triggered the match. */
  readonly rule: string;
  /** Which segment's executable triggered (for human-readable reporting). */
  readonly executable: string;
};

export type ProtectedPathOptions = {
  readonly cwd: string;
  /** Defaults to `os.homedir()`. Tests inject a temp dir. */
  readonly home?: string;
  /** Extra protected path prefixes beyond the defaults. */
  readonly extra?: readonly string[];
};

/**
 * Path prefixes that are denied from EVERY shell command. Both absolute
 * (`/etc/sudoers`) and home-relative (`~/.ssh/`) entries are supported.
 *
 * `.git/` and `.harness/runs/` are workspace-relative and resolved against
 * the call's `cwd`. Everything else is matched against absolute, normalised
 * argv tokens after `~`, `$HOME` and relative-path expansion.
 */
const ABSOLUTE_PROTECTED: readonly string[] = [
  "/etc/sudoers",
  "/etc/shadow",
  "/etc/passwd",
  "/etc/ssh",
  "/etc/ssl/private",
  "/var/root",
  "/root",
];

const HOME_PROTECTED: readonly string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".gcloud",
  ".kube",
  ".docker/config.json",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".config/gh",
];

const WORKSPACE_PROTECTED: readonly string[] = [
  ".git",
  ".harness/runs",
];

/**
 * Glob-ish suffix matchers for filenames anywhere in the tree (matched on the
 * basename of any argv token that looks like a path).
 */
const PROTECTED_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/, // .env, .env.local, .env.production
  /\.pem$/i,
  /\.key$/i,
  /^id_[a-z0-9_]+$/, // id_rsa, id_ed25519, etc.
];

/**
 * Detect a protected-path hit anywhere in the parsed command. Returns the
 * first match (commands typically only fail on the first sensitive arg).
 */
export function touchesProtectedPath(
  parsed: ParsedCommand,
  opts: ProtectedPathOptions,
): ProtectedPathHit | null {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd;

  const absoluteRules = [
    ...ABSOLUTE_PROTECTED,
    ...HOME_PROTECTED.map((p) => joinPath(home, p)),
    ...WORKSPACE_PROTECTED.map((p) => joinPath(cwd, p)),
    ...(opts.extra ?? []).map((p) => expandPath(p, home, cwd)),
  ].map(normalize);

  for (const seg of parsed.segments) {
    const exe = executableBasename(seg.executable);
    // Skip the executable token itself: if someone literally types `.git/hook`
    // as the command they're asking for that, but `cat .git/HEAD` is what we
    // want to catch — that's argv[1].
    for (let i = 1; i < seg.argv.length; i++) {
      const hit = protectedPathHit(seg.argv[i]!, exe, absoluteRules, home, cwd);
      if (hit) return hit;
    }
    for (const token of seg.redirectTargets) {
      const hit = protectedPathHit(token, exe, absoluteRules, home, cwd);
      if (hit) return hit;
    }
  }
  return null;
}

function protectedPathHit(
  token: string,
  executable: string,
  absoluteRules: readonly string[],
  home: string,
  cwd: string,
): ProtectedPathHit | null {
  if (!looksLikePath(token)) return null;
  const expanded = expandPath(token, home, cwd);
  const normalized = normalize(expanded);

  for (const rule of absoluteRules) {
    if (pathStartsWith(normalized, rule)) {
      return { token, rule, executable };
    }
  }

  const base = basenameOf(normalized);
  for (const re of PROTECTED_BASENAME_PATTERNS) {
    if (re.test(base)) {
      return { token, rule: re.source, executable };
    }
  }
  return null;
}

function looksLikePath(token: string): boolean {
  if (token.length === 0) return false;
  if (isAbsolute(token)) return true;
  if (token.startsWith("~") || token.startsWith("$HOME")) return true;
  if (token.startsWith("./") || token.startsWith("../")) return true;
  // Tokens with a path separator are likely paths, but bare `foo` is more
  // commonly a flag value or subcommand than a path.
  if (token.includes("/")) return true;
  // Bare basename matches against PROTECTED_BASENAME_PATTERNS (e.g. `.env`).
  if (PROTECTED_BASENAME_PATTERNS.some((re) => re.test(token))) return true;
  return false;
}

function expandPath(token: string, home: string, cwd: string): string {
  let s = token;
  if (s === "~" || s.startsWith("~/")) s = joinPath(home, s.slice(2));
  if (s === "$HOME" || s.startsWith("$HOME/")) s = joinPath(home, s.slice("$HOME".length).replace(/^\//, ""));
  if (!isAbsolute(s)) s = resolve(cwd, s);
  return s;
}

function joinPath(...parts: readonly string[]): string {
  return resolve(...parts);
}

function pathStartsWith(candidate: string, prefix: string): boolean {
  if (candidate === prefix) return true;
  return candidate.startsWith(prefix + sep);
}

function basenameOf(p: string): string {
  const i = p.lastIndexOf(sep);
  return i >= 0 ? p.slice(i + 1) : p;
}
