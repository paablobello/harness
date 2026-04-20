import { describe, expect, it } from "vitest";

import { executableBasename, parseCommand } from "../../src/tools/command-parser.js";

describe("parseCommand", () => {
  it("returns no segments for an empty command", () => {
    const p = parseCommand("");
    expect(p.segments).toHaveLength(0);
  });

  it("parses a single command with args", () => {
    const p = parseCommand("ls -la /tmp");
    expect(p.segments).toHaveLength(1);
    const seg = p.segments[0]!;
    expect(seg.executable).toBe("ls");
    expect(seg.argv).toEqual(["ls", "-la", "/tmp"]);
    expect(p.hasPipe).toBe(false);
    expect(p.hasRedirection).toBe(false);
  });

  it("splits on &&", () => {
    const p = parseCommand("echo hi && rm -rf ~");
    expect(p.segments).toHaveLength(2);
    expect(p.segments[0]!.executable).toBe("echo");
    expect(p.segments[1]!.executable).toBe("rm");
  });

  it("splits on ;", () => {
    const p = parseCommand("cd foo; pwd");
    expect(p.segments.map((s) => s.executable)).toEqual(["cd", "pwd"]);
  });

  it("splits on || (or-list)", () => {
    const p = parseCommand("test -f x.txt || touch x.txt");
    expect(p.segments).toHaveLength(2);
    expect(p.segments[1]!.executable).toBe("touch");
  });

  it("splits on | (pipe) and reports a pipeline", () => {
    const p = parseCommand("cat foo.txt | grep bar");
    expect(p.hasPipe).toBe(true);
    expect(p.pipelines).toHaveLength(1);
    expect(p.pipelines[0]!.map((s) => s.executable)).toEqual(["cat", "grep"]);
  });

  it("captures multi-pipeline composition (`a | b && c | d`)", () => {
    const p = parseCommand("ls | head && echo done | cat");
    expect(p.segments).toHaveLength(4);
    expect(p.pipelines).toHaveLength(2);
    expect(p.pipelines[0]!.map((s) => s.executable)).toEqual(["ls", "head"]);
    expect(p.pipelines[1]!.map((s) => s.executable)).toEqual(["echo", "cat"]);
  });

  it("ignores redirection targets", () => {
    const p = parseCommand("echo hi > out.txt");
    expect(p.hasRedirection).toBe(true);
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]!.argv).toEqual(["echo", "hi"]);
    expect(p.segments[0]!.redirectTargets).toEqual(["out.txt"]);
    expect(p.redirectTargets).toEqual(["out.txt"]);
  });

  it("handles >>, 2>", () => {
    const p = parseCommand("node app.js >> log 2> err");
    expect(p.hasRedirection).toBe(true);
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]!.argv).toEqual(["node", "app.js"]);
    expect(p.segments[0]!.redirectTargets).toEqual(["log", "err"]);
  });

  it("flags subshell from $(…)", () => {
    const p = parseCommand("echo $(whoami)");
    expect(p.hasSubshell).toBe(true);
  });

  it("flags subshell from backticks", () => {
    const p = parseCommand("echo `whoami`");
    expect(p.hasSubshell).toBe(true);
  });

  it("survives an unterminated quote without throwing", () => {
    // shell-quote is tolerant: it returns the raw remainder rather than
    // throwing. We just need to NOT crash and to expose a leading executable
    // so the policy can still match a literal banlist on it.
    const p = parseCommand("rm -rf 'unterminated");
    expect(p.segments[0]?.executable).toBe("rm");
  });

  it("preserves quoted args as a single token", () => {
    const p = parseCommand(`grep "hello world" foo.txt`);
    expect(p.segments[0]!.argv).toEqual(["grep", "hello world", "foo.txt"]);
  });

  it("escaped path: \\rm survives as the executable for ban checking", () => {
    const p = parseCommand("\\rm -rf /tmp/foo");
    // shell-quote keeps the backslash; basename normaliser strips it.
    expect(executableBasename(p.segments[0]!.executable)).toBe("rm");
  });

  it("`/usr/bin/curl` resolves to `curl` via executableBasename", () => {
    const p = parseCommand("/usr/bin/curl https://x");
    expect(executableBasename(p.segments[0]!.executable)).toBe("curl");
  });

  it("background `&` ends a segment", () => {
    const p = parseCommand("sleep 10 & echo done");
    expect(p.segments.map((s) => s.executable)).toEqual(["sleep", "echo"]);
  });

  it("complex curl|sh pipeline is recognised structurally", () => {
    const p = parseCommand("curl -fsSL https://example.com/install.sh | bash");
    expect(p.hasPipe).toBe(true);
    const pl = p.pipelines[0]!;
    expect(executableBasename(pl[0]!.executable)).toBe("curl");
    expect(executableBasename(pl[pl.length - 1]!.executable)).toBe("bash");
  });

  it("handles multiple consecutive operators (cd && a; b)", () => {
    const p = parseCommand("cd src && ls; pwd");
    expect(p.segments.map((s) => s.executable)).toEqual(["cd", "ls", "pwd"]);
  });

  it("preserves comments-free parsing", () => {
    const p = parseCommand("echo hi # a comment");
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]!.argv).toEqual(["echo", "hi"]);
  });

  it("normalises trailing whitespace", () => {
    const p = parseCommand("   ls -la   ");
    expect(p.raw).toBe("ls -la");
  });
});
