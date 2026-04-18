/**
 * A tiny control bus the UI uses to push imperative commands into the turn loop
 * (manual `/compact`, `/clear`, `set_mode`, …). The session polls the channel
 * between turns so control messages never interleave with a tool-use loop.
 */

import type { PermissionMode } from "../types.js";

export type Control =
  | { readonly type: "compact"; readonly instructions?: string }
  | { readonly type: "clear" }
  | { readonly type: "set_mode"; readonly mode: PermissionMode };

export class ControlChannel {
  private readonly queue: Control[] = [];
  private readonly waiters: (() => void)[] = [];

  push(c: Control): void {
    this.queue.push(c);
    const waiters = this.waiters.splice(0);
    for (const wake of waiters) wake();
  }

  /** Non-blocking pop. Returns `null` when the queue is empty. */
  poll(): Control | null {
    return this.queue.shift() ?? null;
  }

  /** Resolve when a control is pushed. The waiter can be cancelled after races. */
  wait(): { promise: Promise<void>; cancel: () => void } {
    if (this.queue.length > 0) {
      return { promise: Promise.resolve(), cancel: () => undefined };
    }

    let wake: (() => void) | null = null;
    const promise = new Promise<void>((resolve) => {
      wake = resolve;
      this.waiters.push(resolve);
    });
    return {
      promise,
      cancel: () => {
        if (!wake) return;
        const idx = this.waiters.indexOf(wake);
        if (idx >= 0) this.waiters.splice(idx, 1);
        wake = null;
      },
    };
  }

  size(): number {
    return this.queue.length;
  }
}
