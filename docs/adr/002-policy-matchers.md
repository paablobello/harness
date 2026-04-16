# ADR-002: Policy as ordered matchers, not a DSL

## Status

Accepted, 2026-04.

## Context

Every tool call needs a gate: allowed unconditionally, denied unconditionally,
or "ask the user". That gate has to handle:

- Per-tool defaults (reads should auto-allow; writes should ask).
- Per-input exceptions (`run_command` is "ask" by default, but `rm -rf /` is
  always deny — even in `bypassPermissions` mode).
- User-installed rules (project-specific deny patterns).
- Permission modes that override decisions globally
  (`bypassPermissions`, `acceptEdits`, `plan`).

## Considered

1. **OPA / Rego or some other policy DSL.** Real production answer at scale.
   Massively over-engineered for a personal project; introduces a runtime and
   a learning curve that overshadow the harness itself.
2. **Function per tool.** `policy.runCommand(input) → decision`. Loses the
   declarative property — you can't list the rules to render them in a UI or
   an audit log.
3. **Ordered list of `{match, decision}` rules**, first match wins. This is
   what Claude Code-style permission settings already look like, and what
   most users will mentally pattern-match to.

## Decision

Option 3:

```ts
type PolicyRule = {
  match: { tool: string | RegExp; pattern?: RegExp };
  decision: "allow" | "deny" | "ask";
  reason?: string;
};
```

The pattern is matched against a tool-specific subject. For `run_command`
that's `input.command`; for everything else it's `JSON.stringify(input)`.
Permission modes are applied as a transform on the rule's decision, not as
extra rules.

`deny` is sticky across modes — `bypassPermissions` cannot override an
explicit deny. That's the only way to make the denylist meaningful.

## Consequences

**Good**:
- The default policy fits in 20 lines of `src/policy/defaults.ts` and reads
  like documentation.
- Auditing a session is trivial: every tool call emits a `PolicyDecision`
  event with the matched rule's reason.
- Sticky allow per `tool::input` keys off the same matcher logic — once the
  user says "yes" to a specific `git status`, we don't ask again that session.

**Bad / accepted**:
- Authors of policy rules need to know the input shape of each tool to write
  patterns. The alternative (typed schemas per tool with named fields) would
  bloat the rule definition. Documented per-tool subject extraction is
  cheaper.
- Pattern matching on `JSON.stringify` is order-sensitive. If a tool's input
  schema reorders keys, patterns can silently break. Acceptable because tool
  schemas are stable; if it bites us, we'll switch to canonical JSON.
