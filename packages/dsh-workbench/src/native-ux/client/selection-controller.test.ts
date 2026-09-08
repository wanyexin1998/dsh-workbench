// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatNodeSource } from './harness-adapter.js'
import {
  SelectionController,
  type SelectionChatFace,
  type SelectionChatSource,
  type SelectionSessions,
} from './selection-controller.js'
import {
  hostChatNode as node,
  hostUiConversation,
  type HostChatNode,
} from '../../../tests/host-double.ts'

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

/**
 * 一整套宿主替身：会话服务 + chat 节点面。
 *
 * chat 那半边**必须**穿过产品自己的适配器 `chatNodeSource`，替身只扮演
 * `uiConversation` 服务本身。这是 rc.5 的教训落到测试上的形状：上一版的替身
 * 直接把节点表挂在会话快照上，于是「上游把节点表搬走了」这件事在测试里根本
 * 不可见。现在替身与真宿主同形（`binding()` 未知会话时抛、目标未激活时
 * `getSnapshot()` 给 undefined），适配器一断，这里就红。
 */
function sessionsFixture(options: {
  current?: string
  visible?: readonly string[]
  nodes: Record<string, readonly HostChatNode[]>
  chatTargetAbsent?: boolean
  diagnostic?: (message: string) => void
}) {
  const listStore = store<{ current?: string }>({ current: options.current })
  const scopes = new Map(Object.keys(options.nodes).map((id) => [id, { id }]))
  const presentationStore = options.visible === undefined
    ? undefined
    : store({ visible: options.visible, focused: options.visible[0] })
  const ui = hostUiConversation(options.nodes, { chatTargetAbsent: options.chatTargetAbsent })
  const sessions: SelectionSessions = {
    list: listStore,
    ...(presentationStore === undefined ? {} : { presentation: { state: presentationStore } }),
    scope: (id: string) => scopes.get(id),
  }
  const chat = chatNodeSource(ui)
  return {
    sessions,
    chat,
    listStore,
    presentationStore,
    /** 某个会话的节点表句柄；`set` 改节点，`publish` 推一次失效。 */
    nodesOf: (sessionId: string) => {
      const handle = ui.stores.get(sessionId)
      if (handle === undefined) throw new Error(`fixture: no session "${sessionId}"`)
      return handle
    },
    controller: (diagnostic = options.diagnostic ?? (() => {})) =>
      new SelectionController(sessions, chat, document, diagnostic),
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
    const fixture = sessionsFixture({
      current: 'right',
      visible: ['left', 'right'],
      nodes: { left: [node('node')], right: [node('other')] },
    })
    const controller = fixture.controller()
    const { range } = selectionRange({ sessionId: 'left' })
    const captured = controller.captureRange(range)
    expect(captured).toMatchObject({ parentSessionId: 'left', atSeq: 42, text: 'selected text' })

    fixture.listStore.set({ current: 'right' })
    fixture.presentationStore?.set({ visible: ['left', 'right'], focused: 'right' })
    expect(controller.getSnapshot().selection).toBe(captured)
    expect(controller.revalidate(captured!)).toBe(captured)
    controller.dispose()
  })

  it('uses exactly-one-visible fallback, then the stock current fallback only when Presentation is absent', () => {
    const edition = sessionsFixture({ current: 'wrong', visible: ['only'], nodes: { only: [node('node')] } })
    const editionController = edition.controller()
    expect(editionController.captureRange(selectionRange().range)?.parentSessionId).toBe('only')
    editionController.dispose()

    document.body.innerHTML = ''
    const stock = sessionsFixture({ current: 'stock', nodes: { stock: [node('node')] } })
    const stockController = stock.controller()
    expect(stockController.captureRange(selectionRange().range)?.parentSessionId).toBe('stock')
    stockController.dispose()
  })

  it('rejects ambiguous Edition fallback and unsupported/hidden/unsettled nodes', () => {
    const ambiguous = sessionsFixture({ visible: ['a', 'b'], nodes: { a: [node('node')] } })
    const ambiguousController = ambiguous.controller()
    expect(ambiguousController.captureRange(selectionRange().range)).toBeNull()
    ambiguousController.dispose()

    for (const invalid of [
      node('node', 'tool'),
      node('node', 'turn-tail'),
      node('node', 'system-prompt'),
      node('node', 'user', { visibility: 'hidden' }),
      node('node', 'assistant-step', { data: { status: 'running' } }),
    ]) {
      document.body.innerHTML = ''
      const fixture = sessionsFixture({ current: 's', nodes: { s: [invalid] } })
      const controller = fixture.controller()
      expect(controller.captureRange(selectionRange({ key: 'node', kind: invalid.kind }).range)).toBeNull()
      controller.dispose()
    }
  })

  it('accepts steering rows on the same terms as user rows', () => {
    // 宿主把 `steering` 和 `user` 当同一件东西渲染（同一个
    // UserMessageNodeView，见 register-node-renderers.ts:19-22），正文行长得
    // 一模一样。判官里漏了它，用户得到的就是“有些行能划有些不能”。
    const fixture = sessionsFixture({ current: 's', nodes: { s: [node('node', 'steering')] } })
    const controller = fixture.controller()
    const captured = controller.captureRange(selectionRange({ kind: 'steering' }).range)
    expect(captured).toMatchObject({ parentSessionId: 's', nodeKind: 'steering', atSeq: 42 })
    controller.dispose()
  })

  it('clears when the captured node becomes stale or its source Session is replaced', () => {
    const fixture = sessionsFixture({ current: 'stock', nodes: { stock: [node('node')] } })
    const controller = fixture.controller()
    expect(controller.captureRange(selectionRange().range)).not.toBeNull()
    fixture.nodesOf('stock').set('node', node('node', 'user', { visibility: 'hidden' }))
    fixture.nodesOf('stock').publish()
    expect(controller.getSnapshot().selection).toBeNull()

    document.body.innerHTML = ''
    fixture.nodesOf('stock').set('node', node('node'))
    expect(controller.captureRange(selectionRange().range)).not.toBeNull()
    fixture.listStore.set({ current: 'replacement' })
    expect(controller.getSnapshot().selection).toBeNull()
    controller.dispose()
  })

  it('releases a face whose subscribe callback invalidates synchronously', () => {
    const release = vi.fn()
    let reads = 0
    const valid = node('node')
    const hidden = node('node', 'user', { visibility: 'hidden' })
    const face: SelectionChatFace = {
      getSnapshot: () => ({ nodes: { get: () => reads++ === 0 ? valid : hidden } }),
      subscribe(listener: () => void) {
        listener()
        return release
      },
    }
    const sessions: SelectionSessions = { list: { getSnapshot: () => ({ current: 's' }) } }
    const chat: SelectionChatSource = { face: () => face }
    const controller = new SelectionController(sessions, chat)
    expect(controller.captureRange(selectionRange().range)).toBeNull()
    expect(controller.getSnapshot().selection).toBeNull()
    expect(release).toHaveBeenCalledTimes(1)
    controller.dispose()
    expect(release).toHaveBeenCalledTimes(1)
  })
})

/**
 * rc.5 的回归 pin。
 *
 * 那一版发布出去的构建在自己钉的宿主上**每一次划词都被静默否决**：上游把 chat
 * 节点表从会话面搬进了 `ui-chat`，插件仍然读 `snapshot.chat.nodes`，可选链读到
 * `undefined` 就 `return null`。零报错、零日志，排查花了几个小时。
 *
 * 下面两条各钉住这件事的一半：**节点表必须来自 chat 目标**，以及**面搬家不能
 * 再表现得和面缺失一样**。
 */
describe('SelectionController chat-node source (rc.5 regression)', () => {
  it('rejects and reports once when the chat target publishes no node store', () => {
    const diagnostic = vi.fn()
    const fixture = sessionsFixture({
      current: 'stock',
      nodes: { stock: [node('node')] },
      chatTargetAbsent: true,
    })
    const controller = fixture.controller(diagnostic)
    expect(controller.captureRange(selectionRange().range)).toBeNull()
    document.body.innerHTML = ''
    expect(controller.captureRange(selectionRange().range)).toBeNull()
    // 每种形状只说一次——划词是高频事件，刷屏的日志等于没有日志。
    expect(diagnostic).toHaveBeenCalledTimes(1)
    expect(diagnostic.mock.calls[0]![0]).toContain('no node store')
    controller.dispose()
  })

  it('never falls back to a node table hung off the Session face', () => {
    // 老形状：会话面上有 chat.nodes，节点齐全。新判官不认它——节点表只能从
    // chat 目标来。这一条会在有人「顺手」把旧读法加回去时立刻红。
    const diagnostic = vi.fn()
    const legacySessionFace = {
      getSnapshot: () => ({ sessionId: 's', chat: { nodes: { get: () => node('node') } } }),
      subscribe: () => () => {},
    }
    const sessions: SelectionSessions = {
      list: { getSnapshot: () => ({ current: 's' }) },
      scope: () => legacySessionFace,
    }
    // 宿主没有 uiConversation 服务时，适配器给不出面。
    const controller = new SelectionController(sessions, chatNodeSource(undefined), document, diagnostic)
    expect(controller.captureRange(selectionRange().range)).toBeNull()
    expect(diagnostic).toHaveBeenCalledTimes(1)
    expect(diagnostic.mock.calls[0]![0]).toContain('no chat face')
    controller.dispose()
  })

  it('resolves the node table per session through the chat binding', () => {
    const fixture = sessionsFixture({
      visible: ['left', 'right'],
      nodes: { left: [node('shared')], right: [node('shared', 'user', { anchorSeq: 7 })] },
    })
    const controller = fixture.controller()
    const left = controller.captureRange(selectionRange({ sessionId: 'left', key: 'shared' }).range)
    expect(left).toMatchObject({ parentSessionId: 'left', atSeq: 42 })
    controller.clear()
    document.body.innerHTML = ''
    const right = controller.captureRange(selectionRange({ sessionId: 'right', key: 'shared' }).range)
    expect(right).toMatchObject({ parentSessionId: 'right', atSeq: 7 })
    controller.dispose()
  })
})

/**
 * Mutation pins for `#validateActive` — the enforcement point of ADR-0009's
 * "the selection identity captured at capture time is the only identity an
 * action may act on". The existing suite only reaches this method through
 * `validatedNode` rejections (hidden node, replaced Session), so each
 * revalidation predicate could be deleted without turning anything red. Every
 * case below keeps the capture otherwise perfectly valid and moves exactly one
 * dimension of that identity.
 *
 * Some of those dimensions are guarded in two redundant places, where
 * deleting a single guard stays green because the other still rejects the
 * scenario. Those cases name the mutant(s) they actually kill, so nothing
 * here reads as a pin it is not.
 */
describe('SelectionController capture-time identity revalidation', () => {
  it('drops the capture when the anchor sequence moves under the same node key', () => {
    const fixture = sessionsFixture({ current: 'stock', nodes: { stock: [node('node')] } })
    const controller = fixture.controller()
    const captured = controller.captureRange(selectionRange().range)
    expect(captured).toMatchObject({ nodeKey: 'node', atSeq: 42 })

    // Same key, same kind, still visible — only the frozen anchor moved, so
    // the captured offsets no longer address the text they were taken from.
    fixture.nodesOf('stock').set('node', node('node', 'user', { anchorSeq: 43 }))
    expect(controller.revalidate(captured!)).toBeNull()
    // The stale capture is never silently re-pointed at the new anchor.
    expect(captured!.atSeq).toBe(42)
    fixture.nodesOf('stock').publish()
    expect(controller.getSnapshot().selection).toBeNull()
    controller.dispose()
  })

  it('drops the capture when the captured row moves under a different Pane identity', () => {
    // Kills: the `paneSessionId` term of `sameDomSelection` AND
    // `#validateActive`'s own pane re-check, but only together — either one
    // alone rejects this scenario, so deleting just one stays green.
    // That is a property of the product, not a gap in this case: once
    // `sameDomSelection` has passed, `nextDom.paneSessionId` equals
    // `active.dom.paneSessionId`, which for a pane-sourced capture IS
    // `parentSessionId` and otherwise is `undefined` and skipped — so the
    // re-check can never be the one that rejects. The case after this one
    // kills the `sameDomSelection` term on its own.
    // Same node key and anchor on both sides: only the Pane identity separates
    // the frozen routing target from the Session the row now sits in.
    const fixture = sessionsFixture({
      current: 'right',
      visible: ['left', 'right'],
      nodes: { left: [node('node')], right: [node('node')] },
    })
    const controller = fixture.controller()
    const { range, root } = selectionRange({ sessionId: 'left' })
    const captured = controller.captureRange(range)
    expect(captured).toMatchObject({ parentSessionId: 'left' })

    root.closest<HTMLElement>('[data-session-pane]')!.dataset.sessionPane = 'right'
    expect(controller.revalidate(captured!)).toBeNull()
    // Routing stays frozen on 'left' and is withdrawn rather than retargeted.
    expect(captured!.parentSessionId).toBe('left')
    fixture.nodesOf('left').publish()
    expect(controller.getSnapshot().selection).toBeNull()
    controller.dispose()
  })

  it('drops a pane-less capture once its own subtree starts claiming a Pane', () => {
    // Kills: the `paneSessionId` term of `sameDomSelection`, on its own — the
    // one mutant the case above cannot reach. Captured under stock rendering
    // (no `[data-session-pane]` ancestor at all), the host then marks the
    // Conversation root as the Pane of the very Session this capture is
    // already routed to. Nothing else about the selection moves, and
    // `#validateActive`'s own pane re-check is satisfied (the new marker
    // agrees with `parentSessionId`), so the capture-time DOM comparison is
    // the only thing left that can reject it — and it must: the frozen
    // capture is withdrawn, never adopted into a Pane it was not taken in.
    // The marker is set in place rather than by re-parenting the root, which
    // would collapse the live Range and make this pass for the wrong reason.
    const fixture = sessionsFixture({ current: 'stock', nodes: { stock: [node('node')] } })
    const controller = fixture.controller()
    const { range, root } = selectionRange()
    const captured = controller.captureRange(range)
    expect(captured).toMatchObject({ parentSessionId: 'stock' })

    root.dataset.sessionPane = 'stock'
    expect(controller.revalidate(captured!)).toBeNull()
    fixture.nodesOf('stock').publish()
    expect(controller.getSnapshot().selection).toBeNull()
    controller.dispose()
  })

  it('drops the capture when a row re-render shifts the frozen offsets', () => {
    const fixture = sessionsFixture({ current: 'stock', nodes: { stock: [node('node')] } })
    const controller = fixture.controller()
    const { range, row } = selectionRange()
    const captured = controller.captureRange(range)
    expect(captured).toMatchObject({ text: 'selected text', startOffset: 0, endOffset: 13 })

    // Kills: the offset terms of `sameDomSelection` as a pair — deleting
    // either `startOffset` or `endOffset` alone stays green, since a shift
    // moves both.
    // The row re-renders with content ahead of the selection: the same visible
    // text is still present, but at row offsets 7..20 rather than 0..13.
    row.prepend(document.createTextNode('prefix '))
    expect(controller.revalidate(captured!)).toBeNull()
    expect(captured!.startOffset).toBe(0)
    fixture.nodesOf('stock').publish()
    expect(controller.getSnapshot().selection).toBeNull()
    controller.dispose()
  })

  it('drops the capture when the captured row element leaves the document', () => {
    const fixture = sessionsFixture({ current: 'stock', nodes: { stock: [node('node')] } })
    const controller = fixture.controller()
    const { range, row } = selectionRange()
    const captured = controller.captureRange(range)
    expect(captured).not.toBeNull()

    row.remove()
    expect(controller.revalidate(captured!)).toBeNull()
    fixture.nodesOf('stock').publish()
    expect(controller.getSnapshot().selection).toBeNull()
    controller.dispose()
  })
})

describe('SelectionController lifecycle', () => {
  it('clears on Escape, scroll, resize, and dispose', () => {
    const fixture = sessionsFixture({ current: 's', nodes: { s: [node('node')] } })
    const controller = fixture.controller()
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
      const fixture = sessionsFixture({ current: 's', visible: ['s'], nodes: { s: [node('node')] } })
      const controller = fixture.controller()
      expect(fixture.listStore.listenerCount()).toBe(1)
      expect(fixture.presentationStore?.listenerCount()).toBe(1)
      const docAdds = [...addDoc.mock.calls]
      const winAdds = [...addWin.mock.calls]
      expect(docAdds.length).toBeGreaterThanOrEqual(3)
      expect(winAdds.length).toBeGreaterThanOrEqual(1)
      // 划一次词，把 chat 面的订阅也建起来——dispose 必须把它一并解掉。
      expect(controller.captureRange(selectionRange().range)).not.toBeNull()
      expect(fixture.nodesOf('s').listenerCount()).toBe(1)
      controller.dispose()
      // Same type, same handler reference, same capture flag for every add.
      for (const call of docAdds) expect(removeDoc.mock.calls).toContainEqual(call)
      for (const call of winAdds) expect(removeWin.mock.calls).toContainEqual(call)
      expect(fixture.listStore.listenerCount()).toBe(0)
      expect(fixture.presentationStore?.listenerCount()).toBe(0)
      expect(fixture.nodesOf('s').listenerCount()).toBe(0)
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
    const fixture = sessionsFixture({
      current: 'right',
      visible: ['left', 'right'],
      nodes: { left: [node('node')], right: [node('other')] },
    })
    const controller = fixture.controller()
    const captured = controller.captureRange(selectionRange({ sessionId: 'left' }).range)
    expect(captured).toMatchObject({ parentSessionId: 'left' })
    fixture.presentationStore?.set({ visible: ['replacement', 'right'], focused: 'right' })
    expect(controller.getSnapshot().selection).toBeNull()
    controller.dispose()
  })

  it('focuses only the captured Conversation root composer', () => {
    const fixture = sessionsFixture({ current: 's', nodes: { s: [node('node')] } })
    const controller = fixture.controller()
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
