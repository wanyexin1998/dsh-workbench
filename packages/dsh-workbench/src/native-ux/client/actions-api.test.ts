// W3.1 — public workbench.actions registration API tests. Mutation-mindset:
// each behavior below is deletable, and a corresponding assertion fails if
// it is.
import { describe, expect, it, vi } from 'vitest'
import { ActionRegistry } from '../core/action-registry.js'
import { parseChord } from '../core/chord.js'
import { UNBOUND_SENTINEL } from '../core/shortcut-settings.js'
import { createThirdPartyActionsHandle, validateActionDef, type WorkbenchActionDef } from './actions-api.js'

const noop = () => {}

function def(overrides: Partial<WorkbenchActionDef> & { id: string }): WorkbenchActionDef {
  return { label: () => 'Label', run: noop, ...overrides }
}

describe('validateActionDef — fail-closed rejection paths', () => {
  it('accepts a well-formed def and defaults provider to the id\'s first segment', () => {
    const validated = validateActionDef(def({ id: 'myplugin.foo' }))
    expect(validated).toMatchObject({ id: 'myplugin.foo', provider: 'myplugin' })
  })

  it('accepts an explicit provider that matches the id\'s own first segment', () => {
    const validated = validateActionDef(def({ id: 'myplugin.foo', provider: 'myplugin' }))
    expect(validated.provider).toBe('myplugin')
  })

  it('provider defaults to only the FIRST dot segment, even when the id has multiple dots', () => {
    const validated = validateActionDef(def({ id: 'myplugin.sub.foo' }))
    expect(validated.provider).toBe('myplugin')
  })

  it('rejects an id with no dot at all', () => {
    expect(() => validateActionDef(def({ id: 'noDot' }))).toThrow(/namespaced/)
  })

  it('rejects an id with a leading dot (empty provider segment)', () => {
    expect(() => validateActionDef(def({ id: '.foo' }))).toThrow(/namespaced/)
  })

  it('rejects an id with a trailing dot (empty suffix)', () => {
    expect(() => validateActionDef(def({ id: 'myplugin.' }))).toThrow(/namespaced/)
  })

  it('rejects a non-string / empty-string id', () => {
    expect(() => validateActionDef(def({ id: '' }))).toThrow(/non-empty string/)
    expect(() => validateActionDef({ ...def({ id: 'x.y' }), id: 42 as unknown as string })).toThrow(/non-empty string/)
  })

  it('rejects the reserved "workbench." namespace', () => {
    expect(() => validateActionDef(def({ id: 'workbench.foo' }))).toThrow(/reserved/)
  })

  it('rejects the reserved "host." namespace', () => {
    expect(() => validateActionDef(def({ id: 'host.foo' }))).toThrow(/reserved/)
  })

  it('an id that merely STARTS WITH the reserved word but is a distinct namespace is accepted (exact-prefix check, not substring)', () => {
    expect(() => validateActionDef(def({ id: 'hostess.foo' }))).not.toThrow()
    expect(() => validateActionDef(def({ id: 'workbenchery.foo' }))).not.toThrow()
  })
})

// ---------------------------------------------------------------------
// SF3 — reserved-namespace check was case/whitespace/charset-blind: a
// provider segment merely differing from "workbench"/"host" by case,
// leading whitespace, or script slipped past the reserved check and then
// rendered as its own, seemingly legitimate, fully editable Settings group
// with confusable-looking text (UI impersonation). Constrain the provider
// segment's charset AND compare reserved names case-insensitively.
// ---------------------------------------------------------------------
describe('SF3 — case/whitespace/charset-blind reserved-namespace impersonation', () => {
  it('MUTATION: rejects a provider that case-insensitively equals the reserved "workbench" namespace', () => {
    expect(() => validateActionDef(def({ id: 'Workbench.foo' }))).toThrow(/reserved/)
    expect(() => validateActionDef(def({ id: 'WORKBENCH.foo' }))).toThrow(/reserved/)
  })

  it('MUTATION: rejects a provider that case-insensitively equals the reserved "host" namespace', () => {
    expect(() => validateActionDef(def({ id: 'HOST.foo' }))).toThrow(/reserved/)
    expect(() => validateActionDef(def({ id: 'Host.foo' }))).toThrow(/reserved/)
  })

  it('MUTATION: rejects a provider segment with leading whitespace, even though it is not an exact reserved-string match', () => {
    expect(() => validateActionDef(def({ id: ' workbench.foo' }))).toThrow()
  })

  it('MUTATION: rejects a provider segment containing non-ASCII / non-charset characters', () => {
    expect(() => validateActionDef(def({ id: '插件.动作' }))).toThrow()
  })

  it('MUTATION: rejects an id with adjacent/duplicate dots', () => {
    expect(() => validateActionDef(def({ id: 'a..b' }))).toThrow(/namespaced/)
  })

  it('rejects a trailing dot that is not the first dot in the id', () => {
    expect(() => validateActionDef(def({ id: 'foo.bar.' }))).toThrow(/namespaced/)
  })

  it('accepts a hyphenated provider segment (charset allows letters, digits, hyphens)', () => {
    expect(() => validateActionDef(def({ id: 'my-plugin.foo' }))).not.toThrow()
  })

  it('NEGATIVE CONTROL: the exact-namespace acceptance cases above still pass under the new charset/case-insensitive check', () => {
    expect(() => validateActionDef(def({ id: 'hostess.foo' }))).not.toThrow()
    expect(() => validateActionDef(def({ id: 'workbenchery.foo' }))).not.toThrow()
  })
})

describe('validateActionDef — remaining field validation', () => {
  it('rejects a non-function label', () => {
    expect(() => validateActionDef({ ...def({ id: 'p.foo' }), label: 'not a function' as unknown as () => string })).toThrow(/label/)
  })

  it('rejects a non-function run', () => {
    expect(() => validateActionDef({ ...def({ id: 'p.foo' }), run: 'nope' as unknown as () => void })).toThrow(/run/)
  })

  it('rejects a non-function isEnabled when present', () => {
    expect(() => validateActionDef({ ...def({ id: 'p.foo' }), isEnabled: true as unknown as () => boolean })).toThrow(/isEnabled/)
  })

  it('accepts an absent isEnabled (optional field)', () => {
    expect(() => validateActionDef(def({ id: 'p.foo' }))).not.toThrow()
  })

  it('rejects a provider that does not match the id\'s own namespace', () => {
    expect(() => validateActionDef(def({ id: 'myplugin.foo', provider: 'otherplugin' }))).toThrow(/does not match/)
  })

  // Finding 1 (smoke test) — allowWhileTyping: boolean when present,
  // snapshotted like every other field (read once, into the returned
  // ValidatedActionDef).
  it('rejects a non-boolean allowWhileTyping when present', () => {
    expect(() => validateActionDef({ ...def({ id: 'p.foo' }), allowWhileTyping: 'yes' as unknown as boolean })).toThrow(/allowWhileTyping/)
  })

  it('accepts an absent allowWhileTyping (defaults to undefined/false downstream)', () => {
    const validated = validateActionDef(def({ id: 'p.foo' }))
    expect(validated.allowWhileTyping).toBeUndefined()
  })

  it('accepts and snapshots an explicit allowWhileTyping: true', () => {
    const validated = validateActionDef(def({ id: 'p.foo', allowWhileTyping: true }))
    expect(validated.allowWhileTyping).toBe(true)
  })
})

describe('createThirdPartyActionsHandle — registerInto (registry build consults the store)', () => {
  it('register() before any registerInto call only stores; a later registerInto picks it up (cold start)', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.foo' }))
    const registry = new ActionRegistry()
    handle.registerInto(registry, { overrides: {}, disabled: new Set() })
    expect(registry.all().map((a) => a.id)).toEqual(['p.foo'])
  })

  it('a registered action never has a default chord (design.md anti-goal)', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.foo' }))
    const registry = new ActionRegistry()
    handle.registerInto(registry, { overrides: {}, disabled: new Set() })
    expect(registry.all()[0]?.defaultChord).toBeNull()
  })

  it('carries the resolved provider onto the ActionDef', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'myplugin.foo' }))
    const registry = new ActionRegistry()
    handle.registerInto(registry, { overrides: {}, disabled: new Set() })
    expect(registry.all()[0]?.provider).toBe('myplugin')
  })

  // Finding 1 (smoke test): allowWhileTyping must survive the raw
  // WorkbenchActionDef -> ValidatedActionDef -> ActionDef pipeline — this is
  // what the dispatcher (shortcuts.tsx) actually reads at keydown time.
  it('carries allowWhileTyping: true onto the built ActionDef', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.foo', allowWhileTyping: true }))
    const registry = new ActionRegistry()
    handle.registerInto(registry, { overrides: {}, disabled: new Set() })
    expect(registry.all()[0]?.allowWhileTyping).toBe(true)
  })

  it('an absent allowWhileTyping carries through as undefined (no implicit true)', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.foo' }))
    const registry = new ActionRegistry()
    handle.registerInto(registry, { overrides: {}, disabled: new Set() })
    expect(registry.all()[0]?.allowWhileTyping).toBeUndefined()
  })

  it('MUTATION: registration survives a reload rebuild — a brand-new registry instance gets it registered fresh, not skipped', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.foo' }))
    const first = new ActionRegistry()
    handle.registerInto(first, { overrides: {}, disabled: new Set() })
    expect(first.all().map((a) => a.id)).toEqual(['p.foo'])

    // Simulates shortcuts.tsx's reload(): buildShortcutRegistry() always
    // constructs a brand-new ActionRegistry.
    const second = new ActionRegistry()
    handle.registerInto(second, { overrides: {}, disabled: new Set() })
    expect(second.all().map((a) => a.id)).toEqual(['p.foo'])
  })

  it('registerInto called again with the SAME registry instance is a no-op re-sync (no duplicate-id crash)', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.foo' }))
    const registry = new ActionRegistry()
    expect(() => {
      handle.registerInto(registry, { overrides: {}, disabled: new Set() })
      handle.registerInto(registry, { overrides: {}, disabled: new Set() })
    }).not.toThrow()
    expect(registry.all().map((a) => a.id)).toEqual(['p.foo'])
  })

  it('threads `overrides` into the chord binding', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.foo' }))
    const registry = new ActionRegistry()
    handle.registerInto(registry, { overrides: { 'p.foo': 'Primary+Shift+K' }, disabled: new Set() })
    expect(registry.resolve(parseChord('Primary+Shift+K')!)?.id).toBe('p.foo')
  })

  it('an explicit UNBOUND_SENTINEL override unbinds (never falls back to a default chord, since there is none)', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.foo' }))
    const registry = new ActionRegistry()
    handle.registerInto(registry, { overrides: { 'p.foo': UNBOUND_SENTINEL }, disabled: new Set() })
    expect(registry.bindingChord('p.foo')).toBeNull()
  })

  it('threads `disabled` — a disabled action holds no chord even with a bound override', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.foo' }))
    const registry = new ActionRegistry()
    handle.registerInto(registry, { overrides: { 'p.foo': 'Primary+Shift+K' }, disabled: new Set(['p.foo']) })
    expect(registry.bindingChord('p.foo')).toBeNull()
  })

  it('label() is evaluated fresh on every registerInto call, not memoized once', () => {
    const handle = createThirdPartyActionsHandle()
    let calls = 0
    handle.service.register(def({ id: 'p.foo', label: () => 'Label ' + (++calls) }))
    const first = new ActionRegistry()
    handle.registerInto(first, { overrides: {}, disabled: new Set() })
    expect(first.all()[0]?.label).toBe('Label 1')
    const second = new ActionRegistry()
    handle.registerInto(second, { overrides: {}, disabled: new Set() })
    expect(second.all()[0]?.label).toBe('Label 2')
  })

  it('isEnabled threads through: a false isEnabled resolves the bound chord to null (W1.1 fail-closed dispatch)', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.foo', isEnabled: () => false }))
    const registry = new ActionRegistry()
    handle.registerInto(registry, { overrides: { 'p.foo': 'Primary+Shift+K' }, disabled: new Set() })
    expect(registry.resolve(parseChord('Primary+Shift+K')!)).toBeNull()
  })

  it('registerInto after handle.dispose() is a no-op (does not throw, registers nothing)', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.foo' }))
    handle.dispose()
    const registry = new ActionRegistry()
    expect(() => handle.registerInto(registry, { overrides: {}, disabled: new Set() })).not.toThrow()
    expect(registry.all()).toEqual([])
  })
})

describe('createThirdPartyActionsHandle — duplicate / re-register / dispose semantics', () => {
  it('duplicate live id throws and leaves the original registration intact', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.foo' }))
    expect(() => handle.service.register(def({ id: 'p.foo' }))).toThrow(/already has a live registration/)
    expect(handle.liveProviders()).toEqual(new Set(['p']))
  })

  it('re-registering the same id after disposing the first registration succeeds', () => {
    const handle = createThirdPartyActionsHandle()
    const dispose = handle.service.register(def({ id: 'p.foo' }))
    dispose()
    expect(() => handle.service.register(def({ id: 'p.foo' }))).not.toThrow()
  })

  it('MUTATION: dispose() removes the action from a live registry, freeing its chord — not merely from the store', () => {
    const handle = createThirdPartyActionsHandle()
    const dispose = handle.service.register(def({ id: 'p.foo' }))
    const registry = new ActionRegistry()
    handle.registerInto(registry, { overrides: { 'p.foo': 'Primary+Shift+K' }, disabled: new Set() })
    expect(registry.resolve(parseChord('Primary+Shift+K')!)?.id).toBe('p.foo')

    dispose()

    expect(registry.resolve(parseChord('Primary+Shift+K')!)).toBeNull()
    expect(registry.all()).toEqual([])
    // If dispose() only cleared the internal store but never called the
    // registry's own disposer, re-registering a DIFFERENT action on the same
    // chord would spuriously report a conflict against a ghost owner.
    const result = registry.register({ id: 'other.action', label: 'x', defaultChord: 'Primary+Shift+K', run: noop })
    expect(result.conflictWith).toBeUndefined()
  })

  it('dispose() also removes the def from the store — a rebuild afterwards does not resurrect it', () => {
    const handle = createThirdPartyActionsHandle()
    const dispose = handle.service.register(def({ id: 'p.foo' }))
    const first = new ActionRegistry()
    handle.registerInto(first, { overrides: {}, disabled: new Set() })
    dispose()
    const second = new ActionRegistry() // simulates a later settings-reload rebuild
    handle.registerInto(second, { overrides: {}, disabled: new Set() })
    expect(second.all()).toEqual([])
  })

  it('the returned disposer is idempotent', () => {
    const handle = createThirdPartyActionsHandle()
    const dispose = handle.service.register(def({ id: 'p.foo' }))
    const registry = new ActionRegistry()
    handle.registerInto(registry, { overrides: {}, disabled: new Set() })
    expect(() => { dispose(); dispose() }).not.toThrow()
    expect(registry.all()).toEqual([])
  })

  it('liveProviders() reflects only currently-registered providers, distinct and empty once all dispose', () => {
    const handle = createThirdPartyActionsHandle()
    const disposeA = handle.service.register(def({ id: 'alpha.one' }))
    handle.service.register(def({ id: 'alpha.two' }))
    handle.service.register(def({ id: 'beta.one' }))
    expect(handle.liveProviders()).toEqual(new Set(['alpha', 'beta']))
    disposeA()
    expect(handle.liveProviders()).toEqual(new Set(['alpha', 'beta'])) // alpha.two still live
  })

  it('handle.dispose() clears every live provider', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'alpha.one' }))
    handle.dispose()
    expect(handle.liveProviders()).toEqual(new Set())
  })
})

describe('createThirdPartyActionsHandle — service-level guards and onChange', () => {
  it('service.protocol is 1', () => {
    expect(createThirdPartyActionsHandle().service.protocol).toBe(1)
  })

  it('GUARD: a post-dispose register() attempt fails cleanly with a clear error, not a crash', () => {
    const handle = createThirdPartyActionsHandle()
    handle.dispose()
    expect(() => handle.service.register(def({ id: 'p.foo' }))).toThrow(/disposed/)
  })

  it('handle.dispose() is idempotent', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.foo' }))
    expect(() => { handle.dispose(); handle.dispose() }).not.toThrow()
  })

  it('onChange fires on register() and on the returned disposer', () => {
    const handle = createThirdPartyActionsHandle()
    const onChange = vi.fn()
    handle.onChange(onChange)
    const dispose = handle.service.register(def({ id: 'p.foo' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    dispose()
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('the onChange unsubscribe function stops delivery', () => {
    const handle = createThirdPartyActionsHandle()
    const onChange = vi.fn()
    const off = handle.onChange(onChange)
    off()
    handle.service.register(def({ id: 'p.foo' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('hasLiveProvider() is a live O(1)-shaped membership check (no reliance on liveProviders() Set allocation)', () => {
    const handle = createThirdPartyActionsHandle()
    expect(handle.hasLiveProvider('p')).toBe(false)
    const dispose = handle.service.register(def({ id: 'p.foo' }))
    expect(handle.hasLiveProvider('p')).toBe(true)
    dispose()
    expect(handle.hasLiveProvider('p')).toBe(false)
  })

  it('hasLiveProvider() stays true while a SECOND action under the same provider remains registered', () => {
    const handle = createThirdPartyActionsHandle()
    const disposeOne = handle.service.register(def({ id: 'p.one' }))
    handle.service.register(def({ id: 'p.two' }))
    disposeOne()
    expect(handle.hasLiveProvider('p')).toBe(true)
  })
})

// ---------------------------------------------------------------------
// BLOCKING 1 — a throwing (or non-string-returning) third-party label()
// must never propagate out of toActionDef/registerInto: shortcuts.tsx's
// reload() calls buildShortcutRegistry AFTER already detaching the live
// keydown listener and only reattaches once it returns, so an unguarded
// throw here would strand the ENTIRE dispatcher (every provider, not just
// the offending plugin) permanently detached. Falls back to rendering the
// action's own `id`, exactly like an unrecognized dictionary key already
// falls back to its raw key elsewhere in this package.
// ---------------------------------------------------------------------
describe('BLOCKING 1 — toActionDef guards a throwing/non-string label()', () => {
  it('MUTATION: a throwing label() does not propagate out of registerInto; the action renders under its raw id', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.throws', label: () => { throw new Error('boom') }, run: noop }))
    const registry = new ActionRegistry()
    expect(() => handle.registerInto(registry, { overrides: {}, disabled: new Set() })).not.toThrow()
    expect(registry.all().find((a) => a.id === 'p.throws')?.label).toBe('p.throws')
  })

  it('a non-string label() return value falls back to the raw id instead of poisoning the registry', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.badReturn', label: () => 42 as unknown as string, run: noop }))
    const registry = new ActionRegistry()
    handle.registerInto(registry, { overrides: {}, disabled: new Set() })
    expect(registry.all().find((a) => a.id === 'p.badReturn')?.label).toBe('p.badReturn')
  })

  it('MUTATION: a throwing label survives across a reload rebuild too, not just the first build', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.throws', label: () => { throw new Error('boom') }, run: noop }))
    const first = new ActionRegistry()
    handle.registerInto(first, { overrides: {}, disabled: new Set() })
    const second = new ActionRegistry() // simulates shortcuts.tsx's reload() rebuild
    expect(() => handle.registerInto(second, { overrides: {}, disabled: new Set() })).not.toThrow()
    expect(second.all().find((a) => a.id === 'p.throws')?.label).toBe('p.throws')
  })

  it('a healthy action registered alongside a throwing one is completely unaffected', () => {
    const handle = createThirdPartyActionsHandle()
    handle.service.register(def({ id: 'p.throws', label: () => { throw new Error('boom') }, run: noop }))
    handle.service.register(def({ id: 'p.healthy', label: () => 'Healthy', run: noop }))
    const registry = new ActionRegistry()
    handle.registerInto(registry, { overrides: {}, disabled: new Set() })
    expect(registry.all().find((a) => a.id === 'p.healthy')?.label).toBe('Healthy')
  })
})

// ---------------------------------------------------------------------
// SF2 — an onChange listener that throws must not block delivery to any
// OTHER listener, and must not propagate back out of the register()/
// dispose() call that triggered the emit (register()'s own try/catch
// rollback is defense-in-depth for a future emit-path change; with
// per-listener isolation in place it is unreachable from an ordinary
// listener throw, which is exactly what the first test below pins).
// ---------------------------------------------------------------------
describe('SF2 — onChange listener isolation + register() rollback', () => {
  it('MUTATION: a throwing onChange listener does not block delivery to a later listener', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handle = createThirdPartyActionsHandle()
    const throwing = vi.fn(() => { throw new Error('listener boom') })
    const healthy = vi.fn()
    handle.onChange(throwing)
    handle.onChange(healthy)
    handle.service.register(def({ id: 'p.foo' }))
    expect(throwing).toHaveBeenCalledOnce()
    expect(healthy).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })

  it('register() still returns a fully working disposer when an onChange listener throws (the entry is not rolled back)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handle = createThirdPartyActionsHandle()
    handle.onChange(() => { throw new Error('listener boom') })
    const dispose = handle.service.register(def({ id: 'p.foo' }))
    expect(handle.hasLiveProvider('p')).toBe(true)
    const registry = new ActionRegistry()
    handle.registerInto(registry, { overrides: {}, disabled: new Set() })
    expect(registry.all().map((a) => a.id)).toEqual(['p.foo'])
    dispose()
    expect(handle.hasLiveProvider('p')).toBe(false)
    consoleError.mockRestore()
  })

  it('a throwing listener is reported via console.error, not swallowed silently', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handle = createThirdPartyActionsHandle()
    handle.onChange(() => { throw new Error('listener boom') })
    handle.service.register(def({ id: 'p.foo' }))
    expect(consoleError).toHaveBeenCalledOnce()
    expect(String(consoleError.mock.calls[0]?.[0])).toContain('onChange listener threw')
    consoleError.mockRestore()
  })
})
