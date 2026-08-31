import type {
  InputTriggerSource, ReferenceCodec, ReferenceInsert, TokenSpan,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ConversationSelection } from './selection-contract.js'
import type { SessionInputFace } from './harness-adapter.js'
import {
  SELECTION_QUOTE_COPY,
  SIDE_CHAT_REFERENCE_VERSION,
  noteBlock,
  quoteBlock,
  quoteHeading,
  quoteItemLabel,
  serializeSideChatReference,
  type SelectionQuoteCopy,
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

/**
 * "添加到对话" 的模型可见形态。
 *
 * 这条路径没有 fork，也就没有边界声明。装订线是排版约定，不是声明——模型只看到
 * 用户草稿后面跟着一段 `│ ` 前缀的块，没有任何东西说"这是引用的上文"。所以散文
 * 标题（`copy.quoteHeading`）是这条路径唯一的语义标记，必须出现。
 *
 * 标题、条目标签、备注标签都不带装订线，而选区与备注贡献的每一行都带——防伪由
 * 这个反差成立：被引用的文本无论写什么都留在装订线之内，伪造不出结构行。
 *
 * 内部标识符（parent_session_id / node_key / offsets）全部不出现在文本里——
 * 全仓没有任何解析者，它们只在 JSON ref 里承担草稿重载的 schema 门禁。
 */
export function createSelectionReferenceCodec(copy: SelectionQuoteCopy): ReferenceCodec {
  return {
    clipboardText(ref) {
      const aggregate = decodeSelectionAggregate(ref)
      return aggregate.items.map((item) => item.comment === undefined ? item.text : `${item.text}\nComment: ${item.comment}`).join('\n\n')
    },
    async serialize(ref, signal) {
      if (signal.aborted) throw new DOMException('Selection serialization aborted', 'AbortError')
      const aggregate = decodeSelectionAggregate(ref)
      const many = aggregate.items.length > 1
      const blocks = aggregate.items.map((item, index) => {
        // 单条时标题本身就够定位，不再重复编号；多条时每块自带 "引用 N："。
        const head = many ? `${quoteItemLabel(copy, index + 1)}\n` : ''
        const note = item.comment === undefined ? '' : `\n${noteBlock(`${copy.quoteNote}${item.comment}`)}`
        return `${head}${quoteBlock(item.text)}${note}`
      })
      // 前导换行：这个块会被 splice 进用户草稿中间，不加换行会得到 "你好 引用上文："。
      // 引用在草稿开头时，宿主 sinkSerialized 的 out.trim() 会把它吃掉，所以是免费的。
      return `\n${quoteHeading(copy, aggregate.items.length)}\n${many ? '\n' : ''}${blocks.join('\n\n')}`
    },
  }
}

/**
 * 默认（英文）编解码器。
 *
 * 宿主 UI 应当把 `t('selection.quote.*')` 组成的 copy 传给
 * {@link createSelectionReferenceSource}；不传时退回这份英文默认，语义标记仍在。
 */
export const selectionReferenceCodec: ReferenceCodec = createSelectionReferenceCodec(SELECTION_QUOTE_COPY.en)

/** Codec owner only: it deliberately contributes no @ candidates or pick behavior. */
export function createSelectionReferenceSource(copy?: SelectionQuoteCopy): InputTriggerSource {
  return {
    trigger: '@',
    name: SELECTION_REFERENCE_SOURCE,
    showGroupTitle: false,
    candidates: async () => [],
    onPick: () => undefined,
    codec: copy === undefined ? selectionReferenceCodec : createSelectionReferenceCodec(copy),
  }
}

export const sideChatReferenceCodec: ReferenceCodec = {
  clipboardText: ref => decodeSideChatReference(ref).text,
  async serialize(ref, signal) {
    if (signal.aborted) throw new DOMException('Side-chat selection serialization aborted', 'AbortError')
    // 尾随换行：引用固定插在空草稿的第 0 位，草稿里紧跟其后的那一个换行
    //（见 breakAfterReference）与这里的换行合起来，让用户敲入的问题与边界声明
    // 之间空一行——与路径 1 的 composeMoreDetailsPrompt 排版逐字一致
    //（引用块 / 空行 / 边界声明 / 空行 / 用户那段）。
    return `${serializeSideChatReference(decodeSideChatReference(ref))}\n`
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

/** Face `insertSideChatReference` needs: insertion plus the separator cleanup below. */
type SideChatDraftInput = Pick<SessionInputFace, 'insertReference' | 'setDraft'> & {
  readonly state: { getSnapshot(): { readonly draft: string; readonly draftRev: number } }
}

/**
 * 把输入机在引用 token 后面补的那个分隔空格换成换行。
 *
 * 宿主 `sinkSerialized` 只对整串做一次 `out.trim()`，不碰串中间；这个空格正好
 * 落在序列化文本与用户后续输入之间，于是用户那一行会以一个空格开头。引用插在
 * 空草稿的第 0 位，所以插入后草稿恰好是「显示文本 + 一个空格」，末位即分隔符。
 *
 * 换行而不是直接删掉：`@` 触发器的词法是 `(?:^|\s)(@[^\s]*)$`（input-trigger 的
 * activeAtToken），紧贴 chip 敲字会让 `@显示文本` 重新变成一个活的 @ token 并弹出
 * 补全菜单——今天只因为英文 label 里恰好有空格才没发生，中文 label「侧聊选区」
 * 没有空格，删掉分隔符就会踩中。换行同样是 `\s`，两条扫描都会在此止步。
 *
 * 换行还顺带补齐了排版：序列化文本以 `\n` 收尾，加上这一个换行正好空一行，
 * 与路径 1 的 composeMoreDetailsPrompt 逐字同形。
 *
 * 输入机的 reconcile 保留"结束位置 <= 编辑起点"的 occurrence，改动末位字符不会
 * 动到 [0, 显示文本长度) 这条 occurrence，chip 与 CAS 都完好。
 * 空格不在（宿主换了实现）就什么都不做——退化回来只是这一个空格，不是错误。
 */
function breakAfterReference(input: SideChatDraftInput): void {
  const after = input.state.getSnapshot()
  if (!after.draft.endsWith(' ')) return
  input.setDraft(`${after.draft.slice(0, -1)}\n`)
}

/** Insert at the empty child draft using the exact observed draft revision. */
export function insertSideChatReference(
  input: SideChatDraftInput,
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
  if (!applied) return { ok: false, reason: 'stale-draft' }
  breakAfterReference(input)
  return { ok: true }
}
