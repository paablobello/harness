import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { AssistantMessage } from "../../../src/cli/ui/components/AssistantMessage.js";
import { PolicyDialog } from "../../../src/cli/ui/components/PolicyDialog.js";
import { SuggestionsPanel } from "../../../src/cli/ui/components/SuggestionsPanel.js";
import { ToolBlock } from "../../../src/cli/ui/components/ToolBlock.js";
import { filterCommands } from "../../../src/cli/ui/commands.js";

describe("ToolBlock", () => {
  it("renders a running tool with spinner and input summary", () => {
    const { lastFrame } = render(
      <ToolBlock
        msg={{
          kind: "tool",
          id: "t1",
          name: "read",
          input: { path: "src/index.ts" },
          status: "running",
          output: "",
          expanded: false,
          turn: 1,
        }}
        focused={false}
        details={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("read");
    expect(frame).toContain("src/index.ts");
  });

  it("renders a successful tool with preview when not expanded", () => {
    const longOutput = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const { lastFrame } = render(
      <ToolBlock
        msg={{
          kind: "tool",
          id: "t1",
          name: "run_command",
          input: { command: "ls" },
          status: "ok",
          output: longOutput,
          expanded: false,
          turn: 1,
          durationMs: 120,
        }}
        focused={true}
        details={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("run_command");
    expect(frame).toContain("line 1");
    expect(frame).toContain("Ctrl+O");
  });

  it("renders the failure output in red when the tool failed", () => {
    const { lastFrame } = render(
      <ToolBlock
        msg={{
          kind: "tool",
          id: "t1",
          name: "read",
          input: { path: "x" },
          status: "fail",
          output: "Error: boom",
          expanded: false,
          turn: 1,
        }}
        focused={false}
        details={false}
      />,
    );
    expect(lastFrame() ?? "").toContain("Error: boom");
  });
});

describe("SuggestionsPanel", () => {
  it("lists the matching slash commands with an active marker", () => {
    const suggestions = filterCommands("/t");
    const { lastFrame } = render(<SuggestionsPanel suggestions={suggestions} activeIndex={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/tools");
    expect(frame).toContain("/theme");
    expect(frame).toContain("➤");
  });

  it("shows the reverse-search mode when historyMode is true", () => {
    const { lastFrame } = render(
      <SuggestionsPanel
        suggestions={[]}
        activeIndex={0}
        historyMode
        historyMatches={["hello world", "hello friends"]}
      />,
    );
    expect(lastFrame() ?? "").toContain("reverse-i-search");
  });
});

describe("AssistantMessage", () => {
  it("renders streamed text while still streaming", () => {
    const { lastFrame } = render(
      <AssistantMessage
        msg={{
          kind: "assistant",
          id: "a1",
          text: "Thinking…",
          streaming: true,
          turn: 1,
        }}
        adapter="fake"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("fake");
    expect(frame).toContain("Thinking");
  });

  it("renders headings and inline code once streaming is done", () => {
    const { lastFrame } = render(
      <AssistantMessage
        msg={{
          kind: "assistant",
          id: "a1",
          text: "# Title\n\nUse `foo()` carefully.",
          streaming: false,
          turn: 1,
        }}
        adapter="fake"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Title");
    expect(frame).toContain("foo()");
  });
});

describe("PolicyDialog", () => {
  it("renders the pending policy request with allow/deny hints", () => {
    const { lastFrame } = render(
      <PolicyDialog
        request={{
          id: "p1",
          tool: "run_command",
          input: { command: "rm -rf /tmp/x" },
          reason: "write outside sandbox",
        }}
        onResolve={() => undefined}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("run_command");
    expect(frame).toContain("rm -rf /tmp/x");
    expect(frame).toContain("allow");
    expect(frame).toContain("deny");
  });
});
