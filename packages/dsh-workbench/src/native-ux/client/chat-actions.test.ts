// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createChatActions,
  focusSessionComposer,
  reusableChatSessionId,
  resolveChatWorkspace,
  waitForSessionListed,
  type TimeoutScheduler,
} from './chat-actions.js'
import { en, zh } from './locales.js'
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

  it('falls back to the host recent Workspace, and stays fail-closed when it is absent or stale', () => {
    // Zero-Pane home state (nothing focused, sessions.list.current empty):
    // the first two tiers are both unreachable, and before this tier the
    // whole action was inert for anyone whose Workspaces are not named
    // "chat" — which is every ordinary user.
    const workspaces = [
      { workspaceId: 'roadmap', title: 'Product Roadmap', sessionIds: ['s1'] },
      { workspaceId: 'infra', title: 'Infra', sessionIds: ['s2'] },
    ]
    expect(resolveChatWorkspace(workspaces, undefined, 'infra')?.workspaceId).toBe('infra')
    // Fail-closed: a host that projects no recent id, or one naming a
    // Workspace that is no longer listed, resolves nothing at all.
    expect(resolveChatWorkspace(workspaces, undefined)).toBeUndefined()
    expect(resolveChatWorkspace(workspaces, undefined, 'deleted')).toBeUndefined()
    // ...and it stays the LAST tier: a captured source still wins.
    expect(resolveChatWorkspace(workspaces, 's1', 'infra')?.workspaceId).toBe('roadmap')
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

  it('never reuses a same-day blank Session that belongs to another agent preset', () => {
    // "blank chat session" is two conditions, not one: a blank session left
    // behind by a coding preset carries that preset's agent and must not be
    // silently handed to the chat action.
    const workspace = { workspaceId: 'chat', title: 'Chat', sessionIds: ['coder', 'unset'] }
    const sessions: SessionListSnapshotFace = {
      ids: workspace.sessionIds,
      current: 'source',
      byId: {
        coder: session('coder', { agentPreset: 'code', updatedAt: TODAY_LATE }),
        unset: session('unset', { agentPreset: undefined, updatedAt: TODAY_EARLY }),
      },
    }
    expect(reusableChatSessionId(workspace, sessions, NOW)).toBeUndefined()
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

  it('is a safe no-op with a console diagnostic AND a user-visible notice when no Workspace resolves', async () => {
    const fixture = harness({
      sessionSnapshot: { ids: [], byId: {}, current: 'source' },
      workspaceSnapshot: { items: [] },
    })
    const diagnostic = vi.fn()
    const surface = ui()
    await expect(createChatActions({
      services: fixture.services, t, now: () => NOW, ui: surface, diagnostic,
    }).open()).resolves.toEqual({ kind: 'no-workspace', sourceSessionId: 'source' })
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('no workspace resolved'))
    // A console line is invisible to the person who pressed the chord: the
    // shortcut must not be able to do nothing and say nothing. It must
    // also not misreport the reason: nothing was created down this path,
    // so the copy names the missing Workspace rather than a failed create.
    expect(surface.notify).toHaveBeenCalledWith('chat.error.noWorkspace')
    expect(fixture.create).not.toHaveBeenCalled()
    expect(fixture.open).not.toHaveBeenCalled()
  })

  it('reports the same way when the Workspace/Session snapshot itself is unreadable', async () => {
    const fixture = harness({
      sessionSnapshot: { ids: [], byId: {}, current: 'source' },
      workspaceSnapshot: { items: [] },
    })
    const unreadable = {
      ...fixture.services,
      workspaces: { list: { getSnapshot: () => { throw new Error('boom') }, subscribe: vi.fn() } },
    } as unknown as ChatActionServices
    const surface = ui()
    await expect(createChatActions({
      services: unreadable, t, now: () => NOW, ui: surface, diagnostic: vi.fn(),
    }).open()).resolves.toMatchObject({ kind: 'no-workspace' })
    expect(surface.notify).toHaveBeenCalledWith('chat.error.noWorkspace')
  })

  // The two exits above never reach session.create, so they must not
  // borrow the create failure's copy. Pin that the key they use is a
  // real, distinct, translated string in both shipped dictionaries —
  // otherwise `t()` renders the raw key id at the user.
  it('ships distinct no-Workspace copy in both dictionaries', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const dictionary of [zh, en]) {
      expect(dictionary['chat.error.noWorkspace']).toBeTruthy()
      expect(dictionary['chat.error.noWorkspace']).not.toBe(dictionary['chat.error.create'])
    }
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

  // The composer wait is DOM-conditional, so these two pin it from both
  // sides against a document whose pane markers are controlled explicitly —
  // the fixtures earlier in this file leak `[data-session-pane]` elements
  // into `document.body` and would otherwise decide the outcome.
  describe('stock-mode composer focus is gated on the host marking Session Panes', () => {
    let savedBody = ''
    beforeEach(() => { savedBody = document.body.innerHTML; document.body.innerHTML = '' })
    afterEach(() => { document.body.innerHTML = savedBody })

    const stockFixture = () => harness({
      sessionSnapshot: { ids: ['chat'], current: 'source', byId: { chat: session('chat') } },
      workspaceSnapshot: { items: [{ workspaceId: 'chat-ws', title: 'Chat', sessionIds: ['chat'] }] },
    })

    // `strictSessionComposer` refuses `focusedPaneScope`'s document fallback
    // on purpose (it would focus the OLD Pane's composer), so it can only
    // ever match inside a `[data-session-pane]` element. A host that marks
    // no panes therefore has nothing the wait could ever succeed against: it
    // could only end in its own CHAT_COMPOSER_FOCUS_TIMEOUT_MS timeout, one
    // second of a document-wide MutationObserver and one second of delay on
    // an already-decided downgrade notice.
    it('skips the wait entirely when the document carries no [data-session-pane]', async () => {
      const fixture = stockFixture()
      const surface = ui()
      const focusComposer = vi.fn()
      await expect(createChatActions({
        services: fixture.services, t, now: () => NOW, ui: surface, focusComposer,
      }).open()).resolves.toMatchObject({ kind: 'opened', mode: 'stock', sessionId: 'chat' })
      expect(fixture.open).toHaveBeenCalledWith('chat')
      expect(focusComposer).not.toHaveBeenCalled()
      // Skipping the wait must not skip the notice.
      expect(surface.notify).toHaveBeenCalledWith('chat.stockDowngrade')
    })

    it('still focuses the composer on a host that does mark Session Panes', async () => {
      const pane = document.createElement('section')
      pane.dataset.sessionPane = 'chat'
      document.body.appendChild(pane)
      const fixture = stockFixture()
      const focusComposer = vi.fn()
      await expect(createChatActions({
        services: fixture.services, t, now: () => NOW, ui: ui(), focusComposer,
      }).open()).resolves.toMatchObject({ kind: 'opened', mode: 'stock', sessionId: 'chat' })
      expect(focusComposer).toHaveBeenCalledWith('chat')
    })
  })

  it('opens the chat directly on Edition when no source Pane exists (zero-Pane home state)', async () => {
    // Regression pin: Ctrl+N (sessions.clear) or first launch leaves no focused
    // or current session. Fresh chat must open as the only Pane — never fall
    // into the source-not-visible branch reserved for a captured source that
    // vanished (design.md §4 rule 3).
    //
    // The Workspace here is deliberately named after the user's work, not
    // "Chat": with a "Chat"-named Workspace the FIRST resolution tier answers
    // and this branch is reachable for that one lucky naming only. Every
    // ordinary user arrives here through the recent-Workspace tier, so that
    // is what this fixture exercises.
    const presentation = {
      protocol: 2,
      state: { getSnapshot: () => ({ visible: [] as string[], focused: undefined, capacity: 2 }) },
      open: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
    }
    const fixture = harness({
      sessionSnapshot: { ids: ['chat'], current: undefined, byId: { chat: session('chat') } },
      workspaceSnapshot: {
        items: [{ workspaceId: 'roadmap-ws', title: 'Product Roadmap', sessionIds: ['chat'] }],
        recentWorkspaceId: 'roadmap-ws',
      },
      presentation: presentation as unknown as ReturnType<typeof editionPresentation>,
    })
    const surface = ui()
    const focusComposer = vi.fn()
    await expect(createChatActions({
      services: fixture.services, t, now: () => NOW, ui: surface, focusComposer,
    }).open()).resolves.toMatchObject({
      kind: 'opened', mode: 'edition', workspaceId: 'roadmap-ws', sessionId: 'chat',
    })
    expect(fixture.open).toHaveBeenCalledWith('chat')
    expect(presentation.open).not.toHaveBeenCalled()
    expect(focusComposer).toHaveBeenCalledWith('chat')
    expect(surface.notify).not.toHaveBeenCalled()
  })

  it('resolves the Workspace from the recent projection when the chord is pressed with nothing open', async () => {
    // The stock-mode half of the same zero-source state, and the one users
    // actually hit: no focused Pane, no current Session, no Workspace named
    // "chat". Before the recent-Workspace tier this returned no-workspace and
    // the chord looked broken.
    let fixture: ReturnType<typeof harness>
    const create = vi.fn(async () => {
      fixture.sessionList.update({
        ids: ['created-chat'], current: undefined,
        byId: { 'created-chat': session('created-chat', { updatedAt: NOW }) },
      })
      return { result: { ok: true as const, value: { sessionId: 'created-chat', agentPreset: 'chat' } } }
    })
    fixture = harness({
      sessionSnapshot: { ids: [], current: undefined, byId: {} },
      workspaceSnapshot: {
        items: [
          { workspaceId: 'archive-ws', title: 'Archive', sessionIds: [] },
          { workspaceId: 'roadmap-ws', title: 'Product Roadmap', sessionIds: [] },
        ],
        recentWorkspaceId: 'roadmap-ws',
      },
      create,
    })
    const result = await createChatActions({
      services: fixture.services, t, now: () => NOW, ui: ui(), focusComposer: vi.fn(),
    }).open()
    expect(fixture.create).toHaveBeenCalledWith({ workspaceId: 'roadmap-ws', agentPreset: 'chat' })
    expect(result).toMatchObject({ kind: 'opened', workspaceId: 'roadmap-ws', sessionId: 'created-chat' })
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
