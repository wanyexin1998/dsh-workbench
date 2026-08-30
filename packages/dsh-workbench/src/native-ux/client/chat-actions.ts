import { openBeside, type BesideOpenResult, type BesidePresentation } from './beside-open.js'
import { focusedPaneScope, locateComposerInput } from './conversation-dom.js'
import {
  focusedSessionId,
  type ChatActionServices,
  type ObservableSnapshotFace,
  type SessionListSnapshotFace,
  type WorkspaceSummaryFace,
} from './harness-adapter.js'

export const CHAT_LIST_WAIT_TIMEOUT_MS = 5000
export const CHAT_COMPOSER_FOCUS_TIMEOUT_MS = 1000

export type ChatOpenResult =
  | {
    readonly kind: 'opened'
    readonly mode: 'edition' | 'stock'
    readonly workspaceId: string
    readonly sessionId: string
    readonly created: boolean
    readonly beside?: Extract<BesideOpenResult, { kind: 'opened' }>
  }
  | {
    readonly kind: 'no-workspace'
    readonly sourceSessionId: string | undefined
  }
  | {
    readonly kind: 'create-failed'
    readonly workspaceId: string
    readonly error: unknown
  }
  | {
    readonly kind: 'source-not-visible'
    readonly workspaceId: string
    readonly sessionId: string
    readonly created: boolean
    readonly sourceSessionId: string | undefined
  }
  | {
    readonly kind: 'cancelled'
    readonly workspaceId: string
    readonly sessionId: string
    readonly created: boolean
    readonly replacedSessionId: string
  }
  | {
    readonly kind: 'partial'
    readonly workspaceId: string
    readonly sessionId: string
    readonly created: boolean
    readonly reason: 'list-timeout' | 'open-failed'
    readonly error?: unknown
  }

export interface ChatActions {
  open(): Promise<ChatOpenResult>
}

export interface ChatActionUi {
  confirmReplace(message: string): boolean | Promise<boolean>
  notify(message: string): void
}

export interface TimeoutScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ChatActionOptions {
  readonly services: ChatActionServices
  readonly t: (key: string, vars?: Record<string, string>) => string
  readonly ui?: ChatActionUi
  readonly now?: () => number
  readonly scheduler?: TimeoutScheduler
  readonly listWaitTimeoutMs?: number
  readonly composerFocusTimeoutMs?: number
  readonly diagnostic?: (message: string) => void
  readonly focusComposer?: (sessionId: string) => boolean | void | Promise<boolean | void>
}

export interface ComposerFocusOptions {
  readonly timeoutMs?: number
  readonly scheduler?: TimeoutScheduler
  readonly observeMutations?: (listener: () => void) => () => void
}

const defaultScheduler: TimeoutScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: handle => globalThis.clearTimeout(handle as number),
}

function defaultUi(): ChatActionUi {
  return {
    confirmReplace: message => typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm(message)
      : false,
    notify: message => {
      if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(message)
      else console.info('[dsh-workbench] ' + message)
    },
  }
}

function strictSessionComposer(sessionId: string): HTMLElement | null {
  if (typeof document === 'undefined' || typeof HTMLElement === 'undefined') return null
  const scope = focusedPaneScope(sessionId)
  // focusedPaneScope deliberately falls back to document for legacy callers.
  // Fresh chat must not accept that fallback or it can focus the old Pane.
  if (!(scope instanceof HTMLElement) || scope.dataset.sessionPane !== sessionId) return null
  return locateComposerInput(scope)
}

function observeDocumentMutations(listener: () => void): () => void {
  if (typeof document === 'undefined'
    || document.documentElement === null
    || typeof MutationObserver === 'undefined') return () => {}
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  return () => { observer.disconnect() }
}

/** Focus only the requested Pane, waiting a bounded time for its DOM mount. */
export function focusSessionComposer(
  sessionId: string,
  options: ComposerFocusOptions = {},
): Promise<boolean> {
  const tryFocus = (): boolean => {
    const input = strictSessionComposer(sessionId)
    if (input === null) return false
    input.focus()
    return true
  }
  if (tryFocus()) return Promise.resolve(true)
  const scheduler = options.scheduler ?? defaultScheduler
  const observeMutations = options.observeMutations ?? observeDocumentMutations
  const timeoutMs = options.timeoutMs ?? CHAT_COMPOSER_FOCUS_TIMEOUT_MS
  return new Promise(resolve => {
    let settled = false
    let timer: unknown
    let stopObserving: () => void = () => {}
    const finish = (focused: boolean) => {
      if (settled) return
      settled = true
      stopObserving()
      if (timer !== undefined) scheduler.clearTimeout(timer)
      resolve(focused)
    }
    const retry = () => {
      if (tryFocus()) finish(true)
    }
    const actualStop = observeMutations(retry)
    stopObserving = actualStop
    if (settled) {
      actualStop()
      return
    }
    retry()
    if (!settled) timer = scheduler.setTimeout(() => finish(false), timeoutMs)
  })
}

function hasSession(list: ObservableSnapshotFace<SessionListSnapshotFace>, sessionId: string): boolean {
  try {
    return list.getSnapshot().ids.includes(sessionId)
  } catch {
    return false
  }
}

/** Wait for the client list mirror with an injectable, deterministic clock. */
export function waitForSessionListed(
  list: ObservableSnapshotFace<SessionListSnapshotFace>,
  sessionId: string,
  options: { readonly timeoutMs?: number; readonly scheduler?: TimeoutScheduler } = {},
): Promise<boolean> {
  if (hasSession(list, sessionId)) return Promise.resolve(true)
  const scheduler = options.scheduler ?? defaultScheduler
  const timeoutMs = options.timeoutMs ?? CHAT_LIST_WAIT_TIMEOUT_MS
  return new Promise(resolve => {
    let settled = false
    let timer: unknown
    let unsubscribe: () => void = () => {}
    const finish = (listed: boolean) => {
      if (settled) return
      settled = true
      unsubscribe()
      if (timer !== undefined) scheduler.clearTimeout(timer)
      resolve(listed)
    }
    const check = () => {
      if (hasSession(list, sessionId)) finish(true)
    }
    const actualUnsubscribe = list.subscribe(check)
    unsubscribe = actualUnsubscribe
    // Observable implementations may invoke the listener synchronously from
    // subscribe(). In that case finish() ran against the placeholder above.
    if (settled) {
      actualUnsubscribe()
      return
    }
    check()
    if (!settled) timer = scheduler.setTimeout(() => finish(false), timeoutMs)
  })
}

function captureSourceSessionId(services: ChatActionServices): string | undefined {
  const presentationFocused = focusedSessionId(services)
  if (presentationFocused !== undefined) return presentationFocused
  try {
    return services.sessions.list.getSnapshot().current
  } catch {
    return undefined
  }
}

function workspaceDisplayName(workspace: WorkspaceSummaryFace): readonly (string | undefined)[] {
  return [workspace.title, workspace.name]
}

/** Frozen resolution chain: exact chat title/name first, then source membership. */
export function resolveChatWorkspace(
  workspaces: readonly WorkspaceSummaryFace[],
  sourceSessionId: string | undefined,
): WorkspaceSummaryFace | undefined {
  const named = workspaces.find(workspace =>
    workspaceDisplayName(workspace).some(name => name?.toLocaleLowerCase() === 'chat'))
  if (named !== undefined) return named
  if (sourceSessionId === undefined) return undefined
  return workspaces.find(workspace => workspace.sessionIds.includes(sourceSessionId))
}

export function isSameLocalCalendarDay(leftMs: number, rightMs: number): boolean {
  const left = new Date(leftMs)
  const right = new Date(rightMs)
  return Number.isFinite(left.getTime())
    && left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

/** Newest same-day blank `chat` Session accounted to the resolved Workspace. */
export function reusableChatSessionId(
  workspace: WorkspaceSummaryFace,
  sessions: SessionListSnapshotFace,
  nowMs: number,
): string | undefined {
  let newest: { readonly id: string; readonly updatedAt: number } | undefined
  for (const id of workspace.sessionIds) {
    const summary = sessions.byId[id]
    if (!sessions.ids.includes(id)
      || summary === undefined
      || summary.blank !== true
      || summary.agentPreset !== 'chat'
      || !isSameLocalCalendarDay(summary.updatedAt, nowMs)) continue
    if (newest === undefined || summary.updatedAt > newest.updatedAt) {
      newest = { id, updatedAt: summary.updatedAt }
    }
  }
  return newest?.id
}

function editionPresentation(services: ChatActionServices): BesidePresentation | undefined {
  const presentation = services.sessions.presentation
  if (presentation?.protocol !== 2
    || typeof presentation.state?.getSnapshot !== 'function'
    || typeof presentation.open !== 'function'
    || typeof presentation.focus !== 'function') return undefined
  return presentation as BesidePresentation
}

function notifySafely(ui: ChatActionUi, message: string): void {
  try {
    ui.notify(message)
  } catch {
    // A host notice surface must never turn a completed Session action into a failure.
  }
}

async function focusComposerSafely(
  focusComposer: (sessionId: string) => boolean | void | Promise<boolean | void>,
  sessionId: string,
): Promise<void> {
  try {
    await focusComposer(sessionId)
  } catch {
    // The Pane can render after navigation; missing DOM does not undo navigation.
  }
}

/** Create the stateful action instance (one-shot stock notice lives here). */
export function createChatActions(options: ChatActionOptions): ChatActions {
  const { services, t } = options
  const ui = options.ui ?? defaultUi()
  const now = options.now ?? Date.now
  const scheduler = options.scheduler ?? defaultScheduler
  const diagnostic = options.diagnostic ?? (message => console.warn(message))
  const focusComposer = options.focusComposer
    ?? (sessionId => focusSessionComposer(sessionId, {
      scheduler,
      timeoutMs: options.composerFocusTimeoutMs,
    }))
  let stockNoticeShown = false
  let inFlight: Promise<ChatOpenResult> | undefined

  const performOpen = async (): Promise<ChatOpenResult> => {
      // Identity must be frozen before session.create and confirmation await.
      const sourceSessionId = captureSourceSessionId(services)
      let workspaces: readonly WorkspaceSummaryFace[]
      let sessions: SessionListSnapshotFace
      try {
        workspaces = services.workspaces.list.getSnapshot().items
        sessions = services.sessions.list.getSnapshot()
      } catch (error) {
        diagnostic('[dsh-workbench] workbench.chat.open skipped: workspace/session list unavailable: ' + String(error))
        return { kind: 'no-workspace', sourceSessionId }
      }
      const workspace = resolveChatWorkspace(workspaces, sourceSessionId)
      if (workspace === undefined) {
        diagnostic('[dsh-workbench] workbench.chat.open skipped: no workspace resolved')
        return { kind: 'no-workspace', sourceSessionId }
      }

      let sessionId = reusableChatSessionId(workspace, sessions, now())
      let created = false
      if (sessionId === undefined) {
        try {
          const response = await services.connection.api.sessions.create({
            workspaceId: workspace.workspaceId,
            agentPreset: 'chat',
          })
          if (!response.result.ok) {
            notifySafely(ui, t('chat.error.create'))
            return { kind: 'create-failed', workspaceId: workspace.workspaceId, error: response.result.error }
          }
          sessionId = response.result.value.sessionId
          created = true
        } catch (error) {
          notifySafely(ui, t('chat.error.create'))
          return { kind: 'create-failed', workspaceId: workspace.workspaceId, error }
        }
        const listed = await waitForSessionListed(services.sessions.list, sessionId, {
          timeoutMs: options.listWaitTimeoutMs,
          scheduler,
        })
        if (!listed) {
          notifySafely(ui, t('chat.error.openPartial', { sessionId }))
          return {
            kind: 'partial', workspaceId: workspace.workspaceId, sessionId,
            created, reason: 'list-timeout',
          }
        }
      }

      const presentation = editionPresentation(services)
      if (presentation === undefined) {
        try {
          services.sessions.open(sessionId)
        } catch (error) {
          notifySafely(ui, t('chat.error.openPartial', { sessionId }))
          return {
            kind: 'partial', workspaceId: workspace.workspaceId, sessionId,
            created, reason: 'open-failed', error,
          }
        }
        await focusComposerSafely(focusComposer, sessionId)
        if (!stockNoticeShown) {
          stockNoticeShown = true
          notifySafely(ui, t('chat.stockDowngrade'))
        }
        return { kind: 'opened', mode: 'stock', workspaceId: workspace.workspaceId, sessionId, created }
      }

      if (sourceSessionId === undefined) {
        // Zero-Pane home state: no session was ever captured as a source, so
        // there is nothing to open "beside" and the source-not-visible failure
        // (reserved for a captured source that vanished — design.md §4 rule 3)
        // must not fire. Open the chat as the only Pane, exactly like stock.
        try {
          services.sessions.open(sessionId)
        } catch (error) {
          notifySafely(ui, t('chat.error.openPartial', { sessionId }))
          return {
            kind: 'partial', workspaceId: workspace.workspaceId, sessionId,
            created, reason: 'open-failed', error,
          }
        }
        await focusComposerSafely(focusComposer, sessionId)
        return { kind: 'opened', mode: 'edition', workspaceId: workspace.workspaceId, sessionId, created }
      }

      const beside = await openBeside({
        presentation,
        sourceSessionId,
        targetSessionId: sessionId,
        confirmReplace: request => ui.confirmReplace(t('chat.confirmReplace', {
          sessionId: request.replacedSessionId,
        })),
      })
      if (beside.kind === 'opened') {
        await focusComposerSafely(focusComposer, sessionId)
        return {
          kind: 'opened', mode: 'edition', workspaceId: workspace.workspaceId,
          sessionId, created, beside,
        }
      }
      if (beside.kind === 'source-not-visible') {
        notifySafely(ui, t('chat.error.sourceNotVisible'))
        return {
          kind: 'source-not-visible', workspaceId: workspace.workspaceId,
          sessionId, created, sourceSessionId,
        }
      }
      if (beside.kind === 'cancelled') {
        return {
          kind: 'cancelled', workspaceId: workspace.workspaceId,
          sessionId, created, replacedSessionId: beside.replacedSessionId,
        }
      }
      notifySafely(ui, t('chat.error.openPartial', { sessionId }))
      return {
        kind: 'partial', workspaceId: workspace.workspaceId, sessionId,
        created, reason: 'open-failed', error: beside.error,
      }
  }

  return {
    open(): Promise<ChatOpenResult> {
      if (inFlight !== undefined) return inFlight
      const attempt = performOpen().finally(() => {
        if (inFlight === attempt) inFlight = undefined
      })
      inFlight = attempt
      return attempt
    },
  }
}
