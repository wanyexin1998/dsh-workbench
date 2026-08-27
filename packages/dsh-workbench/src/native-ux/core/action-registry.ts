// T7 — Action Registry (pure, seam A). Shortcuts bind Actions, not DOM.
// W1.1 — the catalog is dynamic: actions can be registered and later fully
// disposed (host-command bridge / third-party plugins come and go at
// runtime), and a live action can be rebound without a wholesale rebuild.
import { chordId, parseChord, type Chord } from './chord.js'

/** Provider id used when an ActionDef declares none (Workbench's own L0
 * actions). Dynamic providers (host commands, plugins) set `provider`
 * explicitly so Settings can group rows by source. */
export const DEFAULT_PROVIDER = 'workbench'

export interface ActionDef {
  id: string
  label: string
  defaultChord: string | null
  run: () => void
  /** Source of this action, for Settings grouping. Absent = DEFAULT_PROVIDER. */
  provider?: string
  /** Runtime gate consulted by resolve(). If it returns false (or throws)
   * the chord resolves to null instead of this action — see resolve(). */
  isEnabled?: () => boolean
}

export interface ChordConflict {
  chord: string
  actionIds: string[]
}

export interface RegisterResult {
  ok: boolean
  conflictWith?: string
  /** Fully unregisters this action: removes it from the catalog, removes
   * its id from the chord it holds (deleting the chord entry once empty —
   * a former 2-way conflict collapses back to a working single binding),
   * and clears its actionId->chord entry. Idempotent (safe to call more
   * than once). No-ops if this id was already re-registered by someone
   * else in the meantime (this disposer only ever tears down the exact
   * registration it was returned from). */
  dispose: () => void
}

export interface RebindResult {
  ok: boolean
  conflictWith?: string
}

const NOOP: () => void = () => {}

export class ActionRegistry {
  private actions = new Map<string, ActionDef>()
  private bindings = new Map<string, string[]>() // chordId -> actionIds (conflicts keep all)
  private actionChords = new Map<string, string>() // actionId -> chordId

  register(action: ActionDef, chordOverride?: string | null, disabled?: boolean): RegisterResult {
    if (this.actions.has(action.id)) return { ok: false, dispose: NOOP }
    this.actions.set(action.id, action)
    // '' explicitly unbinds (no fallback to the default chord).
    const spec = disabled === true || chordOverride === '' ? null : (chordOverride ?? action.defaultChord)
    let conflictWith: string | undefined
    if (spec !== null) {
      const chord = parseChord(spec)
      if (chord !== null) conflictWith = this.bindInternal(action.id, chord)
    }
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      // Guard against tearing down a *different* live registration that
      // reused this id after an earlier dispose() already ran. Unreachable
      // through the public API today: re-registering an id requires this
      // very dispose() to have already run once (register() rejects a
      // duplicate id while a live registration exists), and by then the
      // `disposed` latch above already short-circuits every later call to
      // this closure. Retained as defensive belt-and-braces per spec.
      if (this.actions.get(action.id) !== action) return
      this.actions.delete(action.id)
      this.unbindInternal(action.id)
    }
    return conflictWith !== undefined ? { ok: true, conflictWith, dispose } : { ok: true, dispose }
  }

  /**
   * Atomically move an already-registered action to a new chord.
   * `chordSpec` of `null` or `''` unbinds it. Preserves conflict bookkeeping
   * exactly like register()/dispose(): moving out of a 2-way conflict
   * collapses it back to the survivor; moving into an occupied chord
   * reports `conflictWith` the same way register() does. An unparsable
   * spec leaves the action unbound (mirrors register()'s own tolerance of
   * a bad `defaultChord`/override, which also just no-ops to unbound).
   */
  rebind(actionId: string, chordSpec: string | null): RebindResult {
    if (!this.actions.has(actionId)) return { ok: false }
    this.unbindInternal(actionId) // detach first so a move never self-conflicts
    if (chordSpec === null || chordSpec === '') return { ok: true }
    const chord = parseChord(chordSpec)
    if (chord === null) return { ok: true }
    const conflictWith = this.bindInternal(actionId, chord)
    return conflictWith !== undefined ? { ok: true, conflictWith } : { ok: true }
  }

  /**
   * Resolve a chord; ambiguous (conflicting) chords resolve to null.
   * A resolved action gated by `isEnabled` that currently reports false
   * also resolves to null: a disabled action must not silently swallow the
   * chord at dispatch, it must fall through to "no action" so the key
   * behaves as unbound while the provider is inactive. A throwing
   * `isEnabled` is treated the same as `false` (fail closed).
   */
  resolve(chord: Chord): ActionDef | null {
    const actionIds = this.bindings.get(chordId(chord))
    if (actionIds === undefined || actionIds.length !== 1) return null
    const action = this.actions.get(actionIds[0]) ?? null
    if (action === null || action.isEnabled === undefined) return action
    try {
      return action.isEnabled() === false ? null : action
    } catch {
      return null
    }
  }

  all(): ActionDef[] {
    return [...this.actions.values()]
  }

  /** Insertion-ordered grouping by provider (absent -> DEFAULT_PROVIDER). */
  byProvider(): Map<string, ActionDef[]> {
    const out = new Map<string, ActionDef[]>()
    for (const action of this.actions.values()) {
      const provider = action.provider ?? DEFAULT_PROVIDER
      const list = out.get(provider)
      if (list !== undefined) list.push(action)
      else out.set(provider, [action])
    }
    return out
  }

  bindingChord(actionId: string): string | null {
    const id = this.actionChords.get(actionId)
    return id ?? null
  }

  conflicts(): ChordConflict[] {
    return [...this.bindings.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([chord, actionIds]) => ({ chord, actionIds: [...actionIds] }))
  }

  /** Bind actionId to chord, appending to any existing owner list (conflict
   * bookkeeping). Returns the original owner's id when this creates/extends
   * a conflict, else undefined. Shared by register() and rebind(). */
  private bindInternal(actionId: string, chord: Chord): string | undefined {
    const id = chordId(chord)
    const existing = this.bindings.get(id)
    if (existing !== undefined) {
      existing.push(actionId)
    } else {
      this.bindings.set(id, [actionId])
    }
    this.actionChords.set(actionId, id)
    return existing !== undefined ? existing[0] : undefined
  }

  /** Detach actionId from whatever chord it currently holds, deleting the
   * chord's owner list once it is empty. Shared by dispose() and rebind(). */
  private unbindInternal(actionId: string): void {
    const id = this.actionChords.get(actionId)
    if (id === undefined) return
    this.actionChords.delete(actionId)
    const list = this.bindings.get(id)
    if (list === undefined) return
    const index = list.indexOf(actionId)
    if (index !== -1) list.splice(index, 1)
    if (list.length === 0) this.bindings.delete(id)
  }
}
