// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SelectionController, type SelectionSessions } from './selection-controller.js'

function store<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next: T) {
      value = next
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

function node(key: string, kind = 'user', overrides: Record<string, unknown> = {}) {
  return {
    key, kind, anchorSeq: 42, visibility: 'visible',
    data: kind === 'assistant-step' ? { status: 'settled' } : {},
    ...overrides,
  }
}

function sessionFace(sessionId: string, initialNode: ReturnType<typeof node>) {
  const nodes = new Map([[initialNode.key, initialNode]])
  const snapshot = store({ sessionId, chat: { nodes: { get: (key: string) => nodes.get(key) } } })
  return { ...snapshot, nodes }
}

function sessionsFixture(options: {
  current?: string
  visible?: readonly string[]
  faces: Record<string, ReturnType<typeof sessionFace>>
}): SelectionSessions & { listStore: ReturnType<typeof store<{ current?: string }>>; presentationStore?: ReturnType<typeof store<{ visible: readonly string[]; focused?: string }>> } {
  const listStore = store<{ current?: string }>({ current: options.current })
  const scopes = new Map(Object.keys(options.faces).map((id) => [id, { id }]))
  const presentationStore = options.visible === undefined ? undefined : store({ visible: options.visible, focused: options.visible[0] })
  return {
    list: listStore,
    ...(presentationStore === undefined ? {} : { presentation: { state: presentationStore } }),
    scope: (id) => scopes.get(id),
    sessionOf: (scope) => options.faces[(scope as { id: string }).id],
    listStore,
    presentationStore,
  }
}

function selectionRange(options: { sessionId?: string; key?: string; kind?: string; text?: string } = {}) {
  const root = document.createElement('main')
  root.className = 'ConversationRoot_root'
  root.dataset.phase = 'ready'
  const pane = options.sessionId === undefined ? null : document.createElement('section')
  if (pane !== null) pane.dataset.sessionPane = options.sessionId
  const flow = document.createElement('div')
  flow.dataset.chatFlow = ''
  const row = document.createElement('article')
  row.dataset.chatAnchorKey = `anchor-${options.key ?? 'node'}`
  row.dataset.chatFlowKey = options.key ?? 'node'
  row.dataset.chatFlowKind = options.kind ?? 'user'
  const text = document.createTextNode(options.text ?? 'selected text')
  row.append(text)
  flow.append(row)
  root.append(flow)
  ;(pane ?? document.body).append(root)
  if (pane !== null) document.body.append(pane)
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, text.length)
  return { range, root, row }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('SelectionController source identity', () => {
  it('uses the nearest Pane and keeps it frozen across focus/current changes', () => {
    const left = sessionFace('left', node('node'))
    const right = sessionFace('right', node('other'))
    const sessions = sessionsFixture({ current: 'right', visible: ['left', 'right'], faces: { left, right } })
    const controller = new SelectionController(sessions)
    const { range } = selectionRange({ sessionId: 'left' })
    const captured = controller.captureRange(range)
    expect(captured).toMatchObject({ parentSessionId: 'left', atSeq: 42, text: 'selected text' })

    sessions.listStore.set({ current: 'right' })
    sessions.presentationStore?.set({ visible: ['left', 'right'], focused: 'right' })
    expect(controller.getSnapshot().selection).toBe(captured)
    expect(controller.revalidate(captured!)).toBe(captured)
    controller.dispose()
  })

  it('uses exactly-one-visible fallback, then the stock current fallback only when Presentation is absent', () => {
    const only = sessionFace('only', node('node'))
    const edition = sessionsFixture({ current: 'wrong', visible: ['only'], faces: { only } })
    const editionController = new SelectionController(edition)
    expect(editionController.captureRange(selectionRange().range)?.parentSessionId).toBe('only')
    editionController.dispose()

    document.body.innerHTML = ''
    const stock = sessionFace('stock', node('node'))
    const stockSessions = sessionsFixture({ current: 'stock', faces: { stock } })
    const stockController = new SelectionController(stockSessions)
    expect(stockController.captureRange(selectionRange().range)?.parentSessionId).toBe('stock')
    stockController.dispose()
  })

  it('rejects ambiguous Edition fallback and unsupported/hidden/unsettled nodes', () => {
    const ambiguousFace = sessionFace('a', node('node'))
    const ambiguous = new SelectionController(sessionsFixture({ visible: ['a', 'b'], faces: { a: ambiguousFace } }))
    expect(ambiguous.captureRange(selectionRange().range)).toBeNull()
    ambiguous.dispose()

    for (const invalid of [
      node('node', 'tool'),
      node('node', 'user', { visibility: 'hidden' }),
      node('node', 'assistant-step', { data: { status: 'running' } }),
    ]) {
      document.body.innerHTML = ''
      const face = sessionFace('s', invalid)
      const controller = new SelectionController(sessionsFixture({ current: 's', faces: { s: face } }))
      expect(controller.captureRange(selectionRange({ key: 'node', kind: invalid.kind }).range)).toBeNull()
      controller.dispose()
    }
  })

  it('clears when the captured node becomes stale or its source Session is replaced', () => {
    const face = sessionFace('stock', node('node'))
    const sessions = sessionsFixture({ current: 'stock', faces: { stock: face } })
    const controller = new SelectionController(sessions)
    expect(controller.captureRange(selectionRange().range)).not.toBeNull()
    face.nodes.set('node', node('node', 'user', { visibility: 'hidden' }))
    face.set(face.getSnapshot())
    expect(controller.getSnapshot().selection).toBeNull()

    document.body.innerHTML = ''
    face.nodes.set('node', node('node'))
    expect(controller.captureRange(selectionRange().range)).not.toBeNull()
    sessions.listStore.set({ current: 'replacement' })
    expect(controller.getSnapshot().selection).toBeNull()
    controller.dispose()
  })

  it('releases a face whose subscribe callback invalidates synchronously', () => {
    const release = vi.fn()
    let reads = 0
    const valid = node('node')
    const hidden = node('node', 'user', { visibility: 'hidden' })
    const face = {
      getSnapshot: () => ({
        sessionId: 's',
        chat: { nodes: { get: () => reads++ === 0 ? valid : hidden } },
      }),
      subscribe(listener: () => void) {
        listener()
        return release
      },
    }
    const scope = {}
    const sessions: SelectionSessions = {
      list: { getSnapshot: () => ({ current: 's' }) },
      scope: () => scope,
      sessionOf: () => face,
    }
    const controller = new SelectionController(sessions)
    expect(controller.captureRange(selectionRange().range)).toBeNull()
    expect(controller.getSnapshot().selection).toBeNull()
    expect(release).toHaveBeenCalledTimes(1)
    controller.dispose()
    expect(release).toHaveBeenCalledTimes(1)
  })
})

describe('SelectionController lifecycle', () => {
  it('clears on Escape, scroll, resize, and dispose', () => {
    const face = sessionFace('s', node('node'))
    const controller = new SelectionController(sessionsFixture({ current: 's', faces: { s: face } }))
    const capture = () => controller.captureRange(selectionRange().range)

    expect(capture()).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(controller.getSnapshot().selection).toBeNull()

    document.body.innerHTML = ''
    expect(capture()).not.toBeNull()
    document.dispatchEvent(new Event('scroll'))
    expect(controller.getSnapshot().selection).toBeNull()

    document.body.innerHTML = ''
    expect(capture()).not.toBeNull()
    window.dispatchEvent(new Event('resize'))
    expect(controller.getSnapshot().selection).toBeNull()

    controller.dispose()
    expect(controller.captureRange(selectionRange().range)).toBeNull()
  })

  it('dispose removes every global DOM listener and store subscription', () => {
    // Mutation pin for issue 03's "插件 dispose 均清理浮层与 listener": the
    // #disposed flag alone satisfies the behavioral assertions above, so this
    // test asserts the actual add/remove pairing and subscription release.
    const addDoc = vi.spyOn(document, 'addEventListener')
    const removeDoc = vi.spyOn(document, 'removeEventListener')
    const addWin = vi.spyOn(window, 'addEventListener')
    const removeWin = vi.spyOn(window, 'removeEventListener')
    try {
      const face = sessionFace('s', node('node'))
      const sessions = sessionsFixture({ current: 's', visible: ['s'], faces: { s: face } })
      const controller = new SelectionController(sessions)
      expect(sessions.listStore.listenerCount()).toBe(1)
      expect(sessions.presentationStore?.listenerCount()).toBe(1)
      const docAdds = [...addDoc.mock.calls]
      const winAdds = [...addWin.mock.calls]
      expect(docAdds.length).toBeGreaterThanOrEqual(3)
      expect(winAdds.length).toBeGreaterThanOrEqual(1)
      controller.dispose()
      // Same type, same handler reference, same capture flag for every add.
      for (const call of docAdds) expect(removeDoc.mock.calls).toContainEqual(call)
      for (const call of winAdds) expect(removeWin.mock.calls).toContainEqual(call)
      expect(sessions.listStore.listenerCount()).toBe(0)
      expect(sessions.presentationStore?.listenerCount()).toBe(0)
    } finally {
      addDoc.mockRestore()
      removeDoc.mockRestore()
      addWin.mockRestore()
      removeWin.mockRestore()
    }
  })

  it('clears a pane-sourced selection when its source Pane leaves visible membership', () => {
    // Edition half of issue 03's "Session 替换清理浮层" criterion: the
    // presentation.state subscription's clear branch, not just its keep branch.
    const left = sessionFace('left', node('node'))
    const right = sessionFace('right', node('other'))
    const sessions = sessionsFixture({ current: 'right', visible: ['left', 'right'], faces: { left, right } })
    const controller = new SelectionController(sessions)
    const captured = controller.captureRange(selectionRange({ sessionId: 'left' }).range)
    expect(captured).toMatchObject({ parentSessionId: 'left' })
    sessions.presentationStore?.set({ visible: ['replacement', 'right'], focused: 'right' })
    expect(controller.getSnapshot().selection).toBeNull()
    controller.dispose()
  })

  it('focuses only the captured Conversation root composer', () => {
    const face = sessionFace('s', node('node'))
    const controller = new SelectionController(sessionsFixture({ current: 's', faces: { s: face } }))
    const { range, root } = selectionRange()
    const other = document.createElement('textarea')
    document.body.prepend(other)
    const seat = document.createElement('div')
    seat.dataset.composerSeat = ''
    const target = document.createElement('textarea')
    seat.append(target)
    root.append(seat)
    const captured = controller.captureRange(range)
    expect(captured).not.toBeNull()
    controller.focusSourceComposer()
    expect(document.activeElement).toBe(target)
    controller.dispose()
  })
})
