// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { resolveHarnessServices, type HarnessContext } from './harness-adapter.js'
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
