// T8 — browser-reserved chord risk table (pure, seam A).
// These chords are owned by mainstream browsers. The settings row warns
// before the user explicitly saves the recorded binding. Notes are locale
// keys so the UI follows the Harness language.
import { chordId, parseChord, type Chord } from './chord.js'

export interface ReservedEntry {
  chord: string
  note: string // locale key (see locales.ts: reserved.note.*)
}

export const BROWSER_RESERVED: readonly ReservedEntry[] = [
  { chord: 'Primary+B', note: 'reserved.note.bookmarks' },
  { chord: 'Primary+D', note: 'reserved.note.addBookmark' },
  { chord: 'Primary+F', note: 'reserved.note.find' },
  { chord: 'Primary+G', note: 'reserved.note.findNext' },
  { chord: 'Primary+H', note: 'reserved.note.history' },
  { chord: 'Primary+J', note: 'reserved.note.downloads' },
  { chord: 'Primary+K', note: 'reserved.note.addressBar' },
  { chord: 'Primary+L', note: 'reserved.note.addressBar' },
  { chord: 'Primary+N', note: 'reserved.note.newWindow' },
  { chord: 'Primary+P', note: 'reserved.note.print' },
  { chord: 'Primary+R', note: 'reserved.note.reload' },
  { chord: 'Primary+S', note: 'reserved.note.savePage' },
  { chord: 'Primary+T', note: 'reserved.note.newTab' },
  { chord: 'Primary+W', note: 'reserved.note.closeTab' },
  { chord: 'Primary+Shift+N', note: 'reserved.note.incognito' },
  { chord: 'Primary+Shift+P', note: 'reserved.note.printPreview' },
  { chord: 'Primary+Shift+T', note: 'reserved.note.reopenTab' },
  { chord: 'Primary+Shift+Tab', note: 'reserved.note.prevTab' },
]

/**
 * True when the chord collides with a mainstream browser default.
 * Single-digit Primary+<n> tab switching is handled separately: any
 * Primary+digit chord (without Shift) is reserved for tab switching.
 */
export function isBrowserReserved(chord: Chord): { reserved: boolean; note?: string } {
  if (chord.primary && !chord.shift && !chord.alt && /^[0-9]$/.test(chord.key)) {
    return { reserved: true, note: 'reserved.note.tabSwitch' }
  }
  // GA-021: exact normalized-chord matching via parseChord + chordId.
  // Comparing only Shift/Alt/key forgot `primary`, so non-Primary combos
  // like Shift+N or bare B could be mis-flagged as browser-reserved.
  const candidate = chordId(chord)
  for (const entry of BROWSER_RESERVED) {
    const reservedChord = parseChord(entry.chord)
    if (reservedChord === null) continue
    if (chordId(reservedChord) === candidate) {
      return { reserved: true, note: entry.note }
    }
  }
  return { reserved: false }
}
