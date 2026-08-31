// L0 — most-recent-two session tracker (pure, seam A) backing
// workbench.session.previous (native-actions-pivot). IDE Ctrl+Tab-style
// alternation: each call to `run()` swaps to whatever was current
// immediately before the present session, and every ACTUAL focus change
// (ours or a manual UI switch) keeps the pair current, since both flow
// through the same `noteFocus` call in shortcuts.tsx's applyShortcuts.
//
// Tracks ids only, never session content — a plain two-slot ring buffer.
// State lives for the plugin's own lifetime (one tracker per applyShortcuts
// call) and resets when the plugin does; nothing here persists across reload.

export interface PreviousSessionTracker {
  /**
   * Record a focus/current-session change. `undefined` (no session focused —
   * e.g. a transient gap while a session closes) is deliberately ignored: it
   * carries no real session identity, so treating it as a transition would
   * corrupt the pair with a "previous = undefined" the next real focus could
   * never recover from. A no-op when `id` already equals the current one
   * (redundant notifications, e.g. an unrelated list-store update, never
   * shift the pair).
   */
  noteFocus(id: string | undefined): void
  /** The session that was current immediately before the present one, or
   * `undefined` before any transition has ever been observed. */
  previous(): string | undefined
}

export function createPreviousSessionTracker(): PreviousSessionTracker {
  let current: string | undefined
  let previous: string | undefined
  return {
    noteFocus(id) {
      if (id === undefined) return
      if (id === current) return
      previous = current
      current = id
    },
    previous: () => previous,
  }
}
