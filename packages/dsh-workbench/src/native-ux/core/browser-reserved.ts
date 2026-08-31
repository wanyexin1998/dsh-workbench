// T8 — browser-reserved chord risk table (pure, seam A).
// Most of these chords are owned by mainstream browsers, but the table's
// real job is broader than the name suggests: it flags any chord that may
// never reach the page's own keydown handler at all — a browser default, an
// OS-level shortcut, or (see the Primary+Space entry below) a system IME
// hotkey that intercepts the keydown even lower than the browser does. The
// exported names (BROWSER_RESERVED / isBrowserReserved) are kept as-is
// rather than renamed for one entry — "reserved" here should be read as "a
// layer outside the page (browser or system input method) may claim this
// chord first". The settings row warns before the user explicitly saves the
// recorded binding. Notes are locale keys so the UI follows the Harness
// language.
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
  // F4: Chrome / Edge / Firefox all bind this to DevTools "Inspect element".
  // It is workbench.chat.open's shipped default chord, kept as a product
  // decision (rebinding it would break documentation and existing muscle
  // memory) — the same treatment workbench.session.new's Primary+N gets:
  // the chord stays, and the Settings row surfaces the collision so the user
  // can see why the browser may win and rebind if they want to.
  { chord: 'Primary+Shift+C', note: 'reserved.note.devtoolsInspect' },
  { chord: 'Primary+Shift+N', note: 'reserved.note.incognito' },
  { chord: 'Primary+Shift+P', note: 'reserved.note.printPreview' },
  { chord: 'Primary+Shift+T', note: 'reserved.note.reopenTab' },
  { chord: 'Primary+Shift+Tab', note: 'reserved.note.prevTab' },
  // Not a browser default at all — it is intercepted a layer BELOW the
  // browser. Ctrl+Space (Primary+Space) is the default IME language-toggle
  // hotkey for Microsoft Pinyin and most other Chinese input methods on
  // Windows, and also collides with macOS Spotlight's Cmd+Space; either way
  // the OS/IME swallows the keydown before any web page's listener ever
  // sees it. This was workbench.settings.open's shipped default until user
  // testing confirmed it: Ctrl+Space did nothing on Chinese Windows, while
  // rebinding the same action to Ctrl+Shift+, opened Settings immediately —
  // proof the registration/dispatch path was fine and the chord itself was
  // simply unreachable. The default was changed to Primary+, (see
  // shortcuts.tsx), but this entry stays so the Settings row still warns
  // anyone who manually (re)binds an action back onto Primary+Space.
  { chord: 'Primary+Space', note: 'reserved.note.imeToggle' },
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
