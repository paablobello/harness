# Screenshot capture guide

The README references six PNGs in this folder. Capture them in a clean
terminal (recommended: iTerm2 or Ghostty at ~120 cols × 35 rows, no
shell prompt clutter, dark theme) and save them with the exact filenames
below. The README links break otherwise.

> **Tooling.** macOS: `Cmd+Shift+4`, then `Space` to grab the terminal
> window. Crop tightly. Optimise with `pngquant *.png --ext .png --force`
> if file size matters.

| Filename                      | What to capture                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `01-tui-overview.png`         | Hero shot. A live `harness` chat session mid-turn with assistant text streaming and one tool block.   |
| `02-tool-diff.png`            | An `edit_file` or `apply_patch` tool block expanded, showing the inline unified diff.                 |
| `03-plan-mode.png`            | Plan mode active (`Shift+Tab`), a few read-only tool calls done, then the `PlanApprovalDialog` open.  |
| `04-policy-dialog.png`        | A `PolicyDialog` for a sensitive command (e.g. `git push origin main`) showing the y/N/a/d hotkeys.   |
| `05-inspect-timeline.png`     | Output of `harness inspect latest` showing the timeline + totals.                                     |
| `06-usage-overlay.png`        | The `/usage` (or `/context`) overlay open in chat, showing token + cost + context-window stats.       |

---

## Suggested terminal sessions

Run each from a throwaway directory so the prompts and outputs stay
focused.

### `01-tui-overview.png`

```bash
mkdir /tmp/harness-shot && cd /tmp/harness-shot
node /path/to/harness-lab/dist/cli/main.js init
node /path/to/harness-lab/dist/cli/main.js
# in the TUI:
> Read package.json and tell me the three most interesting dependencies and why.
# Capture while assistant is mid-stream, with one read_file tool block visible.
```

### `02-tool-diff.png`

```bash
# from inside the TUI session above:
> Add a top-level "description" field to package.json that summarises the project in one sentence.
# Wait for the edit_file block to render, press Ctrl+O to expand it, then capture.
```

### `03-plan-mode.png`

```bash
node /path/to/harness-lab/dist/cli/main.js --permission-mode plan
> I want to refactor the policy engine to support priority-ordered rule groups instead of a flat list. Plan it.
# After the model completes its read-only exploration and exit_plan_mode pops the dialog,
# capture with the dialog showing the 22-line preview and the [a]/[v]/[e]/[r] hotkey hint.
```

### `04-policy-dialog.png`

```bash
# from a normal (non-plan) session:
> Push the current branch to origin.
# The model will call run_command("git push ..."), which routes through ask.
# Capture the PolicyDialog with the command, the reason, and the hotkeys visible.
```

### `05-inspect-timeline.png`

```bash
# after any of the runs above:
node /path/to/harness-lab/dist/cli/main.js inspect latest
# Capture the rendered timeline with totals at the bottom.
```

### `06-usage-overlay.png`

```bash
# in any chat session that already has a few turns:
> /usage
# Capture the overlay with tokens, cost, context window %, per-tool stats.
# Alternative: /context for the context-window breakdown view.
```

---

## Style notes

- Keep terminal padding consistent across shots.
- Hide your real cwd if it includes personal directory names — `cd /tmp/...`
  before recording.
- Avoid capturing API keys (the doctor command never prints them, but
  shell scrollback might).
- For social previews (LinkedIn / Twitter), `01-tui-overview.png` is the
  one that matters most; spend the time to make it look good.
