import * as React from 'react'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { HarnessServices } from './harness-adapter.js'
import { SelectionController, type SelectionSessions } from './selection-controller.js'
import type { ConversationSelection } from './selection-contract.js'
import {
  appendSelectionReference, createSelectionReferenceSource, createSideChatReferenceSource,
  insertSideChatReference, readSelectionAggregate, removeSelectionItem,
  updateSelectionComment, type SelectionInput,
  type SelectionInputSnapshot, type SelectionMutationResult,
} from './selection-reference.js'
import {
  createSideChatActions,
  type SideChatActions,
  type SideChatResult,
} from './side-chat-actions.js'

type Translate = (key: string, vars?: Record<string, string>) => string

interface SelectionSlots {
  inject(name: string, setup: () => unknown): unknown
  register(
    options: {
      name: string
      id: string
      label?: () => string
      locale?: string
      order?: number
      inject?: (sessionId: string) => Record<string, unknown>
    },
    component: unknown,
  ): () => void
}

export interface SelectionApplyContext {
  effect(setup: () => () => void, label?: string): unknown
}

export interface SelectionApplyServices {
  readonly sessions: SelectionSessions
  readonly conversation: IConversation
  readonly inputTriggers: InputTriggerServiceContract
  readonly slots: SelectionSlots
  readonly harness: HarnessServices
}

export interface SelectionActionResult {
  readonly ok: boolean
  readonly message?: string
}

function inputFor(services: SelectionApplyServices, sessionId: string): SelectionInput | null {
  const scope = services.sessions.scope?.(sessionId)
  if (scope === undefined) return null
  try {
    const input = services.conversation.input.for(scope as never)
    const eventScope = scope as {
      bail(subject: unknown, event: 'slash/input-consume-token', request: {
        guard: { kind: 'span'; span: { start: number; end: number; draftRev: number } }
      }): unknown
    }
    return {
      state: input.state as unknown as SelectionInput['state'],
      insertReference: (reference, span) => input.insertReference(reference, span),
      consumeSpan: (span) => eventScope.bail(eventScope, 'slash/input-consume-token', {
        guard: { kind: 'span', span },
      }) === true,
      notify: (level, text) => input.notify(level, text),
    }
  } catch {
    return null
  }
}

export function createSelectionItemId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return `selection-${cryptoApi.randomUUID()}`
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
    return `selection-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }
  return `selection-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function failureMessage(result: Extract<SelectionMutationResult, { readonly ok: false }>, t: Translate): string {
  return result.reason === 'stale-draft' ? t('selection.error.draftChanged') : t('selection.error.reference')
}

export function addSelectionToConversation(
  controller: SelectionController,
  services: SelectionApplyServices,
  selection: ConversationSelection,
  itemId: string,
  t: Translate,
): SelectionActionResult {
  const current = controller.revalidate(selection)
  if (current === null) return { ok: false, message: t('selection.error.stale') }
  const input = inputFor(services, current.parentSessionId)
  if (input === null) return { ok: false, message: t('selection.error.composer') }
  const result = appendSelectionReference(input, current, itemId, t('selection.reference.label'))
  if (!result.ok) {
    const message = failureMessage(result, t)
    input.notify?.('error', message)
    return { ok: false, message }
  }
  controller.focusSourceComposer()
  controller.clear()
  return { ok: true }
}

interface SelectionToolbarProps {
  readonly controller: SelectionController
  readonly onAdd: (selection: ConversationSelection) => SelectionActionResult
  readonly sideChat?: SideChatActions
  readonly t: Translate
}

interface ToolbarNotice {
  readonly message: string
  readonly role: 'status' | 'alert'
}

function sideResultNotice(result: Exclude<SideChatResult, { kind: 'opened' }>, t: Translate): ToolbarNotice {
  if (result.kind === 'cancelled') {
    return { message: t('selection.side.cancelled'), role: 'status' }
  }
  if (result.kind === 'stale-selection') {
    return { message: t('selection.error.stale'), role: 'alert' }
  }
  if (result.kind === 'source-not-visible') {
    return { message: t('selection.side.error.sourceNotVisible'), role: 'alert' }
  }
  if (result.kind === 'partial') {
    return {
      message: t('selection.side.partial', { childId: result.childId }),
      role: 'alert',
    }
  }
  if (result.kind === 'unavailable') {
    return { message: t('selection.side.error.unavailable'), role: 'alert' }
  }
  return { message: t('selection.side.error.failed'), role: 'alert' }
}

export function SelectionToolbar({ controller, onAdd, sideChat, t }: SelectionToolbarProps) {
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [notice, setNotice] = React.useState<ToolbarNotice | null>(null)
  const [pending, setPending] = React.useState(false)
  const pendingRef = React.useRef(false)
  const selection = state.selection
  React.useEffect(() => setNotice(null), [selection])
  if (selection === null) return null
  const sideAvailable = sideChat?.available === true
  const runSide = (action: 'more-details' | 'ask-in-side-chat') => {
    if (sideChat === undefined || pendingRef.current) return
    const captured = selection
    pendingRef.current = true
    setPending(true)
    setNotice({ message: t('selection.side.pending'), role: 'status' })
    const request = action === 'more-details'
      ? sideChat.moreDetails(captured)
      : sideChat.askInSideChat(captured)
    void request.then((result) => {
      if (controller.getSnapshot().selection !== captured) return
      if (result.kind === 'opened') {
        controller.clear()
        return
      }
      setNotice(sideResultNotice(result, t))
    }, () => {
      if (controller.getSnapshot().selection === captured) {
        setNotice({ message: t('selection.side.error.failed'), role: 'alert' })
      }
    }).finally(() => {
      pendingRef.current = false
      setPending(false)
    })
  }
  const left = selection.rect.x + selection.rect.width / 2
  const top = Math.max(8, selection.rect.y - 42)
  return (
    <div
      data-dsh-selection-toolbar
      role="toolbar"
      aria-label={t('selection.toolbar.label')}
      aria-busy={pending || undefined}
      style={{
        position: 'fixed', left, top, zIndex: 20, transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'center', gap: 6, padding: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))', borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-2, #fff)', boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,.14))',
      }}
    >
      <button
        type="button"
        disabled={pending}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const result = onAdd(selection)
          if (!result.ok) {
            setNotice({ message: result.message ?? t('selection.error.reference'), role: 'status' })
          }
        }}
        style={{ border: 0, borderRadius: 7, padding: '6px 10px', cursor: 'pointer' }}
      >
        {t('selection.add')}
      </button>
      {sideAvailable && (
        <>
          <button
            type="button"
            disabled={pending}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runSide('more-details')}
            style={{ border: 0, borderRadius: 7, padding: '6px 10px', cursor: pending ? 'wait' : 'pointer' }}
          >
            {t('selection.moreDetails')}
          </button>
          <button
            type="button"
            disabled={pending}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runSide('ask-in-side-chat')}
            style={{ border: 0, borderRadius: 7, padding: '6px 10px', cursor: pending ? 'wait' : 'pointer' }}
          >
            {t('selection.askInSideChat')}
          </button>
        </>
      )}
      {notice !== null && <span role={notice.role} style={{ fontSize: 12 }}>{notice.message}</span>}
    </div>
  )
}

interface SelectionDockProps {
  readonly sessionId: string
  readonly session: { readonly sessionId: string }
  readonly input: SelectionInputSnapshot
  readonly updateComment: (itemId: string, comment: string) => SelectionMutationResult
  readonly removeItem: (itemId: string) => SelectionMutationResult
  readonly t: Translate
}

export function SelectionDock({ sessionId, session, input, updateComment, removeItem, t }: SelectionDockProps) {
  const owned = session.sessionId === sessionId ? readSelectionAggregate(input) : null
  const ref = owned?.occurrence.ref
  const [comments, setComments] = React.useState<Record<string, string>>({})
  React.useEffect(() => {
    if (owned === null) {
      setComments({})
      return
    }
    setComments(Object.fromEntries(owned.aggregate.items.map((item) => [item.id, item.comment ?? ''])))
  }, [ref])
  if (owned === null) return null
  return (
    <section
      data-dsh-selection-dock
      aria-label={t('selection.dock.label')}
      style={{ display: 'grid', gap: 6, padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1, #f6f7f9)' }}
    >
      <strong style={{ fontSize: 12 }}>{t('selection.dock.label')} ({owned.aggregate.items.length})</strong>
      {owned.aggregate.items.map((item, index) => (
        <div key={item.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 6, alignItems: 'center' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.text}
            </div>
            <input
              aria-label={`${t('selection.comment')} ${index + 1}`}
              value={comments[item.id] ?? ''}
              placeholder={t('selection.comment')}
              onChange={(event) => setComments((current) => ({ ...current, [item.id]: event.target.value }))}
              onBlur={(event) => updateComment(item.id, event.target.value)}
              style={{ width: '100%', marginTop: 4 }}
            />
          </div>
          <button
            type="button"
            aria-label={`${t('selection.remove')} ${index + 1}`}
            onClick={() => removeItem(item.id)}
          >
            {t('selection.remove')}
          </button>
        </div>
      ))}
    </section>
  )
}

/** Register the stock-compatible selection toolbar, codec owner, and aggregate dock. */
export function applySelectionActions(
  ctx: SelectionApplyContext,
  services: SelectionApplyServices,
  t: Translate,
  locale = 'dsh-workbench',
  itemIdFactory: () => string = createSelectionItemId,
): SelectionController {
  const controller = new SelectionController(services.sessions)
  const sideChat = createSideChatActions({
    services: services.harness,
    revalidateSelection: (selection) => controller.revalidate(selection) !== null,
    confirmReplace: () => typeof window !== 'undefined'
      && typeof window.confirm === 'function'
      && window.confirm(t('selection.side.confirmReplace')),
    copy: {
      get referenceBoundary() { return t('selection.side.boundary') },
      get moreDetailsRequest() { return t('selection.side.moreDetailsRequest') },
    },
    insertDraftReference: ({ input, reference, ordinaryDraft }) => {
      if (ordinaryDraft !== '') throw new Error('side-chat ordinary draft must start empty')
      const result = insertSideChatReference(input, reference, t('selection.side.reference.label'))
      if (!result.ok) throw new Error(`side-chat reference insertion failed: ${result.reason}`)
    },
  })
  const onAdd = (selection: ConversationSelection) => addSelectionToConversation(
    controller, services, selection, itemIdFactory(), t,
  )
  ctx.effect(() => () => controller.dispose(), 'dsh-workbench: selection controller')
  ctx.effect(() => services.inputTriggers.registerSource(createSelectionReferenceSource()), 'dsh-workbench: selection reference source')
  ctx.effect(() => services.inputTriggers.registerSource(createSideChatReferenceSource()), 'dsh-workbench: side-chat reference source')

  services.slots.inject('shell.overlay', () => services.slots.register({
    name: 'shell.overlay',
    id: 'dsh-workbench.selection-actions',
    label: () => t('selection.toolbar.label'),
    locale,
    inject: () => ({ controller, onAdd, sideChat, t }),
  }, SelectionToolbar))

  services.slots.inject('conversation.input.dock', () => services.slots.register({
    name: 'conversation.input.dock',
    id: 'dsh-workbench.selection-aggregate',
    label: () => t('selection.dock.label'),
    locale,
    order: 10,
    inject: (sessionId: string) => ({
      t,
      updateComment: (itemId: string, comment: string) => {
        const input = inputFor(services, sessionId)
        if (input === null) return { ok: false, reason: 'missing-reference' } satisfies SelectionMutationResult
        const result = updateSelectionComment(input, itemId, comment, t('selection.reference.label'))
        if (!result.ok) input.notify?.('error', failureMessage(result, t))
        return result
      },
      removeItem: (itemId: string) => {
        const input = inputFor(services, sessionId)
        if (input === null) return { ok: false, reason: 'missing-reference' } satisfies SelectionMutationResult
        const result = removeSelectionItem(input, itemId, t('selection.reference.label'))
        if (!result.ok) input.notify?.('error', failureMessage(result, t))
        return result
      },
    }),
  }, SelectionDock))

  return controller
}
