// @vitest-environment jsdom
// Seam B sample: ctx test double verifies plugin wiring without a host.
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from './index.js'

function makeCtx() {
  const registered: Array<{ name: string; id: string }> = []
  const slots = {
    register: vi.fn((def: { name: string; id: string }, _comp: unknown) => {
      registered.push({ name: def.name, id: def.id })
    }),
    inject: vi.fn((_slot: string, fn: () => void) => fn()),
  }
  const locale = {
    register: vi.fn(),
    bind: vi.fn(() => (key: string) => key),
  }
  return { ctx: { slots, locale, effect: vi.fn((fn: () => void) => fn()), get: vi.fn(() => undefined), on: vi.fn(), settingsScope: { bind: vi.fn(() => ({ getSnapshot: () => ({}), subscribe: () => () => {}, set: vi.fn(), unset: vi.fn() })) } }, slots, locale, registered }
}

describe('client plugin wiring (seam B sample)', () => {
  it('declares required services', () => {
    expect(inject).toContain('connection')
    expect(inject).toContain('slots')
    expect(inject).toContain('locale')
    expect(inject).toContain('workspaces')
  })

  it('registers navigator and shortcuts sections on apply', () => {
    const { ctx, registered, locale } = makeCtx()
    apply(ctx)
    const ids = registered.map((r) => r.id)
    expect(ids).toContain('dsh-native-ux-navigator')
    expect(ids).toContain('shortcuts')
    expect(locale.register).toHaveBeenCalled()
  })
})
