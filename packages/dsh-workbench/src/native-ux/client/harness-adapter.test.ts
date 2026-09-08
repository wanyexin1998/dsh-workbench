// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chatActionServices,
  chatNodeSource,
  currentSessionId,
  resolveHarnessServices,
  sideChatServices,
  subscribeCurrentSessionId,
  type HarnessContext,
  type HarnessServices,
} from './harness-adapter.js'
import { settingsBindingSection } from './shortcuts.js'
import { detectConversationDom } from './conversation-dom.js'

function makeCtx(services: Record<string, unknown> = {}): HarnessContext {
  return {
    get: vi.fn((name: string) => services[name]),
    locale: { register: vi.fn(), bind: vi.fn(() => (key: string) => key) },
    slots: { register: vi.fn(), inject: vi.fn() },
    settingsScope: { bind: vi.fn(() => ({ getSnapshot: () => ({}), subscribe: vi.fn(), set: vi.fn(), unset: vi.fn() })) },
    effect: vi.fn((fn: () => void) => fn()),
    on: vi.fn(),
  }
}

describe('resolveHarnessServices (GA-040, §9A.1)', () => {
  it('narrows ctx.get() into the typed service bundle', () => {
    const sessions = { scope: vi.fn(() => ({ get: vi.fn(() => ({ cancel: vi.fn() })) })) }
    const layout = { toggleSidebar: vi.fn() }
    const remote = { session: { create: vi.fn() } }
    const workspaces = { list: { getSnapshot: vi.fn(), subscribe: vi.fn() } }
    const uiConversation = { binding: vi.fn() }
    const ctx = makeCtx({ remote, sessions, layout, workspaces, uiConversation })
    const services = resolveHarnessServices(ctx)
    expect(services.remote).toBe(remote)
    expect(services.sessions).toBe(sessions)
    expect(services.layout).toBe(layout)
    expect(services.workspaces).toBe(workspaces)
    expect(services.uiConversation).toBe(uiConversation)
    // only the five business-service seams the plugin uses are read
    // (`uiConversation` joined in rc.6: the chat node table lives on its
    // `chat` Conversation target, not on the Session face — see chatNodeSource)
    expect(ctx.get).toHaveBeenCalledTimes(5)
  })

  it('yields undefined members when a service is not injected', () => {
    const services = resolveHarnessServices(makeCtx())
    expect(services.remote).toBeUndefined()
    expect(services.layout).toBeUndefined()
    expect(services.sessions).toBeUndefined()
    expect(services.workspaces).toBeUndefined()
    expect(services.uiConversation).toBeUndefined()
  })
})

/**
 * rc.6 新增的接缝。它本身就是 rc.5 回归的修复点：节点表从会话面搬到了
 * `uiConversation` 的 `chat` 目标上（`ui-chat/src/client/apply.ts:59`）。
 * 三种失败都得归一成 `undefined`，由划词层 fail-closed——特别是
 * `binding()` 对未知会话是**抛**而不是返回 undefined（assembly.ts:213），
 * 这一抛发生在 selectionchange 处理器里，漏接就是一次未捕获异常。
 */
describe('chatNodeSource (rc.6)', () => {
  it('reads the node table off the chat Conversation target', () => {
    const node = { key: 'n', kind: 'user' }
    const target = { getSnapshot: () => ({ nodes: { get: (key: string) => key === 'n' ? node : undefined } }) }
    const binding = vi.fn(() => ({ target: vi.fn(() => target) }))
    const face = chatNodeSource({ binding } as never).face('s')
    expect(binding).toHaveBeenCalledWith('s')
    expect(face?.getSnapshot()?.nodes?.get('n')).toBe(node)
  })

  it('yields undefined when the service is absent, malformed, or has no chat target', () => {
    expect(chatNodeSource(undefined).face('s')).toBeUndefined()
    expect(chatNodeSource({} as never).face('s')).toBeUndefined()
    expect(chatNodeSource({ binding: () => undefined } as never).face('s')).toBeUndefined()
    expect(chatNodeSource({ binding: () => ({ target: () => undefined }) } as never).face('s')).toBeUndefined()
    expect(chatNodeSource({ binding: () => ({ target: () => ({}) }) } as never).face('s')).toBeUndefined()
  })

  it('swallows the unknown-session throw instead of letting it escape a selectionchange handler', () => {
    const source = chatNodeSource({
      binding: (sessionId: string) => { throw new Error(`uiConversation.binding: unknown session "${sessionId}"`) },
    } as never)
    expect(() => source.face('gone')).not.toThrow()
    expect(source.face('gone')).toBeUndefined()
  })
})

describe('chatActionServices', () => {
  const list = {
    getSnapshot: () => ({ ids: [], byId: {}, items: [] }),
    subscribe: vi.fn(() => vi.fn()),
  }

  it('accepts create + workspace list + session list/open without Presentation', () => {
    const services = {
      remote: { session: { create: vi.fn() } },
      sessions: { scope: vi.fn(), list, open: vi.fn() },
      workspaces: { list },
    }
    expect(chatActionServices(services)).toBe(services)
  })

  it.each([
    ['remote', { sessions: { scope: vi.fn(), list, open: vi.fn() }, workspaces: { list } }],
    ['session open', { remote: { session: { create: vi.fn() } }, sessions: { scope: vi.fn(), list }, workspaces: { list } }],
    ['session list', { remote: { session: { create: vi.fn() } }, sessions: { scope: vi.fn(), open: vi.fn() }, workspaces: { list } }],
    ['workspace list', { remote: { session: { create: vi.fn() } }, sessions: { scope: vi.fn(), list, open: vi.fn() } }],
  ])('rejects a bundle missing %s', (_label, services) => {
    expect(chatActionServices(services)).toBeUndefined()
  })
})

describe('sideChatServices', () => {
  const presentation = {
    protocol: 2 as const,
    state: { getSnapshot: () => ({ visible: ['source'], focused: 'source', capacity: 2 }) },
    open: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
  }

  it('accepts the Edition fork/open/focus/scope seams', () => {
    const sessions = { scope: vi.fn(), fork: vi.fn(), presentation }
    expect(sideChatServices({ sessions })).toEqual({ sessions })
  })

  it.each([
    ['stock presentation', { scope: vi.fn(), fork: vi.fn() }],
    ['fork', { scope: vi.fn(), presentation }],
    ['scope', { fork: vi.fn(), presentation }],
    ['open', { scope: vi.fn(), fork: vi.fn(), presentation: { ...presentation, open: undefined } }],
    ['focus', { scope: vi.fn(), fork: vi.fn(), presentation: { ...presentation, focus: undefined } }],
    ['state.getSnapshot', { scope: vi.fn(), fork: vi.fn(), presentation: { ...presentation, state: {} } }],
  ])('rejects a bundle missing %s', (_label, sessions) => {
    expect(sideChatServices({ sessions } as never)).toBeUndefined()
  })

  // The protocol number is the fail-closed half of this gate and it was the
  // one condition no case above could reach: every other rejection fixture
  // either drops `presentation` wholesale or breaks a member the remaining
  // conditions already reject on their own, so the comparison could be
  // widened to a bare presence check and the whole suite stayed green.
  // A same-numbered-but-different face is exactly what a downstream fork
  // ships, and forking a child session into a face this release was never
  // tested against displaces the source Pane — so an off-protocol face must
  // be rejected even when every member this plugin calls is present and
  // callable.
  it.each([
    ['1 (an older revision)', 1],
    ['3 (a newer revision)', 3],
    ['2.5 (a fork revision)', 2.5],
    ['the string "2"', '2'],
    ['undefined', undefined],
    ['null', null],
  ])(
    'rejects an otherwise complete face carrying presentation.protocol %s',
    (_label, protocol) => {
      const sessions = {
        scope: vi.fn(),
        fork: vi.fn(),
        presentation: { ...presentation, protocol },
      }
      expect(sideChatServices({ sessions } as never)).toBeUndefined()
    },
  )
})

// MEDIUM 1 (Opus review, round 2 of native-actions-pivot): `currentSessionId`/
// `subscribeCurrentSessionId` are the stock-public `sessions.list` feed that
// replaced the fork-only `presentation` feed as workbench.session.previous's
// tracker source — see `SessionsService.list`'s doc comment in
// harness-adapter.ts for the full divergence trace this rests on. Same
// defensive-narrowing shape as `focusedSessionId`/`subscribeFocusedSessionId`
// (untested directly, by precedent — exercised only through shortcuts.tsx's
// dispatch tests): a missing/malformed `list`, or one that throws, must
// degrade to "unknown" / "no subscription" rather than throw inside a
// keydown handler or a store notification callback.
describe('currentSessionId / subscribeCurrentSessionId (MEDIUM 1: the sessions.list tracker feed)', () => {
  let listeners: Set<() => void>
  beforeEach(() => { listeners = new Set() })

  const fakeListStore = (current?: string) => ({
    getSnapshot: () => ({ current }),
    subscribe: vi.fn((fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) }),
  })
  const services = (list: unknown): HarnessServices => ({ sessions: { scope: vi.fn(), list } as never })

  it('reads SessionListState.current through list.getSnapshot()', () => {
    expect(currentSessionId(services(fakeListStore('s1')))).toBe('s1')
  })

  it('returns undefined when sessions.list is absent', () => {
    expect(currentSessionId({})).toBeUndefined()
    expect(currentSessionId({ sessions: { scope: vi.fn() } as never })).toBeUndefined()
  })

  it('returns undefined when list is present but malformed (no getSnapshot function)', () => {
    expect(currentSessionId(services({ getSnapshot: 'not-a-function' }))).toBeUndefined()
    expect(currentSessionId(services(null))).toBeUndefined()
  })

  it('returns undefined (never throws) when getSnapshot itself throws', () => {
    const throwing = { getSnapshot: () => { throw new Error('boom') } }
    expect(() => currentSessionId(services(throwing))).not.toThrow()
    expect(currentSessionId(services(throwing))).toBeUndefined()
  })

  it('subscribeCurrentSessionId forwards list notifications to the listener', () => {
    const store = fakeListStore('s1')
    const listener = vi.fn()
    const unsubscribe = subscribeCurrentSessionId(services(store), listener)
    expect(store.subscribe).toHaveBeenCalledOnce()
    for (const fn of [...listeners]) fn() // simulate a store notification
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    expect(listeners.size).toBe(0)
  })

  it('subscribeCurrentSessionId degrades to a no-op unsubscribe when list/subscribe is absent or throws', () => {
    expect(() => subscribeCurrentSessionId({}, vi.fn())()).not.toThrow()
    expect(() => subscribeCurrentSessionId(services({ getSnapshot: () => ({}) }), vi.fn())()).not.toThrow()
    const throwingSubscribe = { getSnapshot: () => ({}), subscribe: () => { throw new Error('boom') } }
    const unsubscribe = subscribeCurrentSessionId(services(throwingSubscribe), vi.fn())
    expect(() => unsubscribe()).not.toThrow()
  })
})

describe('settingsBindingSection (narrow unknown snapshot)', () => {
  it('reads the `user` section when present', () => {
    expect(settingsBindingSection({ user: { 'conversation.composer.focus': 'Primary+Shift+O' } })).toEqual(
      { 'conversation.composer.focus': 'Primary+Shift+O' },
    )
  })

  it('falls back to `value`, then to empty for non-objects', () => {
    expect(settingsBindingSection({ value: { a: 1 } })).toEqual({ a: 1 })
    expect(settingsBindingSection(null)).toEqual({})
    expect(settingsBindingSection('nope')).toEqual({})
    expect(settingsBindingSection({ user: 'not-an-object' })).toEqual({})
  })
})

