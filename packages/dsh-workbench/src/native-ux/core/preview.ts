// T2 — preview rules (tech design §8.1): first meaningful text block,
// whitespace collapsed, single line, 50–90 visual chars truncated.
import type { ContentBlockView } from './derive-index.js'

export const PREVIEW_MAX_CHARS = 80
export const ATTACHMENT_PREVIEW = '图片或附件输入'

/**
 * Collapse runs of whitespace to a single space and strip the
 * outermost whitespace. Newlines fold into spaces (single-line rule).
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Truncate to at most `max` visual characters.
 *
 * GA-035: grapheme-safe when `Intl.Segmenter` is available — ZWJ-composed
 * sequences (family emoji, skin tones, flags) are never split mid-cluster.
 * Falls back to the previous code-point-safe behaviour otherwise (surrogate
 * pairs stay whole, ZWJ sequences may be cut). No external dependencies.
 */
let graphemeSegmenter: Intl.Segmenter | null = null

function getGraphemeSegmenter(): Intl.Segmenter | null {
  // Availability is re-checked on every call so a runtime without
  // Intl.Segmenter always takes the fallback path.
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null
  if (graphemeSegmenter === null) {
    graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  }
  return graphemeSegmenter
}

export function truncateVisual(text: string, max: number = PREVIEW_MAX_CHARS): string {
  const segmenter = getGraphemeSegmenter()
  if (segmenter !== null) {
    const graphemes: string[] = []
    for (const { segment } of segmenter.segment(text)) {
      graphemes.push(segment)
      if (graphemes.length > max) return graphemes.slice(0, max).join('') + '…'
    }
    return text // grapheme count <= max: nothing to truncate
  }
  // Fallback: code-point safe (surrogate pairs are not split).
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return chars.slice(0, max).join('') + '…'
}

/**
 * First meaningful text block: a block is meaningful when it carries
 * a non-empty `text`. Blocks without text (images, tools, reasoning
 * payloads) are skipped; a node with only non-text blocks previews as
 * the attachment placeholder.
 */
export function firstMeaningfulText(content: readonly ContentBlockView[]): string | null {
  for (const block of content) {
    if (typeof block.text === 'string') {
      const collapsed = collapseWhitespace(block.text)
      if (collapsed.length > 0) return collapsed // skip whitespace-only blocks
    }
  }
  return null
}

/** Build the single-line preview for one human input's content. */
export function previewOf(content: readonly ContentBlockView[]): string {
  const raw = firstMeaningfulText(content)
  if (raw === null) return ATTACHMENT_PREVIEW
  return truncateVisual(raw)
}
