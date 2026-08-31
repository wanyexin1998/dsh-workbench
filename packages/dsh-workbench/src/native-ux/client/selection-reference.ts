import type {
  InputTriggerSource, ReferenceCodec, ReferenceInsert, TokenSpan,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ConversationSelection } from './selection-contract.js'
import type { SessionInputFace } from './harness-adapter.js'
import {
  SIDE_CHAT_REFERENCE_VERSION,
  serializeSideChatReference,
  type StructuredSelectionReference,
} from './side-chat-actions.js'

export const SELECTION_REFERENCE_SOURCE = 'dsh-workbench.selection'
export const SIDE_CHAT_REFERENCE_SOURCE = 'dsh-workbench.side-chat-selection'
export const SELECTION_AGGREGATE_VERSION = 'aggregate-v1' as const

export interface SelectionAggregateItem {
  readonly id: string
  readonly parentSessionId: string
  readonly nodeKey: string
  readonly nodeKind: string
  readonly atSeq: number
  readonly text: string
  readonly startOffset: number
  readonly endOffset: number
  readonly comment?: string
}

export interface SelectionAggregateV1 {
  readonly version: typeof SELECTION_AGGREGATE_VERSION
  readonly items: readonly SelectionAggregateItem[]
}

export interface SelectionOccurrence {
  readonly source: string
  readonly ref: string
  readonly offset: number
  readonly length: number
}

export interface SelectionInputSnapshot {
  readonly draft: string
  readonly draftRev: number
  readonly occurrences: readonly SelectionOccurrence[]
}

/** Minimal public SessionInput face used by aggregate mutations. */
export interface SelectionInput {
  readonly state: { getSnapshot(): SelectionInputSnapshot }
  insertReference(reference: ReferenceInsert, span: TokenSpan): boolean
  consumeSpan(span: TokenSpan): boolean
  notify?(level: 'info' | 'error', text: string): void
}

export type SelectionMutationResult =
  | { readonly ok: true; readonly aggregate: SelectionAggregateV1 }
  | { readonly ok: false; readonly reason: 'invalid-reference' | 'missing-reference' | 'multiple-references' | 'stale-draft' }

export type SideChatReferenceInsertResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'ordinary-draft-not-empty' | 'stale-draft' }

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function finiteOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseItem(value: unknown): SelectionAggregateItem | null {
  const item = record(value)
  if (item === null || typeof item.id !== 'string' || item.id.length === 0) return null
  if (typeof item.parentSessionId !== 'string' || item.parentSessionId.length === 0) return null
  if (typeof item.nodeKey !== 'string' || item.nodeKey.length === 0 || typeof item.nodeKind !== 'string' || item.nodeKind.length === 0) return null
  if (!finiteOffset(item.atSeq) || !finiteOffset(item.startOffset) || !finiteOffset(item.endOffset) || item.endOffset <= item.startOffset) return null
  if (typeof item.text !== 'string' || (item.comment !== undefined && typeof item.comment !== 'string')) return null
  return {
    id: item.id,
    parentSessionId: item.parentSessionId,
    nodeKey: item.nodeKey,
    nodeKind: item.nodeKind,
    atSeq: item.atSeq,
    text: item.text,
    startOffset: item.startOffset,
    endOffset: item.endOffset,
    ...(typeof item.comment === 'string' && item.comment.length > 0 ? { comment: item.comment } : {}),
  }
}

export function decodeSelectionAggregate(ref: string): SelectionAggregateV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(ref)
  } catch {
    throw new Error('Invalid Workbench selection reference')
  }
  const value = record(parsed)
  if (value?.version !== SELECTION_AGGREGATE_VERSION || !Array.isArray(value.items) || value.items.length === 0) {
    throw new Error('Invalid Workbench selection reference')
  }
  const items = value.items.map(parseItem)
  if (items.some((item) => item === null)) throw new Error('Invalid Workbench selection reference')
  const ids = new Set(items.map((item) => item!.id))
  if (ids.size !== items.length) throw new Error('Invalid Workbench selection reference')
  return { version: SELECTION_AGGREGATE_VERSION, items: items as SelectionAggregateItem[] }
}

export function encodeSelectionAggregate(aggregate: SelectionAggregateV1): string {
  return JSON.stringify(aggregate)
}

export function decodeSideChatReference(ref: string): StructuredSelectionReference {
  let parsed: unknown
  try {
    parsed = JSON.parse(ref)
  } catch {
    throw new Error('Invalid Workbench side-chat reference')
  }
  const value = record(parsed)
  const rect = record(value?.rect)
  if (value?.version !== SIDE_CHAT_REFERENCE_VERSION
    || value.kind !== 'side-chat-selection'
    || typeof value.referenceBoundary !== 'string'
    || value.referenceBoundary.length === 0
    || typeof value.parentSessionId !== 'string'
    || value.parentSessionId.length === 0
    || typeof value.nodeKey !== 'string'
    || value.nodeKey.length === 0
    || typeof value.nodeKind !== 'string'
    || value.nodeKind.length === 0
    || !finiteOffset(value.atSeq)
    || typeof value.text !== 'string'
    || !finiteOffset(value.startOffset)
    || !finiteOffset(value.endOffset)
    || value.endOffset <= value.startOffset
    || rect === null
    || !finiteNumber(rect.x)
    || !finiteNumber(rect.y)
    || !finiteNumber(rect.width)
    || !finiteNumber(rect.height)) {
    throw new Error('Invalid Workbench side-chat reference')
  }
  return {
    version: SIDE_CHAT_REFERENCE_VERSION,
    kind: 'side-chat-selection',
    referenceBoundary: value.referenceBoundary,
    parentSessionId: value.parentSessionId,
    nodeKey: value.nodeKey,
    nodeKind: value.nodeKind,
    atSeq: value.atSeq,
    text: value.text,
    startOffset: value.startOffset,
    endOffset: value.endOffset,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  }
}

export function encodeSideChatReference(reference: StructuredSelectionReference): string {
  return JSON.stringify(reference)
}

export function selectionItem(selection: ConversationSelection, id: string, comment?: string): SelectionAggregateItem {
  return {
    id,
    parentSessionId: selection.parentSessionId,
    nodeKey: selection.nodeKey,
    nodeKind: selection.nodeKind,
    atSeq: selection.atSeq,
    text: selection.text,
    startOffset: selection.startOffset,
    endOffset: selection.endOffset,
    ...(comment !== undefined && comment.length > 0 ? { comment } : {}),
  }
}

function aggregateReference(aggregate: SelectionAggregateV1, label: string): ReferenceInsert {
  const ref = encodeSelectionAggregate(aggregate)
  return {
    source: SELECTION_REFERENCE_SOURCE,
    ref,
    label,
    clipboardText: selectionReferenceCodec.clipboardText(ref),
  }
}

function ownedOccurrences(snapshot: SelectionInputSnapshot): readonly SelectionOccurrence[] {
  return snapshot.occurrences.filter((occurrence) => occurrence.source === SELECTION_REFERENCE_SOURCE)
}

export function readSelectionAggregate(snapshot: SelectionInputSnapshot): {
  readonly aggregate: SelectionAggregateV1
  readonly occurrence: SelectionOccurrence
} | null {
  const occurrences = ownedOccurrences(snapshot)
  if (occurrences.length !== 1) return null
  try {
    return { aggregate: decodeSelectionAggregate(occurrences[0]!.ref), occurrence: occurrences[0]! }
  } catch {
    return null
  }
}

function replaceAggregate(
  input: SelectionInput,
  snapshot: SelectionInputSnapshot,
  occurrence: SelectionOccurrence,
  aggregate: SelectionAggregateV1,
  label: string,
): SelectionMutationResult {
  const applied = input.insertReference(aggregateReference(aggregate, label), {
    start: occurrence.offset,
    end: occurrence.offset + occurrence.length,
    draftRev: snapshot.draftRev,
  })
  return applied ? { ok: true, aggregate } : { ok: false, reason: 'stale-draft' }
}

export function appendSelectionReference(
  input: SelectionInput,
  selection: ConversationSelection,
  itemId: string,
  label: string,
  comment?: string,
): SelectionMutationResult {
  const snapshot = input.state.getSnapshot()
  const occurrences = ownedOccurrences(snapshot)
  if (occurrences.length > 1) return { ok: false, reason: 'multiple-references' }
  const item = selectionItem(selection, itemId, comment)
  if (occurrences.length === 0) {
    const aggregate: SelectionAggregateV1 = { version: SELECTION_AGGREGATE_VERSION, items: [item] }
    const applied = input.insertReference(aggregateReference(aggregate, label), {
      start: snapshot.draft.length,
      end: snapshot.draft.length,
      draftRev: snapshot.draftRev,
    })
    return applied ? { ok: true, aggregate } : { ok: false, reason: 'stale-draft' }
  }
  let aggregate: SelectionAggregateV1
  try {
    aggregate = decodeSelectionAggregate(occurrences[0]!.ref)
  } catch {
    return { ok: false, reason: 'invalid-reference' }
  }
  if (aggregate.items.some((existing) => existing.id === itemId)) return { ok: false, reason: 'invalid-reference' }
  const next: SelectionAggregateV1 = { ...aggregate, items: [...aggregate.items, item] }
  return replaceAggregate(input, snapshot, occurrences[0]!, next, label)
}

export function updateSelectionComment(
  input: SelectionInput,
  itemId: string,
  comment: string,
  label: string,
): SelectionMutationResult {
  const snapshot = input.state.getSnapshot()
  const occurrences = ownedOccurrences(snapshot)
  if (occurrences.length === 0) return { ok: false, reason: 'missing-reference' }
  if (occurrences.length > 1) return { ok: false, reason: 'multiple-references' }
  let aggregate: SelectionAggregateV1
  try {
    aggregate = decodeSelectionAggregate(occurrences[0]!.ref)
  } catch {
    return { ok: false, reason: 'invalid-reference' }
  }
  if (!aggregate.items.some((item) => item.id === itemId)) return { ok: false, reason: 'missing-reference' }
  const next: SelectionAggregateV1 = {
    ...aggregate,
    items: aggregate.items.map((item) => item.id === itemId
      ? { ...item, comment: comment.length > 0 ? comment : undefined }
      : item),
  }
  return replaceAggregate(input, snapshot, occurrences[0]!, next, label)
}

export function removeSelectionItem(input: SelectionInput, itemId: string, label: string): SelectionMutationResult {
  const snapshot = input.state.getSnapshot()
  const occurrences = ownedOccurrences(snapshot)
  if (occurrences.length === 0) return { ok: false, reason: 'missing-reference' }
  if (occurrences.length > 1) return { ok: false, reason: 'multiple-references' }
  let aggregate: SelectionAggregateV1
  try {
    aggregate = decodeSelectionAggregate(occurrences[0]!.ref)
  } catch {
    return { ok: false, reason: 'invalid-reference' }
  }
  const items = aggregate.items.filter((item) => item.id !== itemId)
  if (items.length === aggregate.items.length) return { ok: false, reason: 'missing-reference' }
  if (items.length > 0) {
    return replaceAggregate(input, snapshot, occurrences[0]!, { ...aggregate, items }, label)
  }

  const occurrence = occurrences[0]!
  // Consume the occurrence and its machine-generated separator as two CAS
  // edits. Keeping the separator for the first edit makes the old range begin
  // with the reference marker while the new tail begins with a space, so the
  // input machine's fallback diff cannot mistake an adjacent same-label
  // occurrence for the deleted one.
  const removed = input.consumeSpan({
    start: occurrence.offset,
    end: occurrence.offset + occurrence.length,
    draftRev: snapshot.draftRev,
  })
  if (!removed) return { ok: false, reason: 'stale-draft' }
  const afterRemoval = input.state.getSnapshot()
  if (afterRemoval.draft[occurrence.offset] === ' ') {
    input.consumeSpan({
      start: occurrence.offset,
      end: occurrence.offset + 1,
      draftRev: afterRemoval.draftRev,
    })
  }
  return { ok: true, aggregate: { ...aggregate, items: [] } }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export const selectionReferenceCodec: ReferenceCodec = {
  clipboardText(ref) {
    const aggregate = decodeSelectionAggregate(ref)
    return aggregate.items.map((item) => item.comment === undefined ? item.text : `${item.text}\nComment: ${item.comment}`).join('\n\n')
  },
  async serialize(ref, signal) {
    if (signal.aborted) throw new DOMException('Selection serialization aborted', 'AbortError')
    const aggregate = decodeSelectionAggregate(ref)
    const items = aggregate.items.map((item, index) => {
      const attributes = [
        `index="${index + 1}"`,
        `parent_session_id="${escapeXml(item.parentSessionId)}"`,
        `node_key="${escapeXml(item.nodeKey)}"`,
        `node_kind="${escapeXml(item.nodeKind)}"`,
        `at_seq="${item.atSeq}"`,
        `start_offset="${item.startOffset}"`,
        `end_offset="${item.endOffset}"`,
      ].join(' ')
      const comment = item.comment === undefined ? '' : `\n    <comment>${escapeXml(item.comment)}</comment>`
      return `  <selection ${attributes}>\n    <text>${escapeXml(item.text)}</text>${comment}\n  </selection>`
    })
    return `<selected_context version="${SELECTION_AGGREGATE_VERSION}">\n${items.join('\n')}\n</selected_context>`
  },
}

/** Codec owner only: it deliberately contributes no @ candidates or pick behavior. */
export function createSelectionReferenceSource(): InputTriggerSource {
  return {
    trigger: '@',
    name: SELECTION_REFERENCE_SOURCE,
    showGroupTitle: false,
    candidates: async () => [],
    onPick: () => undefined,
    codec: selectionReferenceCodec,
  }
}

export const sideChatReferenceCodec: ReferenceCodec = {
  clipboardText: ref => decodeSideChatReference(ref).text,
  async serialize(ref, signal) {
    if (signal.aborted) throw new DOMException('Side-chat selection serialization aborted', 'AbortError')
    return serializeSideChatReference(decodeSideChatReference(ref))
  },
}

/** Side-chat codec owner only: zero candidates and no plain-text fallback. */
export function createSideChatReferenceSource(): InputTriggerSource {
  return {
    trigger: '@',
    name: SIDE_CHAT_REFERENCE_SOURCE,
    showGroupTitle: false,
    candidates: async () => [],
    onPick: () => undefined,
    codec: sideChatReferenceCodec,
  }
}

/** Insert at the empty child draft using the exact observed draft revision. */
export function insertSideChatReference(
  input: Pick<SessionInputFace, 'insertReference'> & {
    readonly state: { getSnapshot(): { readonly draft: string; readonly draftRev: number } }
  },
  reference: StructuredSelectionReference,
  label: string,
): SideChatReferenceInsertResult {
  const snapshot = input.state.getSnapshot()
  if (snapshot.draft !== '') return { ok: false, reason: 'ordinary-draft-not-empty' }
  const ref = encodeSideChatReference(reference)
  const applied = input.insertReference({
    source: SIDE_CHAT_REFERENCE_SOURCE,
    ref,
    label,
    clipboardText: sideChatReferenceCodec.clipboardText(ref),
  }, { start: 0, end: 0, draftRev: snapshot.draftRev })
  return applied ? { ok: true } : { ok: false, reason: 'stale-draft' }
}
