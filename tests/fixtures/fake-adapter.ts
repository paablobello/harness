import type { ModelAdapter, ModelEvent, ModelTurnInput } from "../../src/types.js";

/**
 * Scripted ModelAdapter for tests: each call to `runTurn` yields the next set
 * of pre-defined events, in order. Lets us drive the turn loop deterministically.
 */
export function createScriptedAdapter(script: ModelEvent[][]): ModelAdapter {
  let turn = 0;
  return {
    name: "fake",
    model: "fake-model",
    async *runTurn(_input: ModelTurnInput, _signal: AbortSignal): AsyncIterable<ModelEvent> {
      const events = script[turn] ?? [];
      turn += 1;
      for (const ev of events) yield ev;
    },
  };
}

export function queuedInput(lines: string[]): { next: () => Promise<string | null> } {
  const buffer = [...lines];
  return {
    async next() {
      return buffer.length > 0 ? (buffer.shift() ?? null) : null;
    },
  };
}
