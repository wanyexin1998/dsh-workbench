// T4 — active-node tracking (pure, seam A).
// Given the rendered human-input anchors with viewport coordinates,
// pick the node the reader is currently at: the last anchor whose top
// is above the reading line (30% down the viewport).

export interface AnchorRect {
  readonly key: string
  readonly top: number
}

export const READING_LINE_RATIO = 0.3

export function findActiveKey(
  anchors: readonly AnchorRect[],
  viewportTop: number,
  viewportHeight: number,
): string | null {
  const readingLine = viewportTop + viewportHeight * READING_LINE_RATIO
  let active: string | null = null
  for (const anchor of anchors) {
    if (anchor.top <= readingLine) active = anchor.key
    else break // anchors are ordered top-to-bottom
  }
  return active
}
