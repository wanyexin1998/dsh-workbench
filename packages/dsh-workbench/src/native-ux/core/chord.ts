// T7 — chord normalization (pure, seam A).
// Canonical spec: 'Primary+Shift+O'. Primary = ⌘ (macOS) / Ctrl (Win·Linux).
// Non-Primary combos (Alt+Shift+2, Escape) are canonical per tech design §19.

export type Platform = 'mac' | 'other'

export interface Chord {
  key: string
  shift: boolean
  alt: boolean
  primary: boolean
}

const KNOWN_KEYS = new Set([
  'escape', 'enter', 'space', 'tab', 'backspace', 'delete',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  'home', 'end', 'pageup', 'pagedown',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
])

function isValidKeyPart(part: string): boolean {
  const lower = part.toLowerCase()
  if (KNOWN_KEYS.has(lower)) return true
  // Single printable character (excluding the modifier words handled above).
  return Array.from(part).length === 1 && /\S/.test(part)
}

export function parseChord(spec: string): Chord | null {
  const parts = spec.split('+').map((p) => p.trim())
  if (parts.length === 0) return null
  let shift = false
  let alt = false
  let primary = false
  let key = ''
  for (const part of parts) {
    if (part === 'Primary') primary = true
    else if (part === 'Shift') shift = true
    else if (part === 'Alt') alt = true
    else if (part === 'Ctrl' || part === 'Meta') primary = true // legacy specs
    else if (key === '') key = part
    else return null // two bare keys are invalid
  }
  if (key === '' || !isValidKeyPart(key)) return null
  return { key: key === 'Space' ? ' ' : key.toLowerCase(), shift, alt, primary }
}

// macOS Option is a character-COMPOSING modifier, not a plain flag: on a US
// layout ⌥Q delivers `{ key: 'œ', altKey: true, code: 'KeyQ' }` — the browser
// puts the composed character in `key`. Reading `key` alone therefore yields
// the chord id 'Alt+œ', which can never equal the registered 'Alt+q', so the
// action is silently dead while Settings still renders it as bound ('⌥Q').
// When Alt is held, derive the key from the PHYSICAL `code` instead for the
// plain letter/digit rows. Windows/Linux report the same `code` for the same
// physical key ('KeyQ' for Alt+Q), so the derived chord id is identical on
// every platform — cross-platform chord stability is the point of this path,
// not just a macOS patch. Any other `code` (punctuation, named keys) or an
// event carrying no `code` at all falls back to the `key` behaviour.
const CODE_LETTER = /^Key([A-Z])$/
const CODE_DIGIT = /^Digit([0-9])$/

function altKeyFromCode(code: string | undefined): string | null {
  if (code === undefined) return null
  const letter = CODE_LETTER.exec(code)
  if (letter !== null) return letter[1].toLowerCase()
  const digit = CODE_DIGIT.exec(code)
  if (digit !== null) return digit[1]
  return null
}

/**
 * Build a chord from a keyboard event. `primary` follows the platform
 * rule: macOS reads Meta only, Windows/Linux read Ctrl only (PRD §9.1).
 * `code` is optional: absent (or an unrecognised code) keeps the historic
 * `event.key` behaviour, so non-Alt chords are untouched by the Alt path.
 */
export function chordFromEvent(
  event: {
    key: string
    shiftKey: boolean
    altKey: boolean
    ctrlKey: boolean
    metaKey: boolean
    code?: string
  },
  platform: Platform,
): Chord {
  // The code-derived path runs ONLY while Alt is held: without Alt, `key` is
  // the character the layout actually produced and must win (a Dvorak user
  // pressing the physical KeyB types "x", and "x" is the chord they mean).
  const fromCode = event.altKey ? altKeyFromCode(event.code) : null
  return {
    key: fromCode ?? event.key.toLowerCase(),
    shift: event.shiftKey,
    alt: event.altKey,
    primary: platform === 'mac' ? event.metaKey : event.ctrlKey,
  }
}

/** Stable identity for Map keys: modifiers sorted, key last. */
export function chordId(chord: Chord): string {
  const mods: string[] = []
  if (chord.alt) mods.push('Alt')
  if (chord.primary) mods.push('Primary')
  if (chord.shift) mods.push('Shift')
  return mods.concat(chord.key).join('+')
}

const KEY_SYMBOLS: Record<string, string> = {
  '/': '/',
  ' ': 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  enter: '↵',
  escape: 'Esc',
}

/** Human display: macOS '⌘⇧O' / Windows·Linux 'Ctrl+Shift+O'. */
export function formatChord(chord: Chord, platform: Platform): string {
  const primaryLabel = platform === 'mac' ? '⌘' : 'Ctrl'
  const parts: string[] = []
  if (chord.alt) parts.push(platform === 'mac' ? '⌥' : 'Alt')
  if (chord.primary) parts.push(primaryLabel)
  if (chord.shift) parts.push(platform === 'mac' ? '⇧' : 'Shift')
  const keyLabel = KEY_SYMBOLS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key)
  parts.push(keyLabel)
  return parts.join(platform === 'mac' ? '' : '+')
}
