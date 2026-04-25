/**
 * Per-segment policy evaluator for `run_command` calls.
 *
 * The traditional "single regex on the raw command" approach is trivially
 * bypassed (`echo hi && rm -rf ~`, `cat foo | bash`). Here we receive a
 * pre-parsed command (see `src/tools/command-parser.ts`) and apply three
 * layers in order:
 *
 *   1. Catastrophic patterns → hard deny (cannot be auto-approved).
 *   2. Pipe-to-shell of a downloader (`curl … | sh`) → hard deny.
 *   3. Sensitive executables (sudo, ssh, package managers, …) → ask.
 *   4. Subshell / parse error → ask (we can't reason about it statically).
 *   5. All segments are on the safe-prefix allowlist → auto-allow.
 *   6. Otherwise → ask.
 *
 * The previous defaults made every "destructive-looking" pattern a hard deny
 * which led to silent failures the model couldn't recover from. We now reserve
 * `deny` for patterns that are realistically never legitimate (root rm,
 * mkfs, fork bombs, remote-script-piped-to-shell). Everything else becomes
 * `ask`, which routes through the UI escalation flow.
 */

import type { ParsedCommand, Segment } from "../tools/command-parser.js";
import { executableBasename } from "../tools/command-parser.js";
import type { PolicyDecision } from "../types.js";

/**
 * Patterns that can never be auto-approved because no realistic interactive
 * use of the harness would want them to succeed unattended.
 *
 * Each pattern is matched against the raw command string; this catches
 * obfuscated forms (extra quoting, environment expansion) that the segment
 * walker would otherwise miss. Keep this list short and high-signal.
 */
const CATASTROPHIC_PATTERNS: readonly { re: RegExp; reason: string }[] = [
  // rm -rf / | rm -rf /* | rm -fr / | rm --recursive --force /
  {
    re: /\brm\s+(?:-[a-z]*[rRfF][a-z]*|--recursive|--force)(?:\s+(?:-[a-z]+|--[a-z-]+))*\s+(['"]?)(?:\/|~|\$HOME)\1?(\s|$|\*)/,
    reason: "rm -rf of root or home",
  },
  // mkfs.* — destroys filesystems
  { re: /\bmkfs\.[a-z0-9]+\b/, reason: "mkfs filesystem destroy" },
  // dd over a block device
  { re: /\bdd\s+.*of=\/dev\/[sh]d[a-z]/, reason: "dd to block device" },
  // Classic fork bomb
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  // chmod -R 777 on root or home
  { re: /\bchmod\s+(-R\s+)?777\s+(\/|~|\$HOME)\b/, reason: "chmod 777 of root/home" },
];

/**
 * Executables that are powerful enough that we want explicit user consent
 * even when invoked in benign-looking ways. Routed through `ask`, not deny —
 * `sudo apt install foo` is a perfectly valid thing the user might approve.
 */
const SENSITIVE_EXECUTABLES: ReadonlySet<string> = new Set([
  // Privilege
  "sudo",
  "su",
  "doas",
  // Network downloaders / clients
  "curl",
  "wget",
  "axel",
  "aria2c",
  "fetch",
  "lynx",
  "w3m",
  "links",
  "httpie",
  "xh",
  // Remote shells / file transfer
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "telnet",
  "nc",
  "ncat",
  // Package managers (system-level)
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "pacman",
  "brew",
  "snap",
  "flatpak",
  "port",
  // Filesystem / device admin
  "mount",
  "umount",
  "fdisk",
  "parted",
  "mkfs",
  "dd",
  // Service / system control
  "systemctl",
  "service",
  "launchctl",
  "initctl",
  // Network configuration
  "iptables",
  "nft",
  "firewall-cmd",
  "ufw",
  "ifconfig",
  "ip",
  "route",
  // Browsers (likely an exfil vector)
  "chrome",
  "firefox",
  "safari",
  "open",
]);

const DOWNLOADERS: ReadonlySet<string> = new Set([
  "curl",
  "wget",
  "fetch",
  "axel",
  "aria2c",
  "httpie",
  "xh",
]);

const SHELLS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "ksh",
  "dash",
  "ash",
  "csh",
  "tcsh",
  "pwsh",
]);

/**
 * Argv-prefixes that bypass approval entirely. A segment "matches" a prefix
 * iff its argv starts with the prefix tokens exactly. We use prefixes (not
 * full argv) so that `git status -s` is just as safe as `git status`, but we
 * never auto-allow `git push` because there is no `["git", "push"]` entry.
 */
const SAFE_ARGV_PREFIXES: readonly (readonly string[])[] = [
  // Filesystem / shell basics
  ["ls"],
  ["pwd"],
  ["echo"],
  ["cat"],
  ["wc"],
  ["head"],
  ["tail"],
  ["sort"],
  ["uniq"],
  ["cut"],
  ["tr"],
  ["grep"],
  ["rg"],
  ["sed", "-n"],
  ["which"],
  ["type"],
  ["whereis"],
  ["file"],
  ["date"],
  ["whoami"],
  ["id"],
  ["uname"],
  ["uptime"],
  ["hostname"],
  ["printenv"],
  ["stat"],
  ["du"],
  ["df"],
  ["true"],
  ["false"],
  // Runtime version probes
  ["node", "-v"],
  ["node", "--version"],
  ["python", "--version"],
  ["python3", "--version"],
  ["go", "version"],
  ["go", "env"],
  ["go", "list"],
  ["go", "help"],
  ["rustc", "--version"],
  ["cargo", "--version"],
  ["deno", "--version"],
  ["bun", "--version"],
  // Git read-only
  ["git", "status"],
  ["git", "log"],
  ["git", "diff"],
  ["git", "show"],
  ["git", "branch"],
  ["git", "remote"],
  ["git", "rev-parse"],
  ["git", "ls-files"],
  ["git", "blame"],
  ["git", "config", "--get"],
  // Test/build commands assumed safe in most workflows
  ["pnpm", "test"],
  ["pnpm", "typecheck"],
  ["pnpm", "lint"],
  ["pnpm", "build"],
  ["pnpm", "format:check"],
  ["pnpm", "tsc"],
  ["npm", "test"],
  ["npm", "run", "test"],
  ["npm", "run", "lint"],
  ["yarn", "test"],
  ["yarn", "lint"],
  ["vitest"],
  ["vitest", "run"],
  ["jest"],
  ["mocha"],
  ["tsc", "--noEmit"],
  ["tsc", "-p"],
];

export function evaluateRunCommand(parsed: ParsedCommand): PolicyDecision {
  if (parsed.segments.length === 0) {
    return { decision: "deny", reason: "empty command" };
  }

  for (const { re, reason } of CATASTROPHIC_PATTERNS) {
    if (re.test(parsed.raw)) return { decision: "deny", reason: `catastrophic: ${reason}` };
  }

  // curl/wget piped into a shell, even if separated by `xargs`, `tee`, etc.
  // We require the LAST executable in the pipeline to be a shell to avoid
  // false positives like `curl example.com | grep ok`.
  if (parsed.hasPipe) {
    for (const pipeline of parsed.pipelines) {
      if (pipeline.length < 2) continue;
      const hasDownloader = pipeline.some((s) => DOWNLOADERS.has(executableBasename(s.executable)));
      if (!hasDownloader) continue;
      const last = pipeline[pipeline.length - 1]!;
      if (SHELLS.has(executableBasename(last.executable))) {
        return { decision: "deny", reason: "remote-fetched script piped to shell" };
      }
    }
  }

  if (parsed.hasSubshell) {
    return { decision: "ask", reason: "command contains subshell ($(…) or backticks)" };
  }

  if (parsed.parseError) {
    return { decision: "ask", reason: "command failed to parse cleanly" };
  }

  for (const seg of parsed.segments) {
    const exe = executableBasename(seg.executable);
    if (SENSITIVE_EXECUTABLES.has(exe)) {
      return { decision: "ask", reason: `sensitive command: ${exe}` };
    }
  }

  if (parsed.segments.every(isSafeSegment)) return { decision: "allow" };

  return { decision: "ask" };
}

function isSafeSegment(seg: Segment): boolean {
  if (seg.argv.length === 0) return false;
  const exe = executableBasename(seg.argv[0] ?? "");
  const argv: readonly string[] = [exe, ...seg.argv.slice(1)];
  for (const prefix of SAFE_ARGV_PREFIXES) {
    if (matchesPrefix(argv, prefix)) return true;
  }
  return false;
}

function matchesPrefix(argv: readonly string[], prefix: readonly string[]): boolean {
  if (argv.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (argv[i] !== prefix[i]) return false;
  }
  return true;
}

/** Exposed for tests so they can pin the lists without re-deriving them. */
export const __test = {
  CATASTROPHIC_PATTERNS,
  SENSITIVE_EXECUTABLES,
  SAFE_ARGV_PREFIXES,
};
