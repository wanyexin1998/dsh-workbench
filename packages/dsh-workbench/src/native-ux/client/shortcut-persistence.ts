// GA-003/022 - Shortcut persistence: Host settings first, localStorage
// fallback. Persists ONLY chord bindings + disabled action ids + schema
// version; never prompt/session/api-key material (Roadmap §6.2).
import { parseBindingOverrides, UNBOUND_SENTINEL, type BindingOverrides } from '../core/shortcut-settings.js'

export interface ShortcutPersistedStateV1 {
  schemaVersion: 1
  bindings: BindingOverrides
  disabled: string[]
}

export const EMPTY_SHORTCUT_STATE: ShortcutPersistedStateV1 = {
  schemaVersion: 1,
  bindings: {},
  disabled: [],
}

function isEmptyState(state: ShortcutPersistedStateV1): boolean {
  return Object.keys(state.bindings).length === 0 && state.disabled.length === 0
}

export interface ShortcutPersistence {
  load(): Promise<ShortcutPersistedStateV1>
  save(state: ShortcutPersistedStateV1): Promise<'host' | 'local'>
}

export const LOCAL_STORAGE_KEY = 'dsh-native-ux.shortcuts.v1'

/** Narrowing of persisted JSON into the V1 shape; malformed -> empty. */
export function parsePersistedState(value: unknown): ShortcutPersistedStateV1 {
  if (typeof value !== 'object' || value === null) return EMPTY_SHORTCUT_STATE
  const raw = value as { schemaVersion?: unknown; bindings?: unknown; disabled?: unknown }
  if (raw.schemaVersion !== 1) return EMPTY_SHORTCUT_STATE
  const bindings = parseBindingOverrides(raw.bindings)
  const disabled = Array.isArray(raw.disabled)
    ? raw.disabled.filter((id: unknown): id is string => typeof id === 'string')
    : []
  return { schemaVersion: 1, bindings, disabled }
}

/** localStorage provider: JSON under LOCAL_STORAGE_KEY, never throws. */
export class LocalShortcutPersistence {
  load(): ShortcutPersistedStateV1 {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY)
      if (raw === null) return EMPTY_SHORTCUT_STATE
      return parsePersistedState(JSON.parse(raw))
    } catch {
      return EMPTY_SHORTCUT_STATE
    }
  }

  save(state: ShortcutPersistedStateV1): void {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state))
  }
}

/** The single field the host section stores the versioned envelope under.
 * The namespace is registered as a flat string dict (z.dict(z.string())), so
 * the envelope is JSON-encoded into one string value — this keeps schema
 * versioning and gives load/save one unambiguous round-trip field. */
const HOST_STATE_FIELD = '__state'

/** True when this bound scope will actually persist the namespace across a
 * reload.
 *
 * A bound settings snapshot is a plain object even when the namespace is NOT
 * durable for this client: the rc reports `{status:'unavailable'}` for a
 * third-party namespace that is not exposed to configuration clients (the
 * current rc answers `settings-not-exposed` for our namespace), and
 * `{mode:'memory'}` for a remote browser whose preferences stay process-local.
 *
 * Critically, the rc's `scope.set()` RESOLVES even when the host rejects the
 * write with settings-not-exposed (it performs a recovery read and returns
 * rather than throwing). So "set() settled" must NOT be treated as durable —
 * only the snapshot's own `status`/`mode` signals decide that. `loading` (the
 * boot window before the first read) counts as durable: on a loopback host the
 * namespace is registered and the connection is durable, we simply don't have
 * the value yet. */
function hostIsDurable(snapshot: unknown): boolean {
  if (typeof snapshot !== 'object' || snapshot === null) return false
  const s = snapshot as { status?: unknown; mode?: unknown }
  // Durable only when the connection persists to the Host document (not
  // memory mode) AND the namespace has settled to a state that is not
  // unavailable. 'loading' (still resolving) is deliberately excluded: we
  // cannot confirm durability yet, so the caller falls back to local rather
  // than risk a write the Host will drop.
  return s.mode !== 'memory' && s.status !== 'unavailable' && s.status !== 'loading'
}

/** Read the versioned envelope string out of a durable snapshot; null when
 * the namespace holds no state yet. */
function hostStateField(snapshot: unknown): string | null {
  if (typeof snapshot !== 'object' || snapshot === null) return null
  const layer = (snapshot as { user?: unknown; value?: unknown }).user
    ?? (snapshot as { value?: unknown }).value
  if (typeof layer !== 'object' || layer === null) return null
  const raw = (layer as Record<string, unknown>)[HOST_STATE_FIELD]
  return typeof raw === 'string' ? raw : null
}

/** Host settings provider: read/write via the bound settings scope.
 * Durable only when the snapshot's status/mode say so — see hostIsDurable for
 * why a resolved set() is not enough. When the host is not durable (current
 * rc: namespace not exposed), load/save throw settings-not-exposed so the
 * Fallback layer stores in localStorage instead of assuming a host write that
 * never persisted. */
export class HostShortcutPersistence {
  constructor(private readonly scope: {
    getSnapshot(): unknown
    subscribe?(fn: () => void): () => void
    set(field: string, value: unknown): Promise<void>
    unset(field: string): Promise<void>
  }) {}

  /** The rc's settings scope starts `loading` and only settles to `ready` /
   * `unavailable` once the background read of the namespace completes. A
   * durability decision made during that window is wrong, so wait (bounded)
   * for it to settle before deciding. */
  private async settleSnapshot(timeoutMs = 1500): Promise<unknown> {
    const read = () => this.scope.getSnapshot() as { status?: unknown } | null
    const isSettled = (s: unknown): boolean => {
      if (typeof s !== 'object' || s === null) return true
      return (s as { status?: unknown }).status !== 'loading'
    }
    const current = read()
    if (isSettled(current)) return current
    if (typeof this.scope.subscribe !== 'function') {
      // No reactive handle: poll briefly rather than block forever.
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
        if (isSettled(read())) return read()
      }
      return read()
    }
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let unsubscribe: (() => void) | undefined
      let settled = false
      const finish = (result: 'ok' | 'timeout', snapshot: unknown) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (unsubscribe !== undefined) unsubscribe()
        if (result === 'ok') resolve(snapshot)
        else reject(new Error('settings-not-exposed'))
      }
      // The rc's subscribe may fire synchronously, so finish must tolerate
      // timer/unsubscribe not being assigned yet (the guards above).
      unsubscribe = this.scope.subscribe!(() => {
        const s = read()
        if (isSettled(s)) finish('ok', s)
      })
      // It may have settled between the initial getSnapshot() and subscribe(),
      // in which case no further notification fires — re-check before waiting.
      if (!settled) {
        const s = read()
        if (isSettled(s)) finish('ok', s)
      }
      // Only schedule the timeout if we have not already settled.
      if (!settled) {
        timer = setTimeout(() => {
          const s = read()
          if (isSettled(s)) finish('ok', s)
          else finish('timeout', s)
        }, timeoutMs)
      }
    })
  }

  /** Wait for the snapshot to settle, then assert it is durable; otherwise
   * throw settings-not-exposed so the Fallback layer uses localStorage. */
  private async durableSnapshot(): Promise<unknown> {
    const snapshot = await this.settleSnapshot()
    if (!hostIsDurable(snapshot)) throw new Error('settings-not-exposed')
    return snapshot
  }

  async load(): Promise<ShortcutPersistedStateV1> {
    const snapshot = await this.durableSnapshot()
    const raw = hostStateField(snapshot)
    if (raw === null) return { ...EMPTY_SHORTCUT_STATE }
    return parsePersistedState(JSON.parse(raw))
  }

  async save(state: ShortcutPersistedStateV1): Promise<'host'> {
    // Gate on durability BEFORE writing: a blind set() resolves even when the
    // host rejects it, which would make the Fallback layer clear local data
    // and lose the chord on reload.
    await this.durableSnapshot()
    await this.scope.set(HOST_STATE_FIELD, JSON.stringify(state))
    return 'host'
  }
}

/** Host-first + local fallback. A successful host save after a local one is
 * the migration path: once the host accepts writes, local data is cleared.
 *
 * `onLocalFallback` is an optional, dev-only diagnostic hook: it fires the
 * first time the host layer is not durable and we store in localStorage
 * instead. §9A.17 rule 6 requires persistence degradation to be diagnosable
 * (console warn) without surfacing it in product UI — the caller maps it to
 * warnOnce. */
export class FallbackShortcutPersistence implements ShortcutPersistence {
  private localWarned = false
  constructor(
    private readonly host: ShortcutPersistence | null,
    private readonly local: LocalShortcutPersistence,
    private readonly onLocalFallback?: (reason: 'host-not-durable') => void,
  ) {}

  async load(): Promise<ShortcutPersistedStateV1> {
    if (this.host !== null) {
      try {
        const hostState = await this.host.load()
        const localState = this.local.load()
        if (isEmptyState(hostState) && !isEmptyState(localState)) {
          await this.host.save(localState)
          this.local.save(EMPTY_SHORTCUT_STATE)
          return localState
        }
        return hostState
      } catch {
        // host namespace not durable -> fall through to local
        this.diagnoseLocalFallback()
      }
    }
    return this.local.load()
  }

  async save(state: ShortcutPersistedStateV1): Promise<'host' | 'local'> {
    if (this.host !== null) {
      try {
        const where = await this.host.save(state)
        // Host accepted the full state: stale local fallback can go.
        this.local.save(EMPTY_SHORTCUT_STATE)
        return where
      } catch {
        // host not durable -> fall back to local below
        this.diagnoseLocalFallback()
      }
    }
    this.local.save(state)
    return 'local'
  }

  private diagnoseLocalFallback(): void {
    if (this.localWarned || this.onLocalFallback === undefined) return
    this.localWarned = true
    this.onLocalFallback('host-not-durable')
  }
}

/** Sentinel stored in local bindings to represent explicit unbound actions;
 * identical semantics to the host-side UNBOUND_SENTINEL. */
export function unboundMarker(spec: string | undefined): boolean {
  return spec === UNBOUND_SENTINEL
}
