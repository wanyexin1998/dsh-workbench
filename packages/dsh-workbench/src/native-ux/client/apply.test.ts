// @vitest-environment jsdom
// Seam B sample: ctx test double verifies plugin wiring without a host.
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from './index.js'

const injectedPaths = new Set(inject)

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
  // cordis 只在声明过的路径上放行：读 `ctx.remote.session` 而 inject 里没有
  // `'remote.session'`，reflect.ts 就抛 `cannot get property ... without inject`。
  // 替身照这条规则来，否则它会比真宿主宽松，测试就会在真宿主炸掉的地方绿灯——
  // rc.4 正是这么放走了一个让整个插件静默失效的缺陷。
  const remote = new Proxy({} as Record<string, unknown>, {
    get(_target, prop: string) {
      if (typeof prop !== 'string') return undefined
      if (!injectedPaths.has(`remote.${prop}`)) {
        throw new Error(`cannot get property "remote.${prop}" without inject`)
      }
      return { create: vi.fn(async () => ({ ok: true, value: { id: 's1' } })) }
    },
  })
  const get = vi.fn((name: string) => (name === 'remote' ? remote : undefined))
  return { ctx: { slots, locale, effect: vi.fn((fn: () => void) => fn()), get, on: vi.fn(), settingsScope: { bind: vi.fn(() => ({ getSnapshot: () => ({}), subscribe: () => () => {}, set: vi.fn(), unset: vi.fn() })) } }, slots, locale, registered }
}

describe('client plugin wiring (seam B sample)', () => {
  it('declares required services', () => {
    expect(inject).toContain('remote')
    expect(inject).toContain('slots')
    expect(inject).toContain('locale')
    expect(inject).toContain('workspaces')
  })

  // applyShortcuts 是 Navigator 退役后插件唯一的 apply 入口，而 apply 外面裹着
  // GA-043 的 fail-soft try/catch：它一抛，插件就静默地什么都不注册，页面照常，
  // 只在控制台留一行 warn。所以"注册成功"这条断言是插件还活着的唯一证据，
  // 上面的 remote 替身按 cordis 规则抛异常，就把那条路径接上了。
  it('registers the shortcuts section on apply', () => {
    const { ctx, registered, locale } = makeCtx()
    apply(ctx)
    const ids = registered.map((r) => r.id)
    expect(ids).toContain('shortcuts')
    expect(locale.register).toHaveBeenCalled()
  })
})
