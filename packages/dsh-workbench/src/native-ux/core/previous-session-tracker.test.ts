// L0 — pure unit tests for the most-recent-two session tracker (seam A).
// Mutation-mindset: each assertion below fails if the corresponding branch
// in createPreviousSessionTracker is deleted or inverted.
import { describe, expect, it } from 'vitest'
import { createPreviousSessionTracker } from './previous-session-tracker.js'

describe('createPreviousSessionTracker', () => {
  it('previous() is undefined before any focus has ever been observed', () => {
    const tracker = createPreviousSessionTracker()
    expect(tracker.previous()).toBeUndefined()
  })

  it('a single noteFocus() call does not yet produce a previous (nothing to swap FROM)', () => {
    const tracker = createPreviousSessionTracker()
    tracker.noteFocus('a')
    expect(tracker.previous()).toBeUndefined()
  })

  it('A -> B makes A the previous', () => {
    const tracker = createPreviousSessionTracker()
    tracker.noteFocus('a')
    tracker.noteFocus('b')
    expect(tracker.previous()).toBe('a')
  })

  it('IDE Ctrl+Tab-style alternation: A -> B -> (toggle to A) -> (toggle to B) keeps flipping the pair', () => {
    const tracker = createPreviousSessionTracker()
    tracker.noteFocus('a')
    tracker.noteFocus('b')
    expect(tracker.previous()).toBe('a')
    // Simulates run() switching to 'a', which itself re-triggers noteFocus
    // via the focus-change subscription (the SAME signal a manual click uses).
    tracker.noteFocus('a')
    expect(tracker.previous()).toBe('b')
    tracker.noteFocus('b')
    expect(tracker.previous()).toBe('a')
  })

  it('a manual switch to a THIRD session updates the pair the same way an internal toggle would', () => {
    const tracker = createPreviousSessionTracker()
    tracker.noteFocus('a')
    tracker.noteFocus('b')
    tracker.noteFocus('c') // manual click away from B, not our own toggle
    expect(tracker.previous()).toBe('b')
  })

  it('a redundant notification for the SAME already-current id is a no-op (does not shift the pair)', () => {
    const tracker = createPreviousSessionTracker()
    tracker.noteFocus('a')
    tracker.noteFocus('b')
    tracker.noteFocus('b') // e.g. an unrelated list-store update, same focus
    expect(tracker.previous()).toBe('a')
  })

  it('undefined notifications (no session focused) are ignored — they never become "previous" or "current"', () => {
    const tracker = createPreviousSessionTracker()
    tracker.noteFocus('a')
    tracker.noteFocus('b')
    tracker.noteFocus(undefined) // e.g. a transient gap while a session closes
    expect(tracker.previous()).toBe('a') // unchanged
    tracker.noteFocus('c')
    // 'current' was never overwritten by the undefined notification, so the
    // pair advances from (a, b) -> (b, c), not (undefined, c).
    expect(tracker.previous()).toBe('b')
  })

  it('tracks ids only: never stores or exposes anything beyond the two string slots', () => {
    const tracker = createPreviousSessionTracker()
    tracker.noteFocus('a')
    tracker.noteFocus('b')
    expect(Object.keys(tracker)).toEqual(['noteFocus', 'previous'])
  })
})
