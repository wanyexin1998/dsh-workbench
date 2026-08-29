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
import { parseChord } from '../src/native-ux/core/chord.ts'

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
 *
 * Captures each `def.inject?.()` result alongside `registered` (keyed by
 * slot id) so a test can reach the shortcuts settings section's live
 * `controller` — e.g. to inspect `controller.registry` for native actions.
 */
function makeCtx(options: FakeCtxOptions = {}) {
  const registered: SlotRegistration[] = []
  const injected: Record<string, unknown> = {}
  const effects: EffectEntry[] = []
  const slotsRegister = vi.fn((def: { id: string; name: string; inject?: () => unknown }, _component: unknown) => {
    registered.push({ name: def.name, id: def.id })
    if (def.inject !== undefined) injected[def.id] = def.inject()
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
  // W3.1: a real cordis Context always carries `.reflect` (core
  // infrastructure — ReflectService is installed by the Context constructor
  // itself, unlike host-mountable optional services such as `layout`), so
  // index.tsx's `ctx.reflect.provide(...)` call is never wrapped in its own
  // fail-soft try/catch. This fixture mirrors the shape that matters for
  // these tests (records what was provided, hands back an idempotent
  // disposer) — the real ReflectService.provide's own disposer is async
  // (`() => Promise<void>`); this fixture's is sync, which is fine here
  // since nothing in this file awaits it.
  const provided: Array<{ name: string; value: unknown }> = []
  const reflect = {
    provide: vi.fn((name: string, value: unknown) => {
      provided.push({ name, value })
      return vi.fn()
    }),
  }
  const ctx = {
    sessions: options.sessions,
    slots,
    locale,
    settingsScope,
    effect,
    reflect,
    get: vi.fn((name: string) => {
      if (name === 'sessions') return options.sessions
      return undefined
    }),
    on: vi.fn(),
  }
  return { ctx, registered, injected, effects, slots, locale, provided }
}

/** Drain a handful of microtask hops — the shortcuts settings hydration
 * (localStorage fallback load) and W3.1 registrations are async. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
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
  it('completes without throwing and emits exactly the one documented disabled diagnostic, and ZERO warnings', () => {
    const { error, warn } = spyConsole()
    const { ctx } = makeCtx({ sessions: {} }) // sessions present, presentation absent
    expect(() => apply(ctx as never)).not.toThrow()
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0]?.[0]).toBe('[dsh-workbench] disabled:')
    // The W2 host slash-command bridge (native-actions-pivot: removed by
    // product decision) used to be the one seam that could spuriously warn
    // in stock mode if its remote/remote.commands faces were absent/
    // malformed — that seam no longer exists, so this invariant is now
    // simply "apply() itself never warns outside the one documented case".
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
    // The only fail-soft warning this apply() call produces is the injected
    // Navigator seam failure — this file's single-warning invariant.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('navigator module failed to register')
    // Navigator itself never registered...
    expect(registered.some((r) => r.id === 'dsh-native-ux-navigator')).toBe(false)
    // ...but shortcuts and the guard-failure banner still went through.
    expect(registered).toContainEqual({ name: 'settings.section', id: 'shortcuts' })
    expect(registered).toContainEqual({ name: 'shell.overlay', id: 'dsh-workbench.guard-failure' })
  })
})

// ---------------------------------------------------------------------
// W3.1 — the public `ctx.workbenchActions` service, exposed end-to-end
// through the real apply() (not just the standalone actions-api.test.ts
// unit suite): reachability the documented cordis way, live registration
// reaching the SAME registry the Settings section renders from, and
// dispose-safety across a real plugin teardown sequence.
// ---------------------------------------------------------------------
describe('apply() — W3.1 workbench.actions service exposure', () => {
  function shortcutsRegistry(injected: Record<string, unknown>) {
    return (injected['shortcuts'] as { controller: { registry: { all(): Array<{ id: string; provider?: string }>; resolve: (chord: unknown) => unknown } } }).controller.registry
  }

  it('is reachable the documented way (ctx.reflect.provide) with protocol 1, and register() reaches the live shortcuts registry', async () => {
    spyConsole()
    const presentation = { state: { getSnapshot: () => ({ focused: 's1' }) }, close: vi.fn() }
    const { ctx, injected, provided } = makeCtx({ sessions: { presentation } })
    apply(ctx as never)
    await flush()

    const entry = provided.find((p) => p.name === 'workbenchActions')
    expect(entry).toBeDefined()
    const service = entry!.value as { protocol: number; register(def: unknown): () => void }
    expect(service.protocol).toBe(1)

    const run = vi.fn()
    const disposeAction = service.register({ id: 'myplugin.foo', label: () => 'My Foo', run })
    await flush()
    const registry = shortcutsRegistry(injected)
    expect(registry.all().map((a) => a.id)).toContain('myplugin.foo')

    disposeAction()
    await flush()
    expect(registry.all().map((a) => a.id)).not.toContain('myplugin.foo')
  })

  it('registration is validated fail-closed through the real service (reserved namespace rejected synchronously)', async () => {
    spyConsole()
    const { ctx, provided } = makeCtx({ sessions: {} })
    apply(ctx as never)
    await flush()
    const service = provided.find((p) => p.name === 'workbenchActions')!.value as { register(def: unknown): () => void }
    expect(() => service.register({ id: 'workbench.foo', label: () => 'x', run: () => {} })).toThrow(/reserved/)
    expect(() => service.register({ id: 'host.foo', label: () => 'x', run: () => {} })).toThrow(/reserved/)
  })

  it('GUARD: plugin teardown (ctx.effect binding disposer + ctx.on("dispose") handlers) disposes the service — a post-dispose register() throws cleanly, not a crash', async () => {
    spyConsole()
    const presentation = { state: { getSnapshot: () => ({ focused: 's1' }) }, close: vi.fn() }
    const { ctx, provided, effects } = makeCtx({ sessions: { presentation } })
    apply(ctx as never)
    await flush()
    const service = provided.find((p) => p.name === 'workbenchActions')!.value as { register(def: unknown): () => void }

    // Drive the real teardown sequence a cordis fiber unload would run:
    // the ctx.effect binding's own disposer (unregisters ctx.workbenchActions
    // itself — this fixture's effect() runs eagerly but never tears down on
    // its own) plus every ctx.on('dispose', ...) handler applyShortcuts (and
    // applyNavigator) registered (this fixture's ctx.on is a bare vi.fn()
    // that never invokes anything on its own either).
    const bindingEffect = effects.find((e) => e.label === 'dsh-workbench: actions api service')
    expect(bindingEffect).toBeDefined()
    ;(bindingEffect!.dispose as () => void)()
    const disposeHandlers = (ctx.on as ReturnType<typeof vi.fn>).mock.calls
      .filter(([event]) => event === 'dispose')
      .map(([, fn]) => fn as () => void)
    expect(disposeHandlers.length).toBeGreaterThan(0)
    for (const fn of disposeHandlers) fn()

    expect(() => service.register({ id: 'p.foo', label: () => 'x', run: () => {} })).toThrow(/disposed/)
  })

  it('a third-party action with isEnabled() === false resolves to null on its bound chord (real registry, W1.1 fail-closed dispatch)', async () => {
    spyConsole()
    const presentation = { state: { getSnapshot: () => ({ focused: 's1' }) }, close: vi.fn() }
    const { ctx, injected, provided } = makeCtx({ sessions: { presentation } })
    apply(ctx as never)
    await flush()
    const service = provided.find((p) => p.name === 'workbenchActions')!.value as { register(def: unknown): () => void }
    const run = vi.fn()
    service.register({ id: 'myplugin.foo', label: () => 'My Foo', run, isEnabled: () => false })
    await flush()
    const registry = shortcutsRegistry(injected) as unknown as {
      all(): Array<{ id: string }>
      rebind(id: string, chord: string): { ok: boolean }
      resolve(chord: ReturnType<typeof parseChord>): { id: string; run: () => void } | null
    }
    expect(registry.all().map((a) => a.id)).toContain('myplugin.foo')
    // Bind a chord directly through the registry's own public rebind() — the
    // W3 def declares no default chord (design.md anti-goal), so this
    // stands in for a user having bound one through Settings.
    expect(registry.rebind('myplugin.foo', 'Primary+Shift+K').ok).toBe(true)
    const chord = parseChord('Primary+Shift+K')!
    const resolved = registry.resolve(chord)
    expect(resolved).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })
})
