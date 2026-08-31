import { describe, expect, it } from 'vitest'
import { BROWSER_RESERVED, isBrowserReserved } from './browser-reserved.js'
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

  // F4: workbench.chat.open ships Primary+Shift+C, which Chrome/Edge/Firefox
  // all bind to the DevTools element inspector. The chord is kept (product
  // decision); the table must carry it so the Settings row shows the warning
  // the way workbench.session.new's Primary+N already does.
  it('F4: flags Primary+Shift+C (DevTools inspect element) with its own note', () => {
    const verdict = isBrowserReserved(parseChord('Primary+Shift+C')!)
    expect(verdict.reserved).toBe(true)
    expect(verdict.note).toBe('reserved.note.devtoolsInspect')
  })

  it('F4: Primary+Shift+C sits in the table exactly once (no duplicate owner note)', () => {
    expect(BROWSER_RESERVED.filter((e) => e.chord === 'Primary+Shift+C')).toHaveLength(1)
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
