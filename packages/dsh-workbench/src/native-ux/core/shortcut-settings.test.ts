import { describe, expect, it } from 'vitest'
import { bindingReport, parseBindingOverrides, validateChordSpec } from './shortcut-settings.js'

describe('parseBindingOverrides', () => {
  it('keeps only valid chord strings', () => {
    const parsed = parseBindingOverrides({
      'a.b': 'Primary+Shift+O',
      'a.c': 'not-a-chord',
      'a.d': 42,
    })
    expect(parsed).toEqual({ 'a.b': 'Primary+Shift+O' })
  })

  it('tolerates null and non-object sections', () => {
    expect(parseBindingOverrides(null)).toEqual({})
    expect(parseBindingOverrides('x')).toEqual({})
  })
})

describe('validateChordSpec', () => {
  it('parses and flags browser-reserved chords', () => {
    expect(validateChordSpec('Primary+B').reservedNote).toBeTruthy()
    expect(validateChordSpec('Primary+Shift+O').reservedNote).toBeNull()
    expect(validateChordSpec('garbage').chord).toBeNull()
  })
})

describe('bindingReport', () => {
  it('reports conflicts against other bindings and reserved notes', () => {
    const report = bindingReport(
      'a1',
      'Primary+O',
      { a1: 'Primary+B', a2: 'Primary+B' },
      new Map([['Primary+b', 'a2']]),
      'other',
    )
    expect(report.display).toBe('Ctrl+B')
    expect(report.conflictWith).toBe('a2')
    expect(report.browserReservedNote).toBeTruthy()
  })

  it('shows a dash for unbound actions', () => {
    const report = bindingReport('a1', null, {}, new Map(), 'mac')
    expect(report.display).toBe('—')
  })

  // MEDIUM 2 (Opus review, round 2 of native-actions-pivot): reviewer's claim
  // was "the reserved table only warns on RECORDED bindings, not defaults."
  // Verified false at THIS layer: `chordSpec = overrides[actionId] ??
  // defaultSpec` (line 49 above) unifies override and default BEFORE
  // `isBrowserReserved` ever runs — there is no separate "was this an
  // override" branch to suppress on. Pinned here with workbench.session.new's
  // actual production defaultChord ('Primary+N', kept as the maintainer's
  // explicit choice — see its doc comment in shortcuts.tsx) and an EMPTY
  // overrides object, so this specifically exercises the default-only path
  // the reviewer flagged, not the already-covered override path above.
  it('flags a browser-reserved DEFAULT chord even with no override present (MEDIUM 2)', () => {
    const report = bindingReport('workbench.session.new', 'Primary+N', {}, new Map(), 'other')
    expect(report.browserReservedNote).toBe('reserved.note.newWindow')
  })
})
