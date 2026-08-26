// @vitest-environment jsdom
// GA-003/022 - persistence adapter tests.
//
// The regression these guard (found by the #35 cross-reload E2E): the rc's
// scope.set() RESOLVES even when the host rejects the write with
// settings-not-exposed, and a bound snapshot is a plain object even when the
// namespace is not durable for this client ({status:'unavailable'} for a
// non-exposed third-party namespace, {mode:'memory'} for a remote browser).
// Treating "set() settled" / "snapshot is an object" as durable silently wiped
// the localStorage fallback and lost the chord on reload. So the host layer is
// gated on the snapshot's own status/mode, and the tests below exercise those
// shapes directly rather than a raw section.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_SHORTCUT_STATE,
  FallbackShortcutPersistence,
  HostShortcutPersistence,
  LocalShortcutPersistence,
  LOCAL_STORAGE_KEY,
  parsePersistedState,
  type ShortcutPersistedStateV1,
} from './shortcut-persistence.js'

beforeEach(() => {
  localStorage.clear()
})

const HOST_STATE_FIELD = '__state'

type Snapshot = {
  status: 'loading' | 'ready' | 'unavailable'
  mode: 'host' | 'memory'
  revision?: number
  base?: unknown
  user?: Record<string, unknown> | undefined
  value?: Record<string, unknown> | undefined
}

/** Wrap a stored envelope as the rc exposes it on a durable, ready snapshot. */
function readySnapshot(state: ShortcutPersistedStateV1 | null): Snapshot {
  const user = state === null ? undefined : { [HOST_STATE_FIELD]: JSON.stringify(state) }
  return { status: 'ready', mode: 'host', revision: 1, base: {}, user, value: user }
}

/** A bound scope whose snapshot starts `loading` and settles to `target`
 * (via subscribe) once observed — mirrors the rc's background read. */
function settlingScope(target: Snapshot) {
  const snapshot: Snapshot = { status: 'loading', mode: target.mode, user: undefined, value: undefined }
  const listeners = new Set<() => void>()
  const subscribe = (fn: () => void) => {
    listeners.add(fn)
    // The rc's listener exists before the initial read, so settle now.
    Object.assign(snapshot, target)
    for (const l of listeners) l()
    return () => {
      listeners.delete(fn)
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe,
    set: vi.fn((field: string, value: unknown) => {
      ;(snapshot.user ??= {})[field] = value
      return Promise.resolve()
    }),
    unset: vi.fn(() => Promise.resolve()),
  }
}

/** A bound scope with a fixed snapshot and a set() that RESOLVES (the rc
 * never rejects set(), even for settings-not-exposed). */
function fixedScope(snapshot: Snapshot, setImpl?: (field: string, value: unknown) => Promise<void>) {
  return {
    getSnapshot: () => snapshot,
    set: vi.fn(setImpl ?? (() => Promise.resolve())),
    unset: vi.fn(() => Promise.resolve()),
  }
}

function makeFallback(host: HostShortcutPersistence | null) {
  return new FallbackShortcutPersistence(host, new LocalShortcutPersistence())
}

describe('parsePersistedState', () => {
  it('returns empty state on malformed input', () => {
    expect(parsePersistedState(null)).toEqual(EMPTY_SHORTCUT_STATE)
    expect(parsePersistedState('junk')).toEqual(EMPTY_SHORTCUT_STATE)
    expect(parsePersistedState({ schemaVersion: 2 })).toEqual(EMPTY_SHORTCUT_STATE)
  })

  it('drops invalid chord specs and non-string disabled ids', () => {
    const state = parsePersistedState({
      schemaVersion: 1,
      bindings: { 'conversation.navigator.toggle': 'Primary+Shift+O', bad: 'not-a-chord' },
      disabled: ['session.stop', 42, null],
    })
    expect(state.bindings).toEqual({ 'conversation.navigator.toggle': 'Primary+Shift+O' })
    expect(state.disabled).toEqual(['session.stop'])
  })

  it('keeps the explicit unbound sentinel', () => {
    const state = parsePersistedState({ schemaVersion: 1, bindings: { 'session.stop': 'Unbound' } })
    expect(state.bindings['session.stop']).toBe('Unbound')
  })
})

describe('HostShortcutPersistence', () => {
  it('loads the versioned envelope from a durable, ready snapshot', async () => {
    const scope = fixedScope(
      readySnapshot({ schemaVersion: 1, bindings: { 'session.stop': 'Primary+X' }, disabled: ['layout.sidebar.toggle'] }),
    )
    const state = await new HostShortcutPersistence(scope).load()
    expect(state.bindings['session.stop']).toBe('Primary+X')
    expect(state.disabled).toEqual(['layout.sidebar.toggle'])
  })

  it('returns empty (not throw) when the host is durable but holds no state yet', async () => {
    const scope = fixedScope(readySnapshot(null))
    const state = await new HostShortcutPersistence(scope).load()
    expect(state).toEqual(EMPTY_SHORTCUT_STATE)
  })

  it('rejects when the namespace is not exposed (settings-not-exposed)', async () => {
    const scope = fixedScope({ status: 'unavailable', mode: 'host', user: undefined, value: undefined })
    await expect(new HostShortcutPersistence(scope).load()).rejects.toThrow('settings-not-exposed')
  })

  it('rejects in memory mode (remote browser, process-local preferences)', async () => {
    const scope = fixedScope({ status: 'ready', mode: 'memory', user: {}, value: {} })
    await expect(new HostShortcutPersistence(scope).load()).rejects.toThrow('settings-not-exposed')
  })

  it('waits for the snapshot to settle out of loading before deciding', async () => {
    // Settles to unavailable (not exposed) via subscribe -> must reject, and
    // the decision must come from the settled status, not the transient one.
    const scope = settlingScope({ status: 'unavailable', mode: 'host', user: undefined, value: undefined })
    await expect(new HostShortcutPersistence(scope).load()).rejects.toThrow('settings-not-exposed')
  })

  it('saves the envelope to the single __state field on a durable host', async () => {
    const scope = fixedScope(readySnapshot(null))
    await new HostShortcutPersistence(scope).save({ schemaVersion: 1, bindings: { 'session.stop': 'Primary+K' }, disabled: [] })
    expect(scope.set).toHaveBeenCalledTimes(1)
    const [field, raw] = scope.set.mock.calls[0] as [string, unknown]
    expect(field).toBe(HOST_STATE_FIELD)
    expect(JSON.parse(String(raw)).bindings['session.stop']).toBe('Primary+K')
  })

  it('does NOT write to the host when the namespace is not durable', async () => {
    const scope = fixedScope({ status: 'unavailable', mode: 'host', user: undefined, value: undefined })
    const set = scope.set as ReturnType<typeof vi.fn>
    await expect(
      new HostShortcutPersistence(scope).save({ schemaVersion: 1, bindings: { 'session.stop': 'Primary+K' }, disabled: [] }),
    ).rejects.toThrow('settings-not-exposed')
    expect(set).not.toHaveBeenCalled()
  })
})

describe('FallbackShortcutPersistence', () => {
  it('imports a legacy local state when the durable Host section is empty', async () => {
    const legacy: ShortcutPersistedStateV1 = {
      schemaVersion: 1,
      bindings: { 'pane.close-focused': 'Primary+Shift+W' },
      disabled: ['layout.sidebar.toggle'],
    }
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(legacy))
    const scope = fixedScope(readySnapshot(null))

    await expect(makeFallback(new HostShortcutPersistence(scope)).load()).resolves.toEqual(legacy)
    expect(scope.set).toHaveBeenCalledWith('__state', JSON.stringify(legacy))
    expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY)!)).toEqual(EMPTY_SHORTCUT_STATE)
  })

  it('falls back to local when the host namespace is not exposed', async () => {
    localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, bindings: { 'conversation.navigator.toggle': 'Primary+Shift+P' }, disabled: [] }),
    )
    const fallback = makeFallback(new HostShortcutPersistence(fixedScope({ status: 'unavailable', mode: 'host', user: undefined, value: undefined })))
    const state = await fallback.load()
    expect(state.bindings['conversation.navigator.toggle']).toBe('Primary+Shift+P')
  })

  it('CRITICAL: set() resolves but host is not durable -> local is preserved, not wiped', async () => {
    // This is the exact bug: the host rejects the write with settings-not-exposed,
    // yet the rc's set() resolves. The old code treated that as a host save and
    // cleared local data, losing the chord on reload.
    const scope = fixedScope({ status: 'unavailable', mode: 'host', user: {}, value: {} })
    const fallback = makeFallback(new HostShortcutPersistence(scope))
    const where = await fallback.save({ schemaVersion: 1, bindings: { 'session.stop': 'Primary+K' }, disabled: ['layout.sidebar.toggle'] })
    expect(where).toBe('local')
    // local must now hold the state (NOT the empty cleared state)
    const stored = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY)!) as ShortcutPersistedStateV1
    expect(stored.bindings['session.stop']).toBe('Primary+K')
    expect(stored.disabled).toEqual(['layout.sidebar.toggle'])
    // and a reload (fresh instance) must read it back from local
    const reloaded = await makeFallback(new HostShortcutPersistence(fixedScope({ status: 'unavailable', mode: 'host', user: {}, value: {} }))).load()
    expect(reloaded.bindings['session.stop']).toBe('Primary+K')
    expect(reloaded.disabled).toEqual(['layout.sidebar.toggle'])
  })

  it('prefers the durable host on success and clears stale local data (migration path)', async () => {
    localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, bindings: { 'layout.sidebar.toggle': 'Primary+J' }, disabled: [] }),
    )
    const scope = fixedScope(readySnapshot(null))
    const fallback = makeFallback(new HostShortcutPersistence(scope))
    const where = await fallback.save({ schemaVersion: 1, bindings: { 'session.stop': 'Primary+K' }, disabled: [] })
    expect(where).toBe('host')
    // host accepted the state -> stale local fallback is cleared
    expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY)!)).toEqual(EMPTY_SHORTCUT_STATE)
  })

  it('round-trips through a durable host snapshot (restart)', async () => {
    const saved: ShortcutPersistedStateV1 = { schemaVersion: 1, bindings: { 'conversation.composer.focus': 'Primary+Shift+F' }, disabled: ['agent.favorite.open:1'] }
    const hostFor = () => new HostShortcutPersistence(fixedScope(readySnapshot(saved)))
    const first = makeFallback(hostFor())
    await first.save(saved)
    // "restart": a fresh fallback reading the same durable host state
    const restarted = makeFallback(hostFor())
    const state = await restarted.load()
    expect(state.bindings['conversation.composer.focus']).toBe('Primary+Shift+F')
    expect(state.disabled).toEqual(['agent.favorite.open:1'])
  })

  it('local fallback round-trips after restart when the host is never durable', async () => {
    const hostFor = () => new HostShortcutPersistence(fixedScope({ status: 'unavailable', mode: 'host', user: {}, value: {} }))
    const first = makeFallback(hostFor())
    await first.save({ schemaVersion: 1, bindings: { 'conversation.composer.focus': 'Primary+Shift+F' }, disabled: ['agent.favorite.open:1'] })
    const restarted = makeFallback(hostFor())
    const state = await restarted.load()
    expect(state.bindings['conversation.composer.focus']).toBe('Primary+Shift+F')
    expect(state.disabled).toEqual(['agent.favorite.open:1'])
  })

  it('ignores malformed localStorage content instead of crashing', async () => {
    localStorage.setItem(LOCAL_STORAGE_KEY, '{not json')
    const fallback = makeFallback(null)
    expect(await fallback.load()).toEqual(EMPTY_SHORTCUT_STATE)
  })
})
