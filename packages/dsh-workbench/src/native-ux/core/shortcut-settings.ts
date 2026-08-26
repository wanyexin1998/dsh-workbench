// T8 — shortcut settings projection (pure, seam A).
// The persisted section maps actionId -> chord spec string.
import { formatChord, parseChord, type Chord } from './chord.js'
import { isBrowserReserved } from './browser-reserved.js'

export type BindingOverrides = Record<string, string>

/** Explicit "no binding" sentinel (persisted; survives reload unlike ''). */
export const UNBOUND_SENTINEL = 'Unbound'

export interface BindingReport {
  actionId: string
  chordSpec: string
  display: string
  conflictWith: string | null
  browserReservedNote: string | null
  unbound?: boolean
}

/** Parse a persisted section into validated overrides (invalid → dropped). */
export function parseBindingOverrides(section: unknown): BindingOverrides {
  const out: BindingOverrides = {}
  if (typeof section !== 'object' || section === null) return out
  for (const [actionId, value] of Object.entries(section)) {
    if (typeof value !== 'string') continue
    if (value === UNBOUND_SENTINEL) { out[actionId] = value; continue }
    if (parseChord(value) === null) continue
    out[actionId] = value
  }
  return out
}

/** Validate a recorded chord: parse + reserved flag. */
export function validateChordSpec(spec: string): { chord: Chord | null; reservedNote: string | null } {
  const chord = parseChord(spec)
  if (chord === null) return { chord: null, reservedNote: null }
  const reserved = isBrowserReserved(chord)
  return { chord, reservedNote: reserved.reserved ? (reserved.note ?? 'browser-reserved') : null }
}

/** Build the per-action binding report for the settings table. */
export function bindingReport(
  actionId: string,
  defaultSpec: string | null,
  overrides: BindingOverrides,
  otherBindings: ReadonlyMap<string, string>, // chordId -> actionId
  platform: 'mac' | 'other',
): BindingReport {
  const chordSpec = overrides[actionId] ?? defaultSpec
  if (chordSpec === null || chordSpec === UNBOUND_SENTINEL) {
    const unbound = chordSpec === UNBOUND_SENTINEL
    return { actionId, chordSpec, display: unbound ? '' : '—', conflictWith: null, browserReservedNote: null, unbound }
  }
  const parsed = parseChord(chordSpec)
  const display = parsed === null ? chordSpec : formatChord(parsed, platform)
  let conflictWith: string | null = null
  if (parsed !== null) {
    const id = chordIdOf(parsed)
    const owner = otherBindings.get(id)
    if (owner !== undefined && owner !== actionId) conflictWith = owner
  }
  const reserved = parsed === null ? null : isBrowserReserved(parsed).note ?? null
  return { actionId, chordSpec, display, conflictWith, browserReservedNote: reserved }
}

function chordIdOf(chord: Chord): string {
  const mods: string[] = []
  if (chord.alt) mods.push('Alt')
  if (chord.primary) mods.push('Primary')
  if (chord.shift) mods.push('Shift')
  return mods.concat(chord.key).join('+')
}
