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
  migrateLegacyActionIds,
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
      bindings: { 'workbench.conversation.navigator.toggle': 'Primary+Shift+O', bad: 'not-a-chord' },
      disabled: ['workbench.session.stop', 42, null],
    })
    expect(state.bindings).toEqual({ 'workbench.conversation.navigator.toggle': 'Primary+Shift+O' })
    expect(state.disabled).toEqual(['workbench.session.stop'])
  })

  it('keeps the explicit unbound sentinel', () => {
    const state = parsePersistedState({ schemaVersion: 1, bindings: { 'workbench.session.stop': 'Unbound' } })
    expect(state.bindings['workbench.session.stop']).toBe('Unbound')
  })
})

// W2.2 — hostDirectExecute: structural-only tolerance (same contract as
// `disabled`), no id-namespace migration (host.command.* never had a
// pre-W1.2 bare form to migrate from).
describe('parsePersistedState — hostDirectExecute (W2.2)', () => {
  it('parses a valid array of action ids', () => {
    const state = parsePersistedState({
      schemaVersion: 1,
      bindings: {},
      disabled: [],
      hostDirectExecute: ['host.command.foo', 'host.command.bar'],
    })
    expect(state.hostDirectExecute).toEqual(['host.command.foo', 'host.command.bar'])
  })

  it('defaults to [] when the field is absent (round-trips through EMPTY_SHORTCUT_STATE)', () => {
    const state = parsePersistedState({ schemaVersion: 1, bindings: {}, disabled: [] })
    expect(state.hostDirectExecute).toEqual([])
    expect(state).toEqual(EMPTY_SHORTCUT_STATE)
  })

  it('drops non-string entries and tolerates a non-array shape without throwing', () => {
    const state = parsePersistedState({
      schemaVersion: 1,
      bindings: {},
      disabled: [],
      hostDirectExecute: ['host.command.foo', 42, null, {}],
    })
    expect(state.hostDirectExecute).toEqual(['host.command.foo'])
    const malformed = parsePersistedState({ schemaVersion: 1, bindings: {}, disabled: [], hostDirectExecute: 'not-an-array' })
    expect(malformed.hostDirectExecute).toEqual([])
  })

  it('is NOT touched by the W1.2 id-namespace migration, even when a legacy bare bindings key is present in the same document', () => {
    // A single fixed-input regression check, not exhaustive coverage of
    // migrateLegacyActionIds' internals: it demonstrates that one
    // parsePersistedState() call which DOES migrate an unrelated legacy
    // bindings key leaves hostDirectExecute byte-for-byte untouched.
    // hostDirectExecute ids never had a pre-W1.2 bare form, so there is
    // nothing for that migration to touch in the first place — this pins
    // the two fields being parsed independently, not a claim about every
    // possible migrateLegacyActionIds input.
    const state = parsePersistedState({
      schemaVersion: 1,
      bindings: { 'session.stop': 'Primary+K' }, // legacy bare id, gets migrated
      disabled: [],
      hostDirectExecute: ['host.command.foo'],
    })
    expect(state.bindings).toEqual({ 'workbench.session.stop': 'Primary+K' })
    expect(state.hostDirectExecute).toEqual(['host.command.foo'])
  })
})

// W1.2 — id namespacing migration: any key that exactly matches an old
// (pre-W1.2, un-namespaced) built-in id is re-keyed to its
// `workbench.`-prefixed form on read. Exercised both through the pure
// projection directly (migrateLegacyActionIds) and through
// parsePersistedState (the shared choke point every persistence backend
// reads through).
describe('migrateLegacyActionIds (W1.2 id namespacing)', () => {
  it('re-keys an old built-in id to its workbench.-namespaced form, value preserved verbatim', () => {
    expect(migrateLegacyActionIds({ 'session.stop': 'Primary+Shift+K' })).toEqual({
      'workbench.session.stop': 'Primary+Shift+K',
    })
  })

  it('preserves the Unbound sentinel through the rekey', () => {
    expect(migrateLegacyActionIds({ 'pane.close-focused': 'Unbound' })).toEqual({
      'workbench.pane.close-focused': 'Unbound',
    })
  })

  it('passes an already-namespaced key through untouched', () => {
    expect(migrateLegacyActionIds({ 'workbench.session.stop': 'Primary+K' })).toEqual({
      'workbench.session.stop': 'Primary+K',
    })
  })

  it('re-keys the favorite slots (frozen :1..:9 suffix form)', () => {
    expect(migrateLegacyActionIds({ 'agent.favorite.open:1': 'Primary+1', 'agent.favorite.open:9': 'Primary+9' }))
      .toEqual({ 'workbench.agent.favorite.open:1': 'Primary+1', 'workbench.agent.favorite.open:9': 'Primary+9' })
  })

  it('passes an unknown foreign-provider key through untouched (not dropped, not re-prefixed)', () => {
    // Future L1/L2/L3 providers own ids like host.command.<name> or
    // <plugin>.<action> — this function must never touch them.
    expect(migrateLegacyActionIds({ 'someplugin.custom-action': 'Primary+K' })).toEqual({
      'someplugin.custom-action': 'Primary+K',
    })
  })

  it('when both the old and the namespaced key are present, the new key wins and the old is dropped', () => {
    // The namespaced key can only have been written by a version that
    // already migrated (or by a save after migration), so it reflects the
    // user's most recent intent — deleting this rule would let the old
    // value win instead, or leave both keys present.
    const out = migrateLegacyActionIds({
      'session.stop': 'Primary+A',
      'workbench.session.stop': 'Primary+B',
    })
    expect(out).toEqual({ 'workbench.session.stop': 'Primary+B' })
    expect(Object.keys(out)).not.toContain('session.stop')
  })

  it('composes with parseBindingOverrides value validation via parsePersistedState (invalid values still dropped)', () => {
    const state = parsePersistedState({
      schemaVersion: 1,
      bindings: { 'session.stop': 'not-a-chord', 'layout.sidebar.toggle': 'Primary+J' },
    })
    // The invalid value is dropped by parseBindingOverrides BEFORE the
    // rekey ever sees it — deleting the migration step would leave the
    // key un-namespaced instead of missing it entirely.
    expect(state.bindings).toEqual({ 'workbench.layout.sidebar.toggle': 'Primary+J' })
  })

  it('also migrates old ids in the disabled list, deduplicating old+new', () => {
    const state = parsePersistedState({
      schemaVersion: 1,
      bindings: {},
      disabled: ['session.stop', 'workbench.layout.sidebar.toggle', 'layout.sidebar.toggle'],
    })
    expect(state.disabled).toEqual(['workbench.session.stop', 'workbench.layout.sidebar.toggle'])
  })
})

describe('HostShortcutPersistence', () => {
  it('loads the versioned envelope from a durable, ready snapshot', async () => {
    const scope = fixedScope(
      readySnapshot({ schemaVersion: 1, bindings: { 'workbench.session.stop': 'Primary+X' }, disabled: ['workbench.layout.sidebar.toggle'], hostDirectExecute: [] }),
    )
    const state = await new HostShortcutPersistence(scope).load()
    expect(state.bindings['workbench.session.stop']).toBe('Primary+X')
    expect(state.disabled).toEqual(['workbench.layout.sidebar.toggle'])
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
    await new HostShortcutPersistence(scope).save({ schemaVersion: 1, bindings: { 'workbench.session.stop': 'Primary+K' }, disabled: [], hostDirectExecute: [] })
    expect(scope.set).toHaveBeenCalledTimes(1)
    const [field, raw] = scope.set.mock.calls[0] as [string, unknown]
    expect(field).toBe(HOST_STATE_FIELD)
    expect(JSON.parse(String(raw)).bindings['workbench.session.stop']).toBe('Primary+K')
  })

  it('does NOT write to the host when the namespace is not durable', async () => {
    const scope = fixedScope({ status: 'unavailable', mode: 'host', user: undefined, value: undefined })
    const set = scope.set as ReturnType<typeof vi.fn>
    await expect(
      new HostShortcutPersistence(scope).save({ schemaVersion: 1, bindings: { 'workbench.session.stop': 'Primary+K' }, disabled: [], hostDirectExecute: [] }),
    ).rejects.toThrow('settings-not-exposed')
    expect(set).not.toHaveBeenCalled()
  })
})

describe('FallbackShortcutPersistence', () => {
  it('imports a legacy local state when the durable Host section is empty', async () => {
    const legacy: ShortcutPersistedStateV1 = {
      schemaVersion: 1,
      bindings: { 'workbench.pane.close-focused': 'Primary+Shift+W' },
      disabled: ['workbench.layout.sidebar.toggle'],
      hostDirectExecute: [],
    }
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(legacy))
    const scope = fixedScope(readySnapshot(null))

    await expect(makeFallback(new HostShortcutPersistence(scope)).load()).resolves.toEqual(legacy)
    expect(scope.set).toHaveBeenCalledWith('__state', JSON.stringify(legacy))
    expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY)!)).toEqual(EMPTY_SHORTCUT_STATE)
  })

  it('W1.2: composes with the legacy-namespace import — a 0.1 local section with bare ids lands fully namespaced in the host after both migrations', async () => {
    // The 0.1 section predates BOTH the host-settings backend and the id
    // namespace: it is a flat localStorage blob keyed by the bare built-in
    // ids. load() must (1) rekey the bare ids to their workbench.-namespaced
    // form (parsePersistedState, via LocalShortcutPersistence.load()) and
    // (2) import that already-migrated state into the (empty) durable host,
    // clearing local — the pre-existing legacy-namespace migration path.
    const legacyZeroOne = {
      schemaVersion: 1,
      bindings: { 'pane.close-focused': 'Primary+Shift+W' },
      disabled: ['layout.sidebar.toggle'],
    }
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(legacyZeroOne))
    const scope = fixedScope(readySnapshot(null))

    const fullyMigrated: ShortcutPersistedStateV1 = {
      schemaVersion: 1,
      bindings: { 'workbench.pane.close-focused': 'Primary+Shift+W' },
      disabled: ['workbench.layout.sidebar.toggle'],
      hostDirectExecute: [],
    }
    await expect(makeFallback(new HostShortcutPersistence(scope)).load()).resolves.toEqual(fullyMigrated)
    // The import write itself carries the namespaced ids, not the bare 0.1 ones.
    expect(scope.set).toHaveBeenCalledWith('__state', JSON.stringify(fullyMigrated))
    expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY)!)).toEqual(EMPTY_SHORTCUT_STATE)
  })

  it('falls back to local when the host namespace is not exposed', async () => {
    localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, bindings: { 'workbench.conversation.navigator.toggle': 'Primary+Shift+P' }, disabled: [] }),
    )
    const fallback = makeFallback(new HostShortcutPersistence(fixedScope({ status: 'unavailable', mode: 'host', user: undefined, value: undefined })))
    const state = await fallback.load()
    expect(state.bindings['workbench.conversation.navigator.toggle']).toBe('Primary+Shift+P')
  })

  it('CRITICAL: set() resolves but host is not durable -> local is preserved, not wiped', async () => {
    // This is the exact bug: the host rejects the write with settings-not-exposed,
    // yet the rc's set() resolves. The old code treated that as a host save and
    // cleared local data, losing the chord on reload.
    const scope = fixedScope({ status: 'unavailable', mode: 'host', user: {}, value: {} })
    const fallback = makeFallback(new HostShortcutPersistence(scope))
    const where = await fallback.save({ schemaVersion: 1, bindings: { 'workbench.session.stop': 'Primary+K' }, disabled: ['workbench.layout.sidebar.toggle'], hostDirectExecute: [] })
    expect(where).toBe('local')
    // local must now hold the state (NOT the empty cleared state)
    const stored = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY)!) as ShortcutPersistedStateV1
    expect(stored.bindings['workbench.session.stop']).toBe('Primary+K')
    expect(stored.disabled).toEqual(['workbench.layout.sidebar.toggle'])
    // and a reload (fresh instance) must read it back from local
    const reloaded = await makeFallback(new HostShortcutPersistence(fixedScope({ status: 'unavailable', mode: 'host', user: {}, value: {} }))).load()
    expect(reloaded.bindings['workbench.session.stop']).toBe('Primary+K')
    expect(reloaded.disabled).toEqual(['workbench.layout.sidebar.toggle'])
  })

  it('prefers the durable host on success and clears stale local data (migration path)', async () => {
    localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, bindings: { 'workbench.layout.sidebar.toggle': 'Primary+J' }, disabled: [] }),
    )
    const scope = fixedScope(readySnapshot(null))
    const fallback = makeFallback(new HostShortcutPersistence(scope))
    const where = await fallback.save({ schemaVersion: 1, bindings: { 'workbench.session.stop': 'Primary+K' }, disabled: [], hostDirectExecute: [] })
    expect(where).toBe('host')
    // host accepted the state -> stale local fallback is cleared
    expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY)!)).toEqual(EMPTY_SHORTCUT_STATE)
  })

  it('round-trips through a durable host snapshot (restart)', async () => {
    const saved: ShortcutPersistedStateV1 = { schemaVersion: 1, bindings: { 'workbench.conversation.composer.focus': 'Primary+Shift+F' }, disabled: ['workbench.agent.favorite.open:1'], hostDirectExecute: [] }
    const hostFor = () => new HostShortcutPersistence(fixedScope(readySnapshot(saved)))
    const first = makeFallback(hostFor())
    await first.save(saved)
    // "restart": a fresh fallback reading the same durable host state
    const restarted = makeFallback(hostFor())
    const state = await restarted.load()
    expect(state.bindings['workbench.conversation.composer.focus']).toBe('Primary+Shift+F')
    expect(state.disabled).toEqual(['workbench.agent.favorite.open:1'])
  })

  it('W2.2: hostDirectExecute round-trips through a durable host snapshot (restart), alongside an unrelated W1.2 legacy-id bindings migration', async () => {
    // Combines both W2.2's own persistence contract AND the "survives the
    // W1.2 migration path untouched" requirement in one exercise: the
    // bindings section carries a legacy bare id (migrated on read) while
    // hostDirectExecute carries a host.command.* id (never migrated,
    // preserved verbatim) — proof the two persisted fields are handled
    // independently through the same save/load round trip.
    const saved: ShortcutPersistedStateV1 = {
      schemaVersion: 1,
      bindings: { 'workbench.session.stop': 'Primary+K' },
      disabled: [],
      hostDirectExecute: ['host.command.foo', 'host.command.bar'],
    }
    const hostFor = () => new HostShortcutPersistence(fixedScope(readySnapshot(saved)))
    const first = makeFallback(hostFor())
    await first.save(saved)
    const restarted = makeFallback(hostFor())
    const state = await restarted.load()
    expect(state.hostDirectExecute).toEqual(['host.command.foo', 'host.command.bar'])
    expect(state.bindings).toEqual({ 'workbench.session.stop': 'Primary+K' })
  })

  it('W2.2: hostDirectExecute survives the local->host legacy import path (FallbackShortcutPersistence.load)', async () => {
    // Mirrors the existing "imports a legacy local state when the durable
    // Host section is empty" test above, but for hostDirectExecute
    // specifically: a pre-existing local blob (as if written before the
    // host namespace became durable) must import into the host WITH its
    // hostDirectExecute entries intact, not dropped.
    const legacy: ShortcutPersistedStateV1 = {
      schemaVersion: 1,
      bindings: {},
      disabled: [],
      hostDirectExecute: ['host.command.foo'],
    }
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(legacy))
    const scope = fixedScope(readySnapshot(null))
    await expect(makeFallback(new HostShortcutPersistence(scope)).load()).resolves.toEqual(legacy)
    expect(scope.set).toHaveBeenCalledWith('__state', JSON.stringify(legacy))
  })

  it('local fallback round-trips after restart when the host is never durable', async () => {
    const hostFor = () => new HostShortcutPersistence(fixedScope({ status: 'unavailable', mode: 'host', user: {}, value: {} }))
    const first = makeFallback(hostFor())
    await first.save({ schemaVersion: 1, bindings: { 'workbench.conversation.composer.focus': 'Primary+Shift+F' }, disabled: ['workbench.agent.favorite.open:1'], hostDirectExecute: [] })
    const restarted = makeFallback(hostFor())
    const state = await restarted.load()
    expect(state.bindings['workbench.conversation.composer.focus']).toBe('Primary+Shift+F')
    expect(state.disabled).toEqual(['workbench.agent.favorite.open:1'])
  })

  it('ignores malformed localStorage content instead of crashing', async () => {
    localStorage.setItem(LOCAL_STORAGE_KEY, '{not json')
    const fallback = makeFallback(null)
    expect(await fallback.load()).toEqual(EMPTY_SHORTCUT_STATE)
  })
})
