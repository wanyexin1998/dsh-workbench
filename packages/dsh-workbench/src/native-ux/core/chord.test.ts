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
})
