// T2 — Navigator data projection (pure logic, seam A).
// Input is a minimal structural view so fixtures are trivial and the
// module stays decoupled from the real runtime snapshot shape.
import { isHumanInputKind } from './is-human-input.js'
import { previewOf } from './preview.js'

/** Minimal node view: only the fields the projection needs. */
export interface InputNodeView {
  readonly kind: string
  readonly key: string
  readonly seq: number
  readonly time?: number
  readonly content: readonly ContentBlockView[]
}

/** Minimal content block view (text blocks carry `text`). */
export interface ContentBlockView {
  readonly kind?: string
  readonly text?: string
}

/** Minimal data source: render order + keyed node lookup. */
export interface HumanInputSource {
  readonly order: readonly string[]
  getNode(key: string): InputNodeView | undefined
}

/** One navigator list entry (mirrors tech design §7 shape). */
export interface SessionNavigatorItem {
  readonly key: string
  readonly kind: 'user' | 'steering'
  readonly seq: number
  readonly time?: number
  readonly preview: string
}

/**
 * Derive the human-input index from a materialized chat window.
 * Only user/steering nodes pass; order follows the source order.
 */
export function deriveNavigatorIndex(source: HumanInputSource): SessionNavigatorItem[] {
  const items: SessionNavigatorItem[] = []
  for (const key of source.order) {
    const node = source.getNode(key)
    if (node === undefined) continue
    if (!isHumanInputKind(node.kind)) continue
    items.push({
      key: node.key,
      kind: node.kind,
      seq: node.seq,
      time: node.time,
      preview: previewOf(node.content),
    })
  }
  return items
}
