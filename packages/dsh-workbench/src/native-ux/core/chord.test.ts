import { describe, expect, it } from 'vitest'
import { chordFromEvent, chordId, formatChord, parseChord } from './chord.js'

describe('parseChord', () => {
  it('parses Primary+Shift+O', () => {
    const chord = parseChord('Primary+Shift+O')!
    expect(chord).toEqual({ key: 'o', shift: true, alt: false, primary: true })
  })
  it('normalizes legacy Ctrl/Meta specs to primary', () => {
    expect(parseChord('Ctrl+B')?.primary).toBe(true)
    expect(parseChord('Meta+B')?.primary).toBe(true)
  })
  it('accepts non-Primary combos (tech design §19)', () => {
    expect(parseChord('Alt+Shift+2')).toEqual({ key: '2', shift: true, alt: true, primary: false })
    expect(parseChord('Escape')).toEqual({ key: 'escape', shift: false, alt: false, primary: false })
  })
  it('rejects specs without a key or with garbage keys', () => {
    expect(parseChord('Primary')).toBeNull()
    expect(parseChord('not-a-chord')).toBeNull()
    expect(parseChord('Primary+O+X')).toBeNull()
  })
})

describe('formatChord', () => {
  it('renders macOS symbols', () => {
    expect(formatChord(parseChord('Primary+Shift+O')!, 'mac')).toBe('⌘⇧O')
    expect(formatChord(parseChord('Primary+/')!, 'mac')).toBe('⌘/')
  })
  it('renders Windows/Linux labels', () => {
    expect(formatChord(parseChord('Primary+Shift+O')!, 'other')).toBe('Ctrl+Shift+O')
    expect(formatChord(parseChord('Primary+Alt+B')!, 'other')).toBe('Alt+Ctrl+B')
  })
})

describe('chordFromEvent / chordId', () => {
  it('builds a canonical id under each platform rule', () => {
    const macEvent = chordFromEvent({ key: 'O', shiftKey: true, altKey: false, ctrlKey: false, metaKey: true }, 'mac')
    const winEvent = chordFromEvent({ key: 'o', shiftKey: true, altKey: false, ctrlKey: true, metaKey: false }, 'other')
    expect(chordId(macEvent)).toBe(chordId(winEvent))
    expect(chordId(macEvent)).toBe('Primary+Shift+o')
  })

  // F6: macOS Option composes characters. The real event a US-layout Mac
  // delivers for ⌥Q carries key 'œ' (NOT 'q'), so reading `key` alone made
  // the default Alt+Q binding of workbench.session.previous permanently
  // unreachable while Settings still displayed it as '⌥Q'.
  it('F6: macOS Option+Q (key "œ", code "KeyQ") normalizes to the registered Alt+q', () => {
    const macAltQ = chordFromEvent(
      { key: 'œ', shiftKey: false, altKey: true, ctrlKey: false, metaKey: false, code: 'KeyQ' },
      'mac',
    )
    expect(chordId(macAltQ)).toBe('Alt+q')
    expect(chordId(macAltQ)).toBe(chordId(parseChord('Alt+Q')!))
  })

  it('F6: the Windows Alt+Q event produces the SAME id — the code path is cross-platform stable', () => {
    const winAltQ = chordFromEvent(
      { key: 'q', shiftKey: false, altKey: true, ctrlKey: false, metaKey: false, code: 'KeyQ' },
      'other',
    )
    const macAltQ = chordFromEvent(
      { key: 'œ', shiftKey: false, altKey: true, ctrlKey: false, metaKey: false, code: 'KeyQ' },
      'mac',
    )
    expect(chordId(winAltQ)).toBe('Alt+q')
    expect(chordId(winAltQ)).toBe(chordId(macAltQ))
  })

  it('F6: Alt+Shift+2 (macOS delivers key "€", code "Digit2") normalizes to the canonical digit', () => {
    const macAltShift2 = chordFromEvent(
      { key: '€', shiftKey: true, altKey: true, ctrlKey: false, metaKey: false, code: 'Digit2' },
      'mac',
    )
    expect(chordId(macAltShift2)).toBe('Alt+Shift+2')
    expect(chordId(macAltShift2)).toBe(chordId(parseChord('Alt+Shift+2')!))
  })

  it('F6: the code path only runs under Alt, and only for letter/digit codes', () => {
    // No Alt -> `key` wins even though a letter code is present.
    const plain = chordFromEvent(
      { key: 'o', shiftKey: true, altKey: false, ctrlKey: true, metaKey: false, code: 'KeyO' },
      'other',
    )
    expect(chordId(plain)).toBe('Primary+Shift+o')
    // Alt held but a non-letter/digit code -> historic `key` behaviour.
    const named = chordFromEvent(
      { key: 'Enter', shiftKey: false, altKey: true, ctrlKey: false, metaKey: false, code: 'Enter' },
      'mac',
    )
    expect(chordId(named)).toBe('Alt+enter')
    // Alt held on an event carrying no `code` at all (synthetic/test events).
    const codeless = chordFromEvent({ key: 'q', shiftKey: false, altKey: true, ctrlKey: false, metaKey: false }, 'other')
    expect(chordId(codeless)).toBe('Alt+q')
  })

  // Boundary the Alt gate is FOR: without Alt, an event whose `key` disagrees
  // with its physical `code` must still resolve by `key`. A Dvorak layout puts
  // "x" on the physical KeyB key; deriving from `code` there would silently
  // rewrite the user chord to Primary+b. (Removing the `event.altKey` guard in
  // chordFromEvent passes every other test in this file — this is the one that
  // notices, so do not delete it.)
  it('F6: without Alt the layout character wins — Dvorak "x" on physical KeyB stays x', () => {
    const dvorak = chordFromEvent(
      { key: 'x', shiftKey: false, altKey: false, ctrlKey: true, metaKey: false, code: 'KeyB' },
      'other',
    )
    expect(chordId(dvorak)).toBe('Primary+x')
  })

  // Boundary on the OTHER side: only the plain letter/digit rows are derived.
  // Punctuation codes ('Slash', 'Period', 'Minus', ...) keep the historic
  // `key` behaviour — widening altKeyFromCode to return the raw code would
  // turn Alt+/ into the id 'Alt+slash', a chord spec no one can ever record.
  it.each([
    ['Slash', '÷'],
    ['Period', '≥'],
    ['Minus', '–'],
  ])('F6: Alt with a punctuation code (%s) is left on the key path', (code, key) => {
    const punctuation = chordFromEvent(
      { key, shiftKey: false, altKey: true, ctrlKey: false, metaKey: false, code },
      'mac',
    )
    expect(chordId(punctuation)).toBe(`Alt+${key}`)
  })
})
