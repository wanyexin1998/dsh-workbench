import {
  openBeside,
  preflightBesideOpen,
  type BesidePresentation,
  type ReplaceApproval,
} from './beside-open.js'
import { focusSessionComposer } from './chat-actions.js'
import {
  sideChatServices,
  type HarnessServices,
  type SessionInputFace,
  type SideChatServices,
} from './harness-adapter.js'
import type { ConversationSelection } from './selection-contract.js'

export type SideChatActionKind = 'more-details' | 'ask-in-side-chat'

export type SideChatStatusCode =
  | 'side-chat-unavailable'
  | 'selection-stale'
  | 'source-not-visible'
  | 'confirm-replace'
  | 'replace-cancelled'
  | 'preflight-failed'
  | 'fork-failed'
  | 'child-opened-and-sent'
  | 'child-opened-with-draft'
  | 'child-open-partial'
  | 'child-send-partial'
  | 'child-draft-partial'
  | 'child-focus-partial'

export interface SideChatStatus {
  readonly code: SideChatStatusCode
  readonly level: 'success' | 'info' | 'error'
  readonly action: SideChatActionKind
  readonly childId?: string
  readonly replacedSessionId?: string
}

export type SideChatResult =
  | {
    readonly kind: 'opened'
    readonly action: SideChatActionKind
    readonly childId: string
    readonly delivery: 'sent' | 'draft'
    readonly status: SideChatStatus
  }
  | {
    readonly kind: 'unavailable'
    readonly action: SideChatActionKind
    readonly status: SideChatStatus
  }
  | {
    readonly kind: 'stale-selection'
    readonly action: SideChatActionKind
    readonly error?: unknown
    readonly status: SideChatStatus
  }
  | {
    readonly kind: 'source-not-visible'
    readonly action: SideChatActionKind
    readonly status: SideChatStatus
  }
  | {
    readonly kind: 'cancelled'
    readonly action: SideChatActionKind
    readonly replacedSessionId: string
    readonly status: SideChatStatus
  }
  | {
    readonly kind: 'failed'
    readonly action: SideChatActionKind
    readonly stage: 'preflight' | 'fork'
    readonly error: unknown
    readonly status: SideChatStatus
  }
  | {
    readonly kind: 'partial'
    readonly action: SideChatActionKind
    readonly childId: string
    readonly stage: 'source-not-visible' | 'open' | 'send' | 'draft' | 'focus'
    readonly error?: unknown
    readonly status: SideChatStatus
  }

export interface SideChatCopy {
  readonly referenceBoundary: string
  readonly moreDetailsRequest: string
}

/**
 * Prose labels the "add to conversation" projection needs.
 *
 * 路径 3 没有 fork，也就没有边界声明，装订线只是排版约定而不是声明，所以必须有
 * 一句散文告诉模型"下面这些是引用的上文"。这些串在 `src/client/dictionaries.ts`
 * 里另有一份 `selection.quote.*` 真相（宿主 UI 走 `t()`），改一处就要改另一处。
 */
export interface SelectionQuoteCopy {
  /** Prose label above a single quoted passage. */
  readonly quoteHeading: string
  /** Prose label above several quoted passages; `{count}` is the passage count. */
  readonly quoteHeadingMultiple: string
  /** Per-passage label used only when several are quoted; `{index}` is 1-based. */
  readonly quoteItem: string
  /** Prefix for a user-authored note about the passage above it. */
  readonly quoteNote: string
}

export const SIDE_CHAT_REFERENCE_VERSION = 'side-chat-v1' as const

export const SIDE_CHAT_COPY: Readonly<Record<'en' | 'zh', SideChatCopy>> = {
  en: {
    referenceBoundary: 'Inherited conversation history is reference-only. The current task begins after this boundary. Give a lightweight, non-modifying explanation unless the user explicitly requests changes.',
    // 消息里唯一存在的容器就是上面那个装订线引用块，文案必须指向它本身，
    // 而不是指向早已删掉的 <selected_context> 容器。
    moreDetailsRequest: 'Explain the quoted passage above in more detail.',
  },
  zh: {
    referenceBoundary: '继承的会话历史仅供参考。当前任务从此边界之后开始。除非用户明确要求修改，否则请只做轻量、非修改性的解释。',
    moreDetailsRequest: '请更详细地解释上面引用的内容。',
  },
}

export const SELECTION_QUOTE_COPY: Readonly<Record<'en' | 'zh', SelectionQuoteCopy>> = {
  en: {
    quoteHeading: 'Quoting from above:',
    quoteHeadingMultiple: 'Quoting from above ({count} passages)',
    quoteItem: 'Quote {index}:',
    quoteNote: 'Note: ',
  },
  zh: {
    quoteHeading: '引用上文：',
    quoteHeadingMultiple: '引用上文（{count} 处）',
    quoteItem: '引用 {index}：',
    quoteNote: '备注：',
  },
}

/** The unprefixed heading line that opens an "add to conversation" projection. */
export function quoteHeading(copy: SelectionQuoteCopy, count: number): string {
  return count <= 1 ? copy.quoteHeading : copy.quoteHeadingMultiple.replace('{count}', String(count))
}

/** The unprefixed per-passage label; only emitted when more than one is quoted. */
export function quoteItemLabel(copy: SelectionQuoteCopy, index: number): string {
  return copy.quoteItem.replace('{index}', String(index))
}

export interface StructuredSelectionReference {
  readonly version: typeof SIDE_CHAT_REFERENCE_VERSION
  readonly kind: 'side-chat-selection'
  /** Serialized by the side-chat reference codec after the quoted passage. */
  readonly referenceBoundary: string
  readonly parentSessionId: string
  readonly nodeKey: string
  readonly nodeKind: string
  readonly atSeq: number
  readonly text: string
  readonly startOffset: number
  readonly endOffset: number
  readonly rect: ConversationSelection['rect']
}

export interface SideChatConfirmation {
  readonly action: SideChatActionKind
  readonly sourceSessionId: string
  readonly replacedSessionId: string
  readonly status: SideChatStatus
}

export interface DraftReferenceRequest {
  readonly childId: string
  readonly input: SessionInputFace
  readonly reference: StructuredSelectionReference
  /** Ordinary user-authored text remains empty; only the reference is inserted. */
  readonly ordinaryDraft: ''
}

export interface SideChatActionDependencies {
  readonly services: HarnessServices
  readonly revalidateSelection: (selection: ConversationSelection) => boolean | Promise<boolean>
  readonly confirmReplace: (request: SideChatConfirmation) => boolean | Promise<boolean>
  readonly insertDraftReference: (request: DraftReferenceRequest) => void | Promise<void>
  readonly copy?: SideChatCopy
  readonly focusComposer?: (sessionId: string) => boolean | void | Promise<boolean | void>
}

export interface SideChatActions {
  readonly available: boolean
  moreDetails(selection: ConversationSelection): Promise<SideChatResult>
  askInSideChat(selection: ConversationSelection): Promise<SideChatResult>
}

function status(
  code: SideChatStatusCode,
  level: SideChatStatus['level'],
  action: SideChatActionKind,
  details: { readonly childId?: string; readonly replacedSessionId?: string } = {},
): SideChatStatus {
  return { code, level, action, ...details }
}

/** Gutter carried by every line that came out of the user's selection. */
export const QUOTE_GUTTER = '│ '
/** Gutter carried by a user-authored note about the passage above it. */
export const NOTE_GUTTER = '↳ '

/**
 * 每一个"宿主会当成强制换行来渲染"的码点。
 *
 * 装订线的防伪前提是"用户内容贡献的每一行都带前缀"，而"行"由渲染决定，不由
 * `\n` 决定：宿主用 `white-space: pre-wrap` 原样渲染，断行遵循 UAX#14，其中
 * BK/NL 类（VT U+000B、FF U+000C、NEL U+0085、LS U+2028、PS U+2029）与 CR/LF
 * 一样是强制换行。只按 `\r\n?|\n` 切分会让含 U+2028 的选区产出一条视觉上顶格
 * 无前缀的行——正是装订线要堵的那个洞。这里把它们统一归一成 `\n`。
 */
const FORCED_LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/

/** Prefix every rendered line of `text` with `prefix`. */
function gutter(text: string, prefix: string): string {
  return text.split(FORCED_LINE_BREAK).map(line => prefix + line).join('\n')
}

/**
 * 给选区原文的每一行加装订线。
 *
 * 装订线不只是装饰，它是防伪边界：选区贡献的每一行都带前缀，所以选中的内容
 * 无法伪造出一条无前缀的结构行（边界声明、请求、引用标题、备注）。这就是删掉
 * XML 转义之后仍然成立的结构完整性机制——被引用的文本再怎么写都留在装订线之内。
 */
export function quoteBlock(text: string): string {
  return gutter(text, QUOTE_GUTTER)
}

/**
 * 给用户备注的每一行加装订线。
 *
 * 评论框今天是 `<input type="text">`（见 selection-actions.tsx），浏览器会剥掉
 * CR/LF，所以 UI 路径走不出多行备注；但备注是用户内容，防伪不变量不能建立在
 * "上游控件恰好过滤了换行"之上——粘贴、程序化写入、控件换成 textarea 都会破坏它。
 */
export function noteBlock(comment: string): string {
  return gutter(comment, NOTE_GUTTER)
}

/** Existing user-input path: one text block, no hidden prompt/event channel. */
export function composeMoreDetailsPrompt(
  selection: ConversationSelection,
  copy: SideChatCopy,
): string {
  const reference = structuredSelectionReference(selection, copy)
  return `${serializeSideChatReference(reference)}\n\n${copy.moreDetailsRequest}`
}

/**
 * Model-visible projection the draft reference codec must reproduce on submit.
 *
 * 宿主用 `white-space: pre-wrap` 原样渲染用户气泡（不解析 Markdown），所以这条
 * 消息必须同时给人和模型读：没有 XML、没有内部标识符，只有装订线 + 纯文本。
 * 选区身份的重校验走内存里的 ConversationSelection，不经过文本往返。
 */
export function serializeSideChatReference(reference: StructuredSelectionReference): string {
  return `${quoteBlock(reference.text)}\n\n${reference.referenceBoundary}`
}

export function structuredSelectionReference(
  selection: ConversationSelection,
  copy: SideChatCopy,
): StructuredSelectionReference {
  return {
    version: SIDE_CHAT_REFERENCE_VERSION,
    kind: 'side-chat-selection',
    referenceBoundary: copy.referenceBoundary,
    parentSessionId: selection.parentSessionId,
    nodeKey: selection.nodeKey,
    nodeKind: selection.nodeKind,
    atSeq: selection.atSeq,
    text: selection.text,
    startOffset: selection.startOffset,
    endOffset: selection.endOffset,
    rect: selection.rect,
  }
}

function selectionKey(action: SideChatActionKind, selection: ConversationSelection): string {
  return JSON.stringify([
    action,
    selection.parentSessionId,
    selection.nodeKey,
    selection.nodeKind,
    selection.atSeq,
    selection.startOffset,
    selection.endOffset,
    selection.text,
  ])
}

function presentationOf(services: SideChatServices): BesidePresentation {
  return services.sessions.presentation as BesidePresentation
}

function retainedPartial(
  action: SideChatActionKind,
  childId: string,
  stage: Extract<SideChatResult, { kind: 'partial' }>['stage'],
  code: SideChatStatusCode,
  error?: unknown,
): SideChatResult {
  return {
    kind: 'partial', action, childId, stage,
    ...(error === undefined ? {} : { error }),
    status: status(code, 'error', action, { childId }),
  }
}

async function validateSelection(
  action: SideChatActionKind,
  selection: ConversationSelection,
  revalidate: SideChatActionDependencies['revalidateSelection'],
): Promise<SideChatResult | undefined> {
  try {
    if (await revalidate(selection)) return undefined
    return {
      kind: 'stale-selection', action,
      status: status('selection-stale', 'error', action),
    }
  } catch (error) {
    return {
      kind: 'stale-selection', action, error,
      status: status('selection-stale', 'error', action),
    }
  }
}

/** Dependency-injected core; UI registration and localized rendering live elsewhere. */
export function createSideChatActions(dependencies: SideChatActionDependencies): SideChatActions {
  const availableServices = sideChatServices(dependencies.services)
  const copy = dependencies.copy ?? SIDE_CHAT_COPY.en
  const focusComposer = dependencies.focusComposer ?? focusSessionComposer
  const inFlight = new Map<string, Promise<SideChatResult>>()

  const perform = async (
    action: SideChatActionKind,
    selection: ConversationSelection,
  ): Promise<SideChatResult> => {
    if (availableServices === undefined) {
      return {
        kind: 'unavailable', action,
        status: status('side-chat-unavailable', 'error', action),
      }
    }
    const invalid = await validateSelection(action, selection, dependencies.revalidateSelection)
    if (invalid !== undefined) return invalid

    const presentation = presentationOf(availableServices)
    const preflight = await preflightBesideOpen({
      presentation,
      sourceSessionId: selection.parentSessionId,
      confirmReplace: request => dependencies.confirmReplace({
        action,
        ...request,
        status: status('confirm-replace', 'info', action, {
          replacedSessionId: request.replacedSessionId,
        }),
      }),
    })
    if (preflight.kind === 'source-not-visible') {
      return {
        kind: 'source-not-visible', action,
        status: status('source-not-visible', 'error', action),
      }
    }
    if (preflight.kind === 'cancelled') {
      return {
        kind: 'cancelled', action, replacedSessionId: preflight.replacedSessionId,
        status: status('replace-cancelled', 'info', action, {
          replacedSessionId: preflight.replacedSessionId,
        }),
      }
    }
    if (preflight.kind === 'preflight-failed') {
      return {
        kind: 'failed', action, stage: 'preflight', error: preflight.error,
        status: status('preflight-failed', 'error', action),
      }
    }

    let childId: string
    try {
      childId = await availableServices.sessions.fork({
        sessionId: selection.parentSessionId,
        atSeq: selection.atSeq,
        increaseTitle: true,
      })
    } catch (error) {
      return {
        kind: 'failed', action, stage: 'fork', error,
        status: status('fork-failed', 'error', action),
      }
    }

    const opened = await openBeside({
      presentation,
      sourceSessionId: selection.parentSessionId,
      targetSessionId: childId,
      replaceApproval: preflight.replaceApproval,
      // Preflight owns side-chat confirmation. This path is unreachable for
      // the unchanged membership; returning false preserves fail-closed behavior.
      confirmReplace: () => false,
    })
    if (opened.kind === 'source-not-visible') {
      return retainedPartial(action, childId, 'source-not-visible', 'child-open-partial')
    }
    if (opened.kind !== 'opened') {
      return retainedPartial(
        action,
        childId,
        'open',
        'child-open-partial',
        opened.kind === 'open-failed' ? opened.error : undefined,
      )
    }

    const scope = availableServices.sessions.scope(childId)
    const conversation = scope?.get('conversation')
    if (action === 'more-details') {
      if (conversation?.send === undefined) {
        return retainedPartial(action, childId, 'send', 'child-send-partial', new Error('child conversation.send unavailable'))
      }
      try {
        await conversation.send(composeMoreDetailsPrompt(selection, copy))
      } catch (error) {
        return retainedPartial(action, childId, 'send', 'child-send-partial', error)
      }
      return {
        kind: 'opened', action, childId, delivery: 'sent',
        status: status('child-opened-and-sent', 'success', action, { childId }),
      }
    }

    if (scope === undefined || conversation?.input === undefined) {
      return retainedPartial(action, childId, 'draft', 'child-draft-partial', new Error('child conversation input unavailable'))
    }
    let input: SessionInputFace
    try {
      input = conversation.input.for(scope)
      await dependencies.insertDraftReference({
        childId,
        input,
        reference: structuredSelectionReference(selection, copy),
        ordinaryDraft: '',
      })
    } catch (error) {
      return retainedPartial(action, childId, 'draft', 'child-draft-partial', error)
    }
    try {
      const focused = await focusComposer(childId)
      if (focused === false) {
        return retainedPartial(action, childId, 'focus', 'child-focus-partial')
      }
    } catch (error) {
      return retainedPartial(action, childId, 'focus', 'child-focus-partial', error)
    }
    return {
      kind: 'opened', action, childId, delivery: 'draft',
      status: status('child-opened-with-draft', 'success', action, { childId }),
    }
  }

  const run = (action: SideChatActionKind, selection: ConversationSelection): Promise<SideChatResult> => {
    const key = selectionKey(action, selection)
    const existing = inFlight.get(key)
    if (existing !== undefined) return existing
    const attempt = perform(action, selection).finally(() => {
      if (inFlight.get(key) === attempt) inFlight.delete(key)
    })
    inFlight.set(key, attempt)
    return attempt
  }

  return {
    available: availableServices !== undefined,
    moreDetails: selection => run('more-details', selection),
    askInSideChat: selection => run('ask-in-side-chat', selection),
  }
}
