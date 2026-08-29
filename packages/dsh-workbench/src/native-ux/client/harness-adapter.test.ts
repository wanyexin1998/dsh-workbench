// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  currentSessionId,
  resolveHarnessServices,
  subscribeCurrentSessionId,
  type HarnessContext,
  type HarnessServices,
} from './harness-adapter.js'
import { settingsBindingSection } from './shortcuts.js'
import { detectConversationDom, normalizeInputNode } from './conversation-dom.js'

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
    const ctx = makeCtx({ sessions, layout })
    const services = resolveHarnessServices(ctx)
    expect(services.sessions).toBe(sessions)
    expect(services.layout).toBe(layout)
    // only the two seams the plugin uses are read
    expect(ctx.get).toHaveBeenCalledTimes(2)
  })

  it('yields undefined members when a service is not injected', () => {
    const services = resolveHarnessServices(makeCtx())
    expect(services.layout).toBeUndefined()
    expect(services.sessions).toBeUndefined()
  })
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
    expect(settingsBindingSection({ user: { 'conversation.navigator.toggle': 'Primary+Shift+O' } })).toEqual(
      { 'conversation.navigator.toggle': 'Primary+Shift+O' },
    )
  })

  it('falls back to `value`, then to empty for non-objects', () => {
    expect(settingsBindingSection({ value: { a: 1 } })).toEqual({ a: 1 })
    expect(settingsBindingSection(null)).toEqual({})
    expect(settingsBindingSection('nope')).toEqual({})
    expect(settingsBindingSection({ user: 'not-an-object' })).toEqual({})
  })
})

describe('normalizeInputNode (narrow unknown node → InputNodeView)', () => {
  it('accepts the flat shape and the .data payload shape', () => {
    expect(normalizeInputNode({ kind: 'user', key: 'k1', seq: 3, time: 100, content: [{ kind: 'text', text: 'hi' }] })).toEqual({
      kind: 'user', key: 'k1', seq: 3, time: 100, content: [{ kind: 'text', text: 'hi' }],
    })
    expect(normalizeInputNode({ kind: 'steering', key: 'k2', data: { seq: 5, content: [] } })).toEqual({
      kind: 'steering', key: 'k2', seq: 5, time: undefined, content: [],
    })
  })

  it('returns null for non-objects and for nodes missing kind/key', () => {
    expect(normalizeInputNode(null)).toBeNull()
    expect(normalizeInputNode(42)).toBeNull()
    expect(normalizeInputNode({ kind: 'user' })).toBeNull()
    expect(normalizeInputNode({ key: 'k1' })).toBeNull()
  })
})
