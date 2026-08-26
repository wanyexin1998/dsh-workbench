// T7 — Action Registry (pure, seam A). Shortcuts bind Actions, not DOM.
import { chordId, parseChord, type Chord } from './chord.js'

export interface ActionDef {
  id: string
  label: string
  defaultChord: string | null
  run: () => void
}

export interface ChordConflict {
  chord: string
  actionIds: string[]
}

export class ActionRegistry {
  private actions = new Map<string, ActionDef>()
  private bindings = new Map<string, string[]>() // chordId -> actionIds (conflicts keep all)
  private actionChords = new Map<string, string>() // actionId -> chordId

  register(action: ActionDef, chordOverride?: string | null, disabled?: boolean): { ok: boolean; conflictWith?: string } {
    if (this.actions.has(action.id)) return { ok: false }
    this.actions.set(action.id, action)
    // '' explicitly unbinds (no fallback to the default chord).
    const spec = disabled === true || chordOverride === '' ? null : (chordOverride ?? action.defaultChord)
    if (spec !== null) {
      const chord = parseChord(spec)
      if (chord !== null) {
        const id = chordId(chord)
        const existing = this.bindings.get(id)
        if (existing !== undefined) {
          existing.push(action.id)
        } else {
          this.bindings.set(id, [action.id])
        }
        this.actionChords.set(action.id, id)
        return existing !== undefined && existing.length > 1 ? { ok: true, conflictWith: existing[0] } : { ok: true }
      }
    }
    return { ok: true }
  }

  /** Resolve a chord; ambiguous (conflicting) chords resolve to null. */
  resolve(chord: Chord): ActionDef | null {
    const actionIds = this.bindings.get(chordId(chord))
    if (actionIds === undefined || actionIds.length !== 1) return null
    return this.actions.get(actionIds[0]) ?? null
  }

  all(): ActionDef[] {
    return [...this.actions.values()]
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
}
