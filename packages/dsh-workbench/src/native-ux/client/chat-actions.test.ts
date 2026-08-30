// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  createChatActions,
  focusSessionComposer,
  reusableChatSessionId,
  resolveChatWorkspace,
  waitForSessionListed,
  type TimeoutScheduler,
} from './chat-actions.js'
import type {
  ChatActionServices,
  SessionListSnapshotFace,
  WorkspaceListSnapshotFace,
} from './harness-adapter.js'

function store<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update: (next: T) => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

const NOW = new Date(2026, 7, 29, 12, 0, 0).getTime()
const TODAY_EARLY = new Date(2026, 7, 29, 8, 0, 0).getTime()
const TODAY_LATE = new Date(2026, 7, 29, 10, 0, 0).getTime()
const YESTERDAY = new Date(2026, 7, 28, 23, 59, 0).getTime()

function session(id: string, overrides: Partial<SessionListSnapshotFace['byId'][string]> = {}) {
  return {
    id,
    blank: true,
    updatedAt: TODAY_EARLY,
    agentPreset: 'chat',
    ...overrides,
  }
}

function editionPresentation(
  visible: string[],
  focused: string,
  options: { readonly openError?: Error } = {},
) {
  const state = { visible: [...visible], focused }
  return {
    protocol: 2,
    state: { getSnapshot: () => ({ visible: [...state.visible], focused: state.focused, capacity: 2 }) },
    open: vi.fn((id: string, request?: { disposition?: 'beside' | 'replace-focused' }) => {
      if (options.openError !== undefined) throw options.openError
      if (request?.disposition === 'beside') {
        state.visible.splice(state.visible.indexOf(state.focused) + 1, 0, id)
      } else {
        state.visible[state.visible.indexOf(state.focused)] = id
      }
      state.focused = id
    }),
    focus: vi.fn((id: string) => {
      if (state.visible.includes(id)) state.focused = id
    }),
    close: vi.fn(),
  }
}

function harness(options: {
  readonly sessionSnapshot: SessionListSnapshotFace
  readonly workspaceSnapshot: WorkspaceListSnapshotFace
  readonly presentation?: ReturnType<typeof editionPresentation>
  readonly create?: ReturnType<typeof vi.fn>
}) {
  const sessionList = store(options.sessionSnapshot)
  const workspaceList = store(options.workspaceSnapshot)
  const create = options.create ?? vi.fn(async () => ({
    result: { ok: true as const, value: { sessionId: 'created-chat', agentPreset: 'chat' } },
  }))
  const open = vi.fn()
  const services = {
    connection: { api: { sessions: { create } } },
    sessions: {
      scope: vi.fn(),
      list: sessionList,
      open,
      ...(options.presentation === undefined ? {} : { presentation: options.presentation }),
    },
    workspaces: { list: workspaceList },
  } as ChatActionServices
  return { services, sessionList, workspaceList, create, open }
}

function ui() {
  return { confirmReplace: vi.fn(() => true), notify: vi.fn() }
}

const t = (key: string) => key

describe('chat workspace and reuse policy', () => {
  it('prefers an exact case-insensitive chat title/name before source membership', () => {
    const workspaces = [
      { workspaceId: 'current', title: 'Work', sessionIds: ['source'] },
      { workspaceId: 'chat', name: 'ChAt', sessionIds: [] },
    ]
    expect(resolveChatWorkspace(workspaces, 'source')?.workspaceId).toBe('chat')
    expect(resolveChatWorkspace([
      { workspaceId: 'not-chat', title: ' chat ', sessionIds: [] },
      { workspaceId: 'current', title: 'Work', sessionIds: ['source'] },
    ], 'source')?.workspaceId).toBe('current')
  })

  it('falls back to the Workspace containing the captured source and returns undefined without either', () => {
    const workspaces = [{ workspaceId: 'current', title: 'Work', sessionIds: ['source'] }]
    expect(resolveChatWorkspace(workspaces, 'source')?.workspaceId).toBe('current')
    expect(resolveChatWorkspace(workspaces, 'missing')).toBeUndefined()
    expect(resolveChatWorkspace([], undefined)).toBeUndefined()
  })

  it('reuses the newest same-day blank chat session only', () => {
    const workspace = { workspaceId: 'chat', title: 'Chat', sessionIds: ['old', 'new', 'nonblank', 'yesterday'] }
    const sessions: SessionListSnapshotFace = {
      ids: workspace.sessionIds,
      current: 'source',
      byId: {
        old: session('old', { updatedAt: TODAY_EARLY }),
        new: session('new', { updatedAt: TODAY_LATE }),
        nonblank: session('nonblank', { blank: false, updatedAt: TODAY_LATE + 1 }),
        yesterday: session('yesterday', { updatedAt: YESTERDAY }),
      },
    }
    expect(reusableChatSessionId(workspace, sessions, NOW)).toBe('new')
  })
})

describe('waitForSessionListed', () => {
  it('subscribes until the id appears, then releases the timeout and subscription', async () => {
    const list = store<SessionListSnapshotFace>({ ids: [], byId: {}, current: 'source' })
    let timeout: (() => void) | undefined
    const scheduler: TimeoutScheduler = {
      setTimeout: vi.fn(callback => { timeout = callback; return 'timer' }),
      clearTimeout: vi.fn(),
    }
    const waiting = waitForSessionListed(list, 'created', { scheduler, timeoutMs: 25 })
    expect(list.listenerCount()).toBe(1)
    list.update({ ids: ['created'], byId: { created: session('created') }, current: 'source' })
    await expect(waiting).resolves.toBe(true)
    expect(list.listenerCount()).toBe(0)
    expect(scheduler.clearTimeout).toHaveBeenCalledWith('timer')
    expect(timeout).toBeDefined()
  })

  it('has a deterministic timeout path', async () => {
    const list = store<SessionListSnapshotFace>({ ids: [], byId: {}, current: 'source' })
    let timeout: (() => void) | undefined
    const scheduler: TimeoutScheduler = {
      setTimeout: vi.fn(callback => { timeout = callback; return 1 }),
      clearTimeout: vi.fn(),
    }
    const waiting = waitForSessionListed(list, 'never', { scheduler, timeoutMs: 25 })
    timeout?.()
    await expect(waiting).resolves.toBe(false)
    expect(list.listenerCount()).toBe(0)
  })

  it('releases a subscription that reports the Session synchronously from subscribe()', async () => {
    const empty: SessionListSnapshotFace = { ids: [], byId: {}, current: 'source' }
    const listed: SessionListSnapshotFace = {
      ids: ['created'], byId: { created: session('created') }, current: 'source',
    }
    let reads = 0
    const unsubscribe = vi.fn()
    const list = {
      getSnapshot: () => reads++ === 0 ? empty : listed,
      subscribe: (listener: () => void) => {
        listener()
        return unsubscribe
      },
    }
    const scheduler: TimeoutScheduler = {
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
    }

    await expect(waitForSessionListed(list, 'created', { scheduler })).resolves.toBe(true)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(scheduler.setTimeout).not.toHaveBeenCalled()
  })
})

describe('focusSessionComposer', () => {
  it('waits for the requested Pane mount and never falls back to the old Pane composer', async () => {
    const oldPane = document.createElement('section')
    oldPane.dataset.sessionPane = 'old'
    const oldSeat = document.createElement('div')
    oldSeat.dataset.composerSeat = ''
    const oldInput = document.createElement('textarea')
    oldSeat.appendChild(oldInput)
    oldPane.appendChild(oldSeat)
    document.body.appendChild(oldPane)

    let mutationListener: (() => void) | undefined
    const stopObserving = vi.fn()
    const scheduler: TimeoutScheduler = {
      setTimeout: vi.fn(() => 'timer'),
      clearTimeout: vi.fn(),
    }
    const focusing = focusSessionComposer('target', {
      scheduler,
      observeMutations: listener => {
        mutationListener = listener
        return stopObserving
      },
    })
    expect(document.activeElement).not.toBe(oldInput)

    const targetPane = document.createElement('section')
    targetPane.dataset.sessionPane = 'target'
    const targetSeat = document.createElement('div')
    targetSeat.dataset.composerSeat = ''
    const targetInput = document.createElement('textarea')
    targetSeat.appendChild(targetInput)
    targetPane.appendChild(targetSeat)
    document.body.appendChild(targetPane)
    mutationListener?.()

    await expect(focusing).resolves.toBe(true)
    expect(document.activeElement).toBe(targetInput)
    expect(stopObserving).toHaveBeenCalledOnce()
    expect(scheduler.clearTimeout).toHaveBeenCalledWith('timer')
    oldPane.remove()
    targetPane.remove()
  })
})

describe('createChatActions', () => {
  it('uses Presentation focus before sessions.list.current for Workspace fallback', async () => {
    const fixture = harness({
      sessionSnapshot: {
        ids: ['chat-existing'], current: 'list-current',
        byId: { 'chat-existing': session('chat-existing') },
      },
      workspaceSnapshot: { items: [
        { workspaceId: 'presentation-workspace', title: 'Work', sessionIds: ['presentation-source', 'chat-existing'] },
        { workspaceId: 'list-workspace', title: 'Other', sessionIds: ['list-current'] },
      ] },
      presentation: editionPresentation(['presentation-source'], 'presentation-source'),
    })
    const result = await createChatActions({
      services: fixture.services, t, now: () => NOW, ui: ui(), focusComposer: vi.fn(),
    }).open()
    expect(result).toMatchObject({ kind: 'opened', workspaceId: 'presentation-workspace', sessionId: 'chat-existing' })
    expect(fixture.create).not.toHaveBeenCalled()
  })

  it('is a safe no-op with a console diagnostic when no Workspace resolves', async () => {
    const fixture = harness({
      sessionSnapshot: { ids: [], byId: {}, current: 'source' },
      workspaceSnapshot: { items: [] },
    })
    const diagnostic = vi.fn()
    await expect(createChatActions({
      services: fixture.services, t, now: () => NOW, ui: ui(), diagnostic,
    }).open()).resolves.toEqual({ kind: 'no-workspace', sourceSessionId: 'source' })
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('no workspace resolved'))
    expect(fixture.create).not.toHaveBeenCalled()
    expect(fixture.open).not.toHaveBeenCalled()
  })

  it('reuses the newest same-day blank Session without creating another', async () => {
    const fixture = harness({
      sessionSnapshot: {
        ids: ['old', 'new'], current: 'source',
        byId: {
          old: session('old', { updatedAt: TODAY_EARLY }),
          new: session('new', { updatedAt: TODAY_LATE }),
        },
      },
      workspaceSnapshot: { items: [{ workspaceId: 'chat-ws', title: 'CHAT', sessionIds: ['old', 'new'] }] },
    })
    const result = await createChatActions({
      services: fixture.services, t, now: () => NOW, ui: ui(), focusComposer: vi.fn(),
    }).open()
    expect(result).toMatchObject({ kind: 'opened', mode: 'stock', sessionId: 'new', created: false })
    expect(fixture.create).not.toHaveBeenCalled()
    expect(fixture.open).toHaveBeenCalledWith('new')
  })

  it.each([
    ['cross-day', session('stale', { updatedAt: YESTERDAY })],
    ['nonblank', session('stale', { blank: false, updatedAt: TODAY_LATE })],
  ])('creates for a %s candidate with the chat preset and waits for list membership', async (_label, stale) => {
    let fixture: ReturnType<typeof harness>
    const create = vi.fn(async (payload: unknown) => {
      fixture.sessionList.update({
        ids: ['stale', 'created-chat'], current: 'source',
        byId: { stale, 'created-chat': session('created-chat', { updatedAt: NOW }) },
      })
      return { result: { ok: true as const, value: { sessionId: 'created-chat', agentPreset: 'chat' } } }
    })
    fixture = harness({
      sessionSnapshot: { ids: ['stale'], current: 'source', byId: { stale } },
      workspaceSnapshot: { items: [{ workspaceId: 'work', title: 'Work', sessionIds: ['source', 'stale'] }] },
      create,
    })
    const result = await createChatActions({
      services: fixture.services, t, now: () => NOW, ui: ui(), focusComposer: vi.fn(),
    }).open()
    expect(create).toHaveBeenCalledWith({ workspaceId: 'work', agentPreset: 'chat' })
    expect(result).toMatchObject({ kind: 'opened', sessionId: 'created-chat', created: true })
    expect(fixture.open).toHaveBeenCalledWith('created-chat')
  })

  it('does not navigate until the created id appears in sessions.list', async () => {
    const fixture = harness({
      sessionSnapshot: { ids: [], current: 'source', byId: {} },
      workspaceSnapshot: { items: [{ workspaceId: 'work', title: 'Work', sessionIds: ['source'] }] },
    })
    const action = createChatActions({
      services: fixture.services, t, now: () => NOW, ui: ui(), focusComposer: vi.fn(),
    })
    const opening = action.open()
    await Promise.resolve()
    expect(fixture.open).not.toHaveBeenCalled()
    fixture.sessionList.update({
      ids: ['created-chat'], current: 'source', byId: { 'created-chat': session('created-chat') },
    })
    await expect(opening).resolves.toMatchObject({ kind: 'opened', sessionId: 'created-chat' })
    expect(fixture.open).toHaveBeenCalledWith('created-chat')
  })

  it('coalesces concurrent opens into one create/list/navigation attempt with stable Promise identity', async () => {
    let resolveCreate: ((value: {
      result: { ok: true; value: { sessionId: string; agentPreset: string } }
    }) => void) | undefined
    const create = vi.fn(() => new Promise<{
      result: { ok: true; value: { sessionId: string; agentPreset: string } }
    }>(resolve => { resolveCreate = resolve }))
    const fixture = harness({
      sessionSnapshot: { ids: [], current: 'source', byId: {} },
      workspaceSnapshot: { items: [{ workspaceId: 'work', title: 'Work', sessionIds: ['source'] }] },
      create,
    })
    const action = createChatActions({
      services: fixture.services, t, now: () => NOW, ui: ui(), focusComposer: vi.fn(),
    })

    const first = action.open()
    const second = action.open()
    expect(second).toBe(first)
    expect(create).toHaveBeenCalledOnce()
    resolveCreate?.({ result: { ok: true, value: { sessionId: 'created-chat', agentPreset: 'chat' } } })
    await Promise.resolve()
    fixture.sessionList.update({
      ids: ['created-chat'], current: 'source', byId: { 'created-chat': session('created-chat') },
    })

    await expect(first).resolves.toMatchObject({ kind: 'opened', sessionId: 'created-chat' })
    expect(fixture.open).toHaveBeenCalledOnce()
  })

  it('returns the RPC error honestly and never navigates after create failure', async () => {
    const error = { code: 'agent-preset-not-found', message: 'chat missing' }
    const fixture = harness({
      sessionSnapshot: { ids: [], current: 'source', byId: {} },
      workspaceSnapshot: { items: [{ workspaceId: 'work', title: 'Work', sessionIds: ['source'] }] },
      create: vi.fn(async () => ({ result: { ok: false as const, error } })),
    })
    await expect(createChatActions({
      services: fixture.services, t, now: () => NOW, ui: ui(),
    }).open()).resolves.toEqual({ kind: 'create-failed', workspaceId: 'work', error })
    expect(fixture.open).not.toHaveBeenCalled()
  })

  it('uses stock sessions.open and emits the localized downgrade notice once per instance', async () => {
    const fixture = harness({
      sessionSnapshot: { ids: ['chat'], current: 'source', byId: { chat: session('chat') } },
      workspaceSnapshot: { items: [{ workspaceId: 'chat-ws', title: 'Chat', sessionIds: ['chat'] }] },
    })
    const surface = ui()
    const action = createChatActions({
      services: fixture.services, t, now: () => NOW, ui: surface, focusComposer: vi.fn(),
    })
    await action.open()
    await action.open()
    expect(fixture.open).toHaveBeenCalledTimes(2)
    expect(surface.notify.mock.calls.filter(([message]) => message === 'chat.stockDowngrade')).toHaveLength(1)
  })

  it('opens the chat directly on Edition when no source Pane exists (zero-Pane home state)', async () => {
    // Regression pin: Ctrl+N (sessions.clear) or first launch leaves no focused
    // or current session. Fresh chat must open as the only Pane — never fall
    // into the source-not-visible branch reserved for a captured source that
    // vanished (design.md §4 rule 3).
    const presentation = {
      protocol: 2,
      state: { getSnapshot: () => ({ visible: [] as string[], focused: undefined, capacity: 2 }) },
      open: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
    }
    const fixture = harness({
      sessionSnapshot: { ids: ['chat'], current: undefined, byId: { chat: session('chat') } },
      workspaceSnapshot: { items: [{ workspaceId: 'chat-ws', title: 'Chat', sessionIds: ['chat'] }] },
      presentation: presentation as unknown as ReturnType<typeof editionPresentation>,
    })
    const surface = ui()
    const focusComposer = vi.fn()
    await expect(createChatActions({
      services: fixture.services, t, now: () => NOW, ui: surface, focusComposer,
    }).open()).resolves.toMatchObject({ kind: 'opened', mode: 'edition', sessionId: 'chat' })
    expect(fixture.open).toHaveBeenCalledWith('chat')
    expect(presentation.open).not.toHaveBeenCalled()
    expect(focusComposer).toHaveBeenCalledWith('chat')
    expect(surface.notify).not.toHaveBeenCalled()
  })

  it('returns source-not-visible and cancelled as distinct Edition outcomes', async () => {
    const missing = harness({
      sessionSnapshot: { ids: ['chat'], current: 'source', byId: { chat: session('chat') } },
      workspaceSnapshot: { items: [{ workspaceId: 'chat-ws', title: 'Chat', sessionIds: ['chat'] }] },
      presentation: editionPresentation(['other'], 'source'),
    })
    await expect(createChatActions({
      services: missing.services, t, now: () => NOW, ui: ui(),
    }).open()).resolves.toMatchObject({ kind: 'source-not-visible', sessionId: 'chat', sourceSessionId: 'source' })

    const full = harness({
      sessionSnapshot: { ids: ['chat'], current: 'source', byId: { chat: session('chat') } },
      workspaceSnapshot: { items: [{ workspaceId: 'chat-ws', title: 'Chat', sessionIds: ['chat'] }] },
      presentation: editionPresentation(['source', 'other'], 'source'),
    })
    const surface = ui()
    surface.confirmReplace.mockReturnValue(false)
    await expect(createChatActions({
      services: full.services, t, now: () => NOW, ui: surface,
    }).open()).resolves.toMatchObject({ kind: 'cancelled', sessionId: 'chat', replacedSessionId: 'other' })
  })

  it('reports partial success with the retained Session id when Edition open fails', async () => {
    const failure = new Error('open failed')
    const fixture = harness({
      sessionSnapshot: { ids: ['chat'], current: 'source', byId: { chat: session('chat') } },
      workspaceSnapshot: { items: [{ workspaceId: 'chat-ws', title: 'Chat', sessionIds: ['chat'] }] },
      presentation: editionPresentation(['source'], 'source', { openError: failure }),
    })
    await expect(createChatActions({
      services: fixture.services, t, now: () => NOW, ui: ui(),
    }).open()).resolves.toEqual({
      kind: 'partial', workspaceId: 'chat-ws', sessionId: 'chat',
      created: false, reason: 'open-failed', error: failure,
    })
  })
})
