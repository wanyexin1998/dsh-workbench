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

export const SIDE_CHAT_REFERENCE_VERSION = 'side-chat-v1' as const

export const SIDE_CHAT_COPY: Readonly<Record<'en' | 'zh', SideChatCopy>> = {
  en: {
    referenceBoundary: 'Inherited conversation history is reference-only. The current task begins after this boundary. Give a lightweight, non-modifying explanation unless the user explicitly requests changes.',
    moreDetailsRequest: 'Explain the selected context in more detail.',
  },
  zh: {
    referenceBoundary: '继承的会话历史仅供参考。当前任务从此边界之后开始。除非用户明确要求修改，否则请只做轻量、非修改性的解释。',
    moreDetailsRequest: '请更详细地解释所选上下文。',
  },
}

export interface StructuredSelectionReference {
  readonly version: typeof SIDE_CHAT_REFERENCE_VERSION
  readonly kind: 'side-chat-selection'
  /** Serialized by the side-chat reference codec before selected context. */
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

function xmlEscape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** Existing user-input path: one text block, no hidden prompt/event channel. */
export function composeMoreDetailsPrompt(
  selection: ConversationSelection,
  copy: SideChatCopy,
): string {
  const reference = structuredSelectionReference(selection, copy)
  return [
    serializeSideChatReference(reference),
    '<request>',
    xmlEscape(copy.moreDetailsRequest),
    '</request>',
  ].join('\n')
}

/** Model-visible projection the draft reference codec must reproduce on submit. */
export function serializeSideChatReference(reference: StructuredSelectionReference): string {
  const attributes = [
    `version="${SIDE_CHAT_REFERENCE_VERSION}"`,
    `parent_session_id="${xmlEscape(reference.parentSessionId)}"`,
    `node_key="${xmlEscape(reference.nodeKey)}"`,
    `node_kind="${xmlEscape(reference.nodeKind)}"`,
    `at_seq="${reference.atSeq}"`,
    `start_offset="${reference.startOffset}"`,
    `end_offset="${reference.endOffset}"`,
  ].join(' ')
  return [
    '<side_chat_boundary>',
    xmlEscape(reference.referenceBoundary),
    '</side_chat_boundary>',
    `<selected_context ${attributes}>`,
    xmlEscape(reference.text),
    '</selected_context>',
  ].join('\n')
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
