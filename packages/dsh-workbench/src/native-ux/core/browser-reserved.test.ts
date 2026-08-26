import { describe, expect, it } from 'vitest'
import { isBrowserReserved } from './browser-reserved.js'
import { parseChord } from './chord.js'

describe('isBrowserReserved', () => {
  it('flags Primary+B (bookmarks)', () => {
    expect(isBrowserReserved(parseChord('Primary+B')!).reserved).toBe(true)
  })

  it('flags Primary+digits for tab switching', () => {
    expect(isBrowserReserved(parseChord('Primary+1')!).reserved).toBe(true)
    expect(isBrowserReserved(parseChord('Primary+9')!).reserved).toBe(true)
  })

  it('does not flag Shift-modified digits or free chords', () => {
    expect(isBrowserReserved(parseChord('Primary+Shift+1')!).reserved).toBe(false)
    expect(isBrowserReserved(parseChord('Primary+Shift+X')!).reserved).toBe(false)
    expect(isBrowserReserved(parseChord('Primary+Shift+O')!).reserved).toBe(false)
  })

  // GA-021 regression: non-Primary combos must never match Primary+ entries.
  it.each([
    ['Shift+N', false],
    ['B', false],
    ['Alt+K', false],
    ['Primary+B', true],
    ['Primary+Shift+N', true],
  ])('%s reserved=%s', (spec, expected) => {
    expect(isBrowserReserved(parseChord(spec)!).reserved).toBe(expected)
  })
})
