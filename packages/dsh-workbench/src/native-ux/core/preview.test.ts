import { afterEach, describe, expect, it } from 'vitest'
import { ATTACHMENT_PREVIEW, collapseWhitespace, previewOf, truncateVisual } from './preview.js'

describe('previewOf', () => {
  it('uses the first meaningful text block', () => {
    const preview = previewOf([
      { kind: 'image' },
      { kind: 'text', text: '  重新设计\n数据模型  ' },
      { kind: 'text', text: 'ignored' },
    ])
    expect(preview).toBe('重新设计 数据模型')
  })

  it('collapses whitespace runs and folds newlines', () => {
    expect(collapseWhitespace('  a   b\n\nc ')).toBe('a b c')
  })

  it('truncates beyond 80 visual chars with an ellipsis', () => {
    const long = 'x'.repeat(90)
    const preview = previewOf([{ kind: 'text', text: long }])
    expect(preview.length).toBe(81) // 80 + ellipsis
    expect(preview.endsWith('…')).toBe(true)
  })

  it('is code-point safe on emoji', () => {
    const emoji = '😀'.repeat(100)
    const out = truncateVisual(emoji, 5)
    expect(Array.from(out).length).toBe(6) // 5 + ellipsis
    expect(out.startsWith('😀😀😀')).toBe(true)
  })

  it('skips a whitespace-only first block and uses the next meaningful one', () => {
    const preview = previewOf([{ kind: 'text', text: '  \n  ' }, { kind: 'text', text: '真实问题' }])
    expect(preview).toBe('真实问题')
  })

  it('shows the attachment placeholder for text-less input', () => {
    expect(previewOf([{ kind: 'image' }])).toBe(ATTACHMENT_PREVIEW)
    expect(previewOf([])).toBe(ATTACHMENT_PREVIEW)
    expect(previewOf([{ kind: 'text', text: '   ' }])).toBe(ATTACHMENT_PREVIEW)
  })
})

// GA-035 — grapheme-safe truncation: ZWJ-composed clusters stay whole.
const FAMILY = '👨‍👩‍👧‍👦' // 7 code points, 1 grapheme (ZWJ-composed)
const hasSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'

function graphemeCount(text: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  let count = 0
  for (const _ of segmenter.segment(text)) count++
  return count
}

describe('truncateVisual grapheme safety (GA-035)', () => {
  it.skipIf(!hasSegmenter)('keeps ZWJ family emoji whole when truncating', () => {
    const text = FAMILY.repeat(30) // 30 graphemes, 210 code points
    const out = truncateVisual(text, 5)
    expect(out).toBe(FAMILY.repeat(5) + '…')
    expect(graphemeCount(out)).toBe(6) // 5 graphemes + ellipsis
  })

  it.skipIf(!hasSegmenter)('keeps ZWJ clusters whole in mixed CJK + emoji text', () => {
    const text = `汉${FAMILY}字`.repeat(6) // 18 graphemes
    const out = truncateVisual(text, 4)
    expect(out).toBe(`汉${FAMILY}字汉…`)
  })

  it.skipIf(!hasSegmenter)('keeps skin-tone modifier clusters whole', () => {
    const thumbs = '👍🏽' // 2 code points, 1 grapheme
    const out = truncateVisual(thumbs.repeat(20), 3)
    expect(out).toBe(thumbs.repeat(3) + '…')
  })

  it.skipIf(!hasSegmenter)('previewOf truncates ZWJ input without broken clusters', () => {
    const preview = previewOf([{ kind: 'text', text: FAMILY.repeat(90) }])
    expect(preview).toBe(FAMILY.repeat(80) + '…')
    expect(graphemeCount(preview)).toBe(81)
  })

  it.skipIf(!hasSegmenter)('returns short ZWJ text unchanged', () => {
    const text = FAMILY.repeat(3)
    expect(truncateVisual(text, 5)).toBe(text)
  })
})

describe('truncateVisual fallback without Intl.Segmenter (GA-035)', () => {
  const originalSegmenter = Intl.Segmenter

  afterEach(() => {
    ;(Intl as { Segmenter: typeof Intl.Segmenter | undefined }).Segmenter = originalSegmenter
  })

  it('falls back to code-point truncation without throwing', () => {
    ;(Intl as { Segmenter: typeof Intl.Segmenter | undefined }).Segmenter = undefined
    const text = FAMILY.repeat(30) // 210 code points
    const out = truncateVisual(text, 5)
    expect(Array.from(out).length).toBe(6) // 5 code points + ellipsis
    expect(out.endsWith('…')).toBe(true)
  })

  it('keeps plain-text behaviour identical in the fallback', () => {
    ;(Intl as { Segmenter: typeof Intl.Segmenter | undefined }).Segmenter = undefined
    expect(truncateVisual('x'.repeat(90), 80)).toBe('x'.repeat(80) + '…')
    expect(truncateVisual('short', 80)).toBe('short')
  })
})
