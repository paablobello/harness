import { describe, expect, it, vi } from "vitest";

import { dispatchSlash, filterCommands, SLASH_COMMANDS } from "../../../src/cli/ui/commands.js";
import type { Action } from "../../../src/cli/ui/state.js";

describe("slash command catalog", () => {
  it("filters commands by leading prefix", () => {
    const out = filterCommands("/he");
    expect(out.map((c) => c.title)).toEqual(["/help"]);
  });

  it("exposes the full catalog for bare /", () => {
    expect(filterCommands("/").length).toBe(SLASH_COMMANDS.length);
  });

  it("returns empty list for non-slash input", () => {
    expect(filterCommands("hello")).toEqual([]);
  });
});

describe("dispatchSlash", () => {
  function ctx(dispatch: (a: Action) => void) {
    return { dispatch, exit: vi.fn(), details: false };
  }

  it("dispatches the handler for a known command and returns true", () => {
    const dispatch = vi.fn();
    const handled = dispatchSlash("/help", ctx(dispatch));
    expect(handled).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "OPEN_OVERLAY", overlay: { type: "help" } });
  });

  it("maps aliases (/q, /?) to their canonical handler", () => {
    const dispatch = vi.fn();
    const exit = vi.fn();
    const res = dispatchSlash("/q", { dispatch, exit, details: false });
    expect(res).toBe(true);
    expect(exit).toHaveBeenCalled();
  });

  it("emits an INFO line for unknown commands", () => {
    const dispatch = vi.fn();
    const res = dispatchSlash("/bogus", ctx(dispatch));
    expect(res).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "INFO", level: "warn" }));
  });

  it("/details toggles details based on current UI state", () => {
    const dispatch = vi.fn();
    dispatchSlash("/details", { ...ctx(dispatch), details: false });
    expect(dispatch).toHaveBeenCalledWith({ type: "SET_DETAILS", value: true });

    dispatch.mockClear();
    dispatchSlash("/details", { ...ctx(dispatch), details: true });
    expect(dispatch).toHaveBeenCalledWith({ type: "SET_DETAILS", value: false });
  });

  it("bare / opens the help overlay", () => {
    const dispatch = vi.fn();
    dispatchSlash("/", ctx(dispatch));
    expect(dispatch).toHaveBeenCalledWith({ type: "OPEN_OVERLAY", overlay: { type: "help" } });
  });

  it("/usage opens the usage overlay", () => {
    const dispatch = vi.fn();
    const handled = dispatchSlash("/usage", ctx(dispatch));
    expect(handled).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "OPEN_OVERLAY", overlay: { type: "usage" } });
  });

  it("/context opens the context overlay", () => {
    const dispatch = vi.fn();
    const handled = dispatchSlash("/context", ctx(dispatch));
    expect(handled).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({
      type: "OPEN_OVERLAY",
      overlay: { type: "context" },
    });
  });

  it("/compact calls onCompact with no instructions when none given", () => {
    const dispatch = vi.fn();
    const onCompact = vi.fn();
    dispatchSlash("/compact", { dispatch, exit: vi.fn(), details: false, onCompact });
    expect(onCompact).toHaveBeenCalledWith(undefined);
  });

  it("/compact forwards trimmed instructions to onCompact", () => {
    const dispatch = vi.fn();
    const onCompact = vi.fn();
    dispatchSlash("/compact   focus on auth flow   ", {
      dispatch,
      exit: vi.fn(),
      details: false,
      onCompact,
    });
    expect(onCompact).toHaveBeenCalledWith("focus on auth flow");
  });

  it("/compact warns when the session has no compaction hook wired", () => {
    const dispatch = vi.fn();
    dispatchSlash("/compact", { dispatch, exit: vi.fn(), details: false });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "INFO", level: "warn" }));
  });

  it("/clear dispatches CLEAR and fires onClear so the runtime drops history", () => {
    const dispatch = vi.fn();
    const onClear = vi.fn();
    dispatchSlash("/clear", { dispatch, exit: vi.fn(), details: false, onClear });
    expect(dispatch).toHaveBeenCalledWith({ type: "CLEAR" });
    expect(onClear).toHaveBeenCalled();
  });
});
