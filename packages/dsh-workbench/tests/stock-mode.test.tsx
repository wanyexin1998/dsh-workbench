// @vitest-environment jsdom
// A2 (P02, task_plan §3.2/§7) — acceptance evidence for the two-tier
// product: one apply() call, exercised end-to-end under a stock DeepSeek
// Harness (no compatible split-pane presentation) and under a compatible
// Harness (protocol 2, full presentation). Pins:
//   - stock: zero unexpected console errors, Navigator + shortcuts still
//     register, the split-pane module never requests capacity and the
//     guard-failure banner (not the same-workspace banner) is shown;
//   - compatible: capacity requested exactly once and released through the
//     plugin lifecycle, the same-workspace banner (not guard-failure) is
//     shown, no regression in Navigator/shortcuts;
//   - a hostile Navigator failure stays isolated (fail-soft) and never
//     blocks shortcuts or the guard verdict.
// Mocks only at the ctx boundary (slots/locale/sessions/effect/get/on/
// settingsScope) the way guard.test.ts and native-ux/client/apply.test.ts
// already do — no module mocking of index.tsx or its collaborators.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'
import { resetWarnOnce } from '../src/native-ux/client/capabilities.ts'

/** One slots.register() call observed during apply(). */
interface SlotRegistration {
  name: string
  id: string
}

/** One ctx.effect() call: its label and whatever its setup function returned
 * (index.tsx's capacity effect returns the release disposer; the codebase's
 * ctx.effect fake runs the setup synchronously and hands the result back
 * here, mirroring native-ux/client/apply.test.ts's `effect: vi.fn((fn) =>
 * fn())` idiom). */
interface EffectEntry {
  label: string | undefined
  dispose: unknown
}

interface FakeCtxOptions {
  /** The value `platform.sessions` (and ctx.get('sessions')) resolve to. */
  sessions?: unknown
  /** Override ctx.slots.inject — used only by the Navigator-failure test to
   * fail one specific slot seam without touching any other module. */
  slotsInject?: (name: string, setup: () => unknown) => unknown
}

/**
 * Build a ctx test double matching what packages/dsh-workbench/src/client/
 * index.tsx actually reads: sessions/slots/locale as direct properties (the
 * `platform` cast), plus get/effect/on/settingsScope for the HarnessContext
 * cast that applyNavigator/applyShortcuts consume. `sessions` is exposed
 * BOTH as `ctx.sessions` and via `ctx.get('sessions')` so both cast paths
 * observe the identical reference, exactly as the real cordis fiber does.
 */
function makeCtx(options: FakeCtxOptions = {}) {
  const registered: SlotRegistration[] = []
  const effects: EffectEntry[] = []
  const slotsRegister = vi.fn((def: { name: string; id: string }, _component: unknown) => {
    registered.push({ name: def.name, id: def.id })
    return vi.fn() // disposer
  })
  const slotsInject = vi.fn(options.slotsInject ?? ((_name: string, setup: () => unknown) => setup()))
  const slots = { register: slotsRegister, inject: slotsInject }
  const locale = { register: vi.fn(() => vi.fn()), bind: vi.fn(() => (key: string) => key) }
  const settingsScope = {
    bind: vi.fn(() => ({
      // Matches capabilities.test.ts / apply.test.ts's fixture: no
      // status/mode field reads as durable, so HostShortcutPersistence
      // settles on a microtask without ever touching the localStorage
      // fallback's warn-once.
      getSnapshot: () => ({}),
      subscribe: undefined,
      set: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
    })),
  }
  const effect = vi.fn((fn: () => unknown, label?: string) => {
    effects.push({ label, dispose: fn() })
  })
  const ctx = {
    sessions: options.sessions,
    slots,
    locale,
    settingsScope,
    effect,
    get: vi.fn((name: string) => (name === 'sessions' ? options.sessions : undefined)),
    on: vi.fn(),
  }
  return { ctx, registered, effects, slots, locale }
}

/** A structurally complete protocol-2 presentation face (mirrors guard.test.ts's validPresentation). */
function makePresentation(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 2,
    requestCapacity: vi.fn(() => vi.fn()),
    state: { getSnapshot: () => ({ visible: [], capacity: 2 }) },
    ...overrides,
  }
}

function spyConsole() {
  return {
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  }
}

beforeEach(() => {
  resetWarnOnce()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('apply() — stock DeepSeek Harness (no compatible split-pane presentation)', () => {
  it('completes without throwing and emits exactly the one documented disabled diagnostic', () => {
    const { error, warn } = spyConsole()
    const { ctx } = makeCtx({ sessions: {} }) // sessions present, presentation absent
    expect(() => apply(ctx as never)).not.toThrow()
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0]?.[0]).toBe('[dsh-workbench] disabled:')
    expect(warn).not.toHaveBeenCalled()
  })

  it('registers Navigator and the shortcuts settings section regardless of the guard verdict', () => {
    spyConsole()
    const { ctx, registered, locale } = makeCtx({ sessions: {} })
    apply(ctx as never)
    expect(registered).toContainEqual({ name: 'conversation.session.header.utilities', id: 'dsh-native-ux-navigator' })
    expect(registered).toContainEqual({ name: 'settings.section', id: 'shortcuts' })
    expect(locale.register).toHaveBeenCalled()
  })

  it('registers only the guard-failure banner into shell.overlay, never the same-workspace banner', () => {
    spyConsole()
    const { ctx, registered } = makeCtx({ sessions: {} })
    apply(ctx as never)
    expect(registered).toContainEqual({ name: 'shell.overlay', id: 'dsh-workbench.guard-failure' })
    expect(registered.some((r) => r.id === 'dsh-workbench.same-workspace')).toBe(false)
  })

  it('never calls requestCapacity when sessions has no presentation at all', () => {
    spyConsole()
    const { ctx } = makeCtx({ sessions: {} })
    // No requestCapacity exists anywhere in this fixture; a mutant that
    // reached for it (skipping the guard's early return) would throw here
    // instead of just failing an assertion.
    expect(() => apply(ctx as never)).not.toThrow()
  })

  it('rejects a stale presentation protocol without ever calling its requestCapacity', () => {
    spyConsole()
    const requestCapacity = vi.fn(() => vi.fn())
    const presentation = makePresentation({ protocol: 1, requestCapacity })
    const { ctx, registered } = makeCtx({ sessions: { presentation } })
    apply(ctx as never)
    expect(requestCapacity).not.toHaveBeenCalled()
    expect(registered).toContainEqual({ name: 'shell.overlay', id: 'dsh-workbench.guard-failure' })
  })

  it('rejects a structurally malformed protocol-2 face (state.getSnapshot absent) without calling requestCapacity', () => {
    spyConsole()
    const requestCapacity = vi.fn(() => vi.fn())
    const presentation = makePresentation({ requestCapacity, state: {} })
    const { ctx, registered } = makeCtx({ sessions: { presentation } })
    apply(ctx as never)
    expect(requestCapacity).not.toHaveBeenCalled()
    expect(registered).toContainEqual({ name: 'shell.overlay', id: 'dsh-workbench.guard-failure' })
  })

  it('T0.4 hardening: protocol 2 but requestCapacity missing still fails closed at the apply() level', () => {
    const { error } = spyConsole()
    const presentation = makePresentation({ requestCapacity: undefined })
    const { ctx, registered } = makeCtx({ sessions: { presentation } })
    expect(() => apply(ctx as never)).not.toThrow()
    expect(error).toHaveBeenCalledTimes(1)
    expect(registered).toContainEqual({ name: 'shell.overlay', id: 'dsh-workbench.guard-failure' })
    expect(registered.some((r) => r.id === 'dsh-workbench.same-workspace')).toBe(false)
  })
})

describe('apply() — compatible DeepSeek Harness (protocol 2, full presentation)', () => {
  function compatibleCtx() {
    const releaseCapacity = vi.fn()
    const requestCapacity = vi.fn(() => releaseCapacity)
    const presentation = makePresentation({ requestCapacity })
    const built = makeCtx({ sessions: { presentation } })
    return { ...built, requestCapacity, releaseCapacity }
  }

  it('requests capacity exactly once with the two-pane product limit, and releases it through ctx.effect', () => {
    spyConsole()
    const { ctx, effects, requestCapacity, releaseCapacity } = compatibleCtx()
    apply(ctx as never)
    expect(requestCapacity).toHaveBeenCalledTimes(1)
    expect(requestCapacity).toHaveBeenCalledWith(2)
    const capacityEffect = effects.find((entry) => entry.label === 'dsh-workbench: pane capacity')
    expect(capacityEffect).toBeDefined()
    expect(typeof capacityEffect?.dispose).toBe('function')
    expect(releaseCapacity).not.toHaveBeenCalled()
    // Drive the recorded disposer through its lifecycle, as the real cordis
    // fiber would on plugin teardown, and confirm it actually reaches the
    // capacity-release function requestCapacity handed back.
    ;(capacityEffect?.dispose as () => void)()
    expect(releaseCapacity).toHaveBeenCalledTimes(1)
  })

  it('registers only the same-workspace banner into shell.overlay, never the guard-failure banner', () => {
    spyConsole()
    const { ctx, registered } = compatibleCtx()
    apply(ctx as never)
    expect(registered).toContainEqual({ name: 'shell.overlay', id: 'dsh-workbench.same-workspace' })
    expect(registered.some((r) => r.id === 'dsh-workbench.guard-failure')).toBe(false)
  })

  it('emits no [dsh-workbench] disabled: diagnostic', () => {
    const { error } = spyConsole()
    const { ctx } = compatibleCtx()
    apply(ctx as never)
    expect(error).not.toHaveBeenCalled()
  })

  it('still registers Navigator and the shortcuts settings section (compatible behavior does not regress)', () => {
    spyConsole()
    const { ctx, registered } = compatibleCtx()
    apply(ctx as never)
    expect(registered).toContainEqual({ name: 'conversation.session.header.utilities', id: 'dsh-native-ux-navigator' })
    expect(registered).toContainEqual({ name: 'settings.section', id: 'shortcuts' })
  })
})

describe('apply() — fail-soft: a hostile Navigator failure never blocks shortcuts or the guard verdict', () => {
  it('warns once for the Navigator seam and still completes shortcuts registration + the guard flow', () => {
    const { warn } = spyConsole()
    const boom = new Error('navigator slot seam removed')
    const { ctx, registered } = makeCtx({
      sessions: {}, // stock: the guard fails closed too, in the same apply() call
      slotsInject: (name, setup) => {
        if (name === 'conversation.session.header.utilities') throw boom
        return setup()
      },
    })
    expect(() => apply(ctx as never)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('navigator module failed to register')
    // Navigator itself never registered...
    expect(registered.some((r) => r.id === 'dsh-native-ux-navigator')).toBe(false)
    // ...but shortcuts and the guard-failure banner still went through.
    expect(registered).toContainEqual({ name: 'settings.section', id: 'shortcuts' })
    expect(registered).toContainEqual({ name: 'shell.overlay', id: 'dsh-workbench.guard-failure' })
  })
})
