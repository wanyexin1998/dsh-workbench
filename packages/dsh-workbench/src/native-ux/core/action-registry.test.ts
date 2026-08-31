import { describe, expect, it } from 'vitest'
import { ActionRegistry, DEFAULT_PROVIDER, type ActionDef } from './action-registry.js'
import { parseChord } from './chord.js'

const noop = () => {}

describe('ActionRegistry', () => {
  it('registers with default chords and resolves events', () => {
    const registry = new ActionRegistry()
    const action: ActionDef = { id: 'a1', label: 'A1', defaultChord: 'Primary+Shift+O', run: noop }
    expect(registry.register(action).ok).toBe(true)
    expect(registry.resolve(parseChord('Primary+Shift+O')!)?.id).toBe('a1')
    expect(registry.resolve(parseChord('Primary+B')!)).toBeNull()
  })

  it('rejects duplicate action ids', () => {
    const registry = new ActionRegistry()
    registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop })
    expect(registry.register({ id: 'a1', label: 'A2', defaultChord: 'Primary+P', run: noop }).ok).toBe(false)
  })

  it('reports chord conflicts', () => {
    const registry = new ActionRegistry()
    registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop })
    const result = registry.register({ id: 'a2', label: 'B', defaultChord: 'Primary+O', run: noop })
    expect(result.ok).toBe(true)
    expect(result.conflictWith).toBe('a1')
    expect(registry.conflicts()).toEqual([{ chord: 'Primary+o', actionIds: ['a1', 'a2'] }])
  })

  it('overrides the default chord at registration', () => {
    const registry = new ActionRegistry()
    registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop }, 'Primary+Shift+P')
    expect(registry.resolve(parseChord('Primary+Shift+P')!)?.id).toBe('a1')
    expect(registry.resolve(parseChord('Primary+O')!)).toBeNull()
  })

  it('supports unbound actions (null default)', () => {
    const registry = new ActionRegistry()
    registry.register({ id: 'a1', label: 'A', defaultChord: null, run: noop })
    expect(registry.all().length).toBe(1)
    expect(registry.bindingChord('a1')).toBeNull()
  })

  describe('dispose (W1.1)', () => {
    it('removes the action and its binding, and resolves a former conflict back to the survivor', () => {
      const registry = new ActionRegistry()
      const r1 = registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop })
      const r2 = registry.register({ id: 'a2', label: 'B', defaultChord: 'Primary+O', run: noop })
      expect(r2.conflictWith).toBe('a1')
      expect(registry.resolve(parseChord('Primary+O')!)).toBeNull() // conflicted

      r1.dispose()

      expect(registry.all().map((a) => a.id)).toEqual(['a2'])
      expect(registry.conflicts()).toEqual([])
      // The 2-way conflict collapses back to a working single binding.
      expect(registry.resolve(parseChord('Primary+O')!)?.id).toBe('a2')
      expect(registry.bindingChord('a1')).toBeNull()
    })

    it('is a no-op the second time it is called', () => {
      const registry = new ActionRegistry()
      const r1 = registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop })
      r1.dispose()
      expect(() => r1.dispose()).not.toThrow()
      expect(registry.all().length).toBe(0)
    })

    it('allows re-registering the same id after disposal, and fails while the prior registration is live', () => {
      const registry = new ActionRegistry()
      const first = { id: 'a1', label: 'First', defaultChord: 'Primary+O', run: noop }
      const r1 = registry.register(first)
      expect(r1.ok).toBe(true)

      const second = { id: 'a1', label: 'Second', defaultChord: 'Primary+P', run: noop }
      expect(registry.register(second).ok).toBe(false) // still live

      r1.dispose()
      const r2 = registry.register(second)
      expect(r2.ok).toBe(true)
      expect(registry.all().map((a) => a.label)).toEqual(['Second'])
    })

    it('second dispose call after re-registration is a no-op (latch)', () => {
      // NOTE: this exercises the `disposed` latch short-circuiting the
      // second call, not the identity guard further down in dispose() —
      // that guard is unreachable through the public API (see the comment
      // on it in action-registry.ts). A stale disposer must still be a
      // harmless no-op against whatever is currently registered under the
      // same id, which is what this pins.
      const registry = new ActionRegistry()
      const first = { id: 'a1', label: 'First', defaultChord: 'Primary+O', run: noop }
      const r1 = registry.register(first)
      r1.dispose()
      const second = { id: 'a1', label: 'Second', defaultChord: 'Primary+P', run: noop }
      registry.register(second)

      r1.dispose() // stale disposer for the old registration: must not touch the new one

      expect(registry.all().map((a) => a.label)).toEqual(['Second'])
      expect(registry.resolve(parseChord('Primary+P')!)?.id).toBe('a1')
    })

    it('registering on a chord that a disposed action used to hold reports no conflict', () => {
      // Pins the load-bearing empty-binding cleanup in unbindInternal
      // (action-registry.ts:168): once a1's dispose() empties the chord's
      // owner list, the chord entry itself must be deleted, not left behind
      // as a stale empty list — otherwise the next registration on that
      // chord would spuriously self-conflict.
      const registry = new ActionRegistry()
      const r1 = registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop })
      r1.dispose()
      const r2 = registry.register({ id: 'a2', label: 'B', defaultChord: 'Primary+O', run: noop })
      expect(r2.conflictWith).toBeUndefined()
      expect(registry.resolve(parseChord('Primary+O')!)?.id).toBe('a2')
    })
  })

  describe('rebind (W1.1)', () => {
    it('fails for an unknown action id', () => {
      const registry = new ActionRegistry()
      expect(registry.rebind('missing', 'Primary+O')).toEqual({ ok: false })
    })

    it('moves a bound action to a new, free chord', () => {
      const registry = new ActionRegistry()
      registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop })
      const result = registry.rebind('a1', 'Primary+Shift+P')
      expect(result).toEqual({ ok: true })
      expect(registry.resolve(parseChord('Primary+O')!)).toBeNull()
      expect(registry.resolve(parseChord('Primary+Shift+P')!)?.id).toBe('a1')
    })

    it('unbinds when passed null or empty string', () => {
      const registry = new ActionRegistry()
      registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop })
      expect(registry.rebind('a1', null)).toEqual({ ok: true })
      expect(registry.bindingChord('a1')).toBeNull()

      registry.rebind('a1', 'Primary+O')
      expect(registry.rebind('a1', '')).toEqual({ ok: true })
      expect(registry.bindingChord('a1')).toBeNull()
    })

    it('rebinding into an occupied chord reports the conflict', () => {
      const registry = new ActionRegistry()
      registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop })
      registry.register({ id: 'a2', label: 'B', defaultChord: 'Primary+P', run: noop })
      const result = registry.rebind('a2', 'Primary+O')
      expect(result).toEqual({ ok: true, conflictWith: 'a1' })
      expect(registry.resolve(parseChord('Primary+O')!)).toBeNull()
      expect(registry.conflicts()).toEqual([{ chord: 'Primary+o', actionIds: ['a1', 'a2'] }])
    })

    it('rebinding out of a conflict collapses it back to the survivor', () => {
      const registry = new ActionRegistry()
      registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop })
      registry.register({ id: 'a2', label: 'B', defaultChord: 'Primary+O', run: noop })
      expect(registry.conflicts().length).toBe(1)

      const result = registry.rebind('a1', 'Primary+Shift+P')
      expect(result).toEqual({ ok: true })
      expect(registry.conflicts()).toEqual([])
      expect(registry.resolve(parseChord('Primary+O')!)?.id).toBe('a2')
      expect(registry.resolve(parseChord('Primary+Shift+P')!)?.id).toBe('a1')
    })

    it('an unparsable spec leaves the action unbound', () => {
      const registry = new ActionRegistry()
      registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop })
      const result = registry.rebind('a1', 'not a valid chord')
      expect(result).toEqual({ ok: true })
      expect(registry.bindingChord('a1')).toBeNull()
    })

    it('rebinding into the same chord it already (conflictingly) held moves it to the end of the owner list', () => {
      // Pins the owner-list order behavior that W1.2's conflict badges will
      // render from: [a1, a2] conflicted on Primary+O, then rebinding a1
      // back onto the same chord detaches-then-reattaches it, so it lands
      // after a2 — order becomes [a2, a1], and conflictWith flips to name
      // a2 (now first) instead of a1.
      const registry = new ActionRegistry()
      registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop })
      const r2 = registry.register({ id: 'a2', label: 'B', defaultChord: 'Primary+O', run: noop })
      expect(r2.conflictWith).toBe('a1')
      expect(registry.conflicts()).toEqual([{ chord: 'Primary+o', actionIds: ['a1', 'a2'] }])

      const result = registry.rebind('a1', 'Primary+O')
      expect(result).toEqual({ ok: true, conflictWith: 'a2' })
      expect(registry.conflicts()).toEqual([{ chord: 'Primary+o', actionIds: ['a2', 'a1'] }])
    })
  })

  describe('byProvider (W1.1)', () => {
    it('groups actions by provider, insertion-ordered, defaulting to DEFAULT_PROVIDER', () => {
      const registry = new ActionRegistry()
      registry.register({ id: 'a1', label: 'A', defaultChord: null, run: noop })
      registry.register({ id: 'h1', label: 'H1', defaultChord: null, run: noop, provider: 'host' })
      registry.register({ id: 'a2', label: 'A2', defaultChord: null, run: noop })
      registry.register({ id: 'h2', label: 'H2', defaultChord: null, run: noop, provider: 'host' })

      const grouped = registry.byProvider()
      expect([...grouped.keys()]).toEqual([DEFAULT_PROVIDER, 'host'])
      expect(grouped.get(DEFAULT_PROVIDER)?.map((a) => a.id)).toEqual(['a1', 'a2'])
      expect(grouped.get('host')?.map((a) => a.id)).toEqual(['h1', 'h2'])
    })
  })

  describe('resolve + isEnabled (W1.1)', () => {
    it('returns null when isEnabled() reports false', () => {
      const registry = new ActionRegistry()
      registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop, isEnabled: () => false })
      expect(registry.resolve(parseChord('Primary+O')!)).toBeNull()
    })

    it('returns the action when isEnabled() reports true', () => {
      const registry = new ActionRegistry()
      registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop, isEnabled: () => true })
      expect(registry.resolve(parseChord('Primary+O')!)?.id).toBe('a1')
    })

    it('treats a throwing isEnabled as disabled (fail closed), without affecting later resolves', () => {
      const registry = new ActionRegistry()
      registry.register({
        id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop,
        isEnabled: () => { throw new Error('boom') },
      })
      expect(registry.resolve(parseChord('Primary+O')!)).toBeNull()
      // A throwing isEnabled must not corrupt registry state or leak into a
      // later resolve() call for a different, healthy action.
      registry.register({ id: 'a2', label: 'B', defaultChord: 'Primary+P', run: noop, isEnabled: () => true })
      expect(registry.resolve(parseChord('Primary+P')!)?.id).toBe('a2')
    })
  })
})
