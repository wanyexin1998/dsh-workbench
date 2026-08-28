// W3.1 — Public registration API (design.md §3 "L2", §6 W3 rows): third-party
// client plugins register shortcut-bindable actions without touching
// Workbench internals ("actions protocol 1").
//
// Two responsibilities, mirroring host-commands.ts's own split:
//   - Validation (fail-closed): reserved namespaces, function-typed fields,
//     provider/id-prefix agreement — see validateActionDef.
//   - A module-level (per-apply) store of live third-party defs that
//     shortcuts.tsx's registry build consults via registerInto, exactly like
//     HostCommandsHandle.registerInto (host-commands.ts). Unlike the host
//     bridge (which POLLS a remote descriptor snapshot), this store is
//     PUSH-based: a plugin calls `register()` once, at any point in its own
//     lifecycle, and `registerInto` is the only place that ever touches a
//     live ActionRegistry — register()/dispose() only ever mutate the store
//     and notify onChange listeners. This keeps the store's own bookkeeping
//     independent of registry-rebuild timing (register() never needs to know
//     whether a registry currently exists), while still guaranteeing that a
//     late registration (a third-party plugin's apply() running after
//     Workbench's own) reaches the live registry: shortcuts.tsx subscribes
//     to onChange and reloads (a full registry rebuild) exactly the way it
//     already does for HostCommandsHandle.onChange.
import { ActionRegistry, DEFAULT_PROVIDER, type ActionDef } from '../core/action-registry.js'
import { UNBOUND_SENTINEL, type BindingOverrides } from '../core/shortcut-settings.js'
import { HOST_PROVIDER } from './host-commands.js'

/** actions protocol 1 (design.md §3 "L2"). */
export const ACTIONS_PROTOCOL = 1 as const

/** Raw registration input a third-party client plugin supplies to
 * `ctx.workbenchActions.register(def)`. `label`/`run`/`isEnabled` are
 * functions (not plain values) for the same reason ActionDef itself uses
 * functions for `run`/`isEnabled`: they are consulted at use time, not
 * baked in once. See {@link WorkbenchActionsService.register}'s doc comment
 * for exactly when `label()` gets called. */
export interface WorkbenchActionDef {
  readonly id: string
  readonly label: () => string
  readonly run: () => void
  readonly isEnabled?: () => boolean
  /** Defaults to `id`'s own first dot-segment; when given, must equal it
   * (design.md's "one provider per plugin id-prefix" rule — keeps Settings
   * grouping honest: a plugin cannot register actions that visually group
   * under a DIFFERENT plugin's namespace). */
  readonly provider?: string
  /** Defaults to `false`. When `true`, the bound chord fires even while an
   * editable element (the composer, an `<input>`, ...) has focus — see
   * ACTIONS_API.md's "While-typing dispatch" section and
   * {@link ActionDef.allowWhileTyping} (action-registry.ts) for the full
   * semantics this threads straight through to. Set this only for an action
   * whose entire job is an explicit chord gesture the user fires FROM inside
   * an editable element; leave it absent/`false` for anything that should
   * stay silent while the user is mid-sentence (Workbench's own default). */
  readonly allowWhileTyping?: boolean
}

/** Public contract exposed on `ctx.workbenchActions` — see src/client/
 * index.tsx for the `declare module '@deepseek-ai/cordis'` augmentation and
 * the exact citation of the ecosystem service-provide mechanism (`ctx.
 * reflect.provide` / the mixed-in `ctx.provide`) this mirrors, verified
 * against the sibling `dsh-workbench-panel-compat` package's own
 * `workbenchPanels` service (packages/dsh-workbench-panel-compat/src/
 * client/index.ts). */
export interface WorkbenchActionsService {
  readonly protocol: 1
  /**
   * Register one shortcut-bindable action. Throws synchronously —
   * validation is fail-closed, never a silent no-op — when:
   *   - `id` is not a non-empty string namespaced as `<provider>.
   *     <something>` (at least one dot; no leading, trailing, or duplicate
   *     dots; the provider segment matches `/^[a-z0-9][a-z0-9-]*$/i`);
   *   - `id`'s provider segment case-insensitively equals the reserved
   *     `workbench` or `host` namespace (Workbench's own built-ins and the
   *     L1 host-command bridge — `Workbench.foo`/`HOST.foo` are rejected
   *     exactly like `workbench.foo`/`host.foo`, not just an exact-case
   *     match);
   *   - `label` or `run` is not a function;
   *   - `isEnabled` is present but not a function;
   *   - `allowWhileTyping` is present but not a boolean;
   *   - `provider` is given but does not equal `id`'s own first segment;
   *   - `id` already has a live registration (from this call or any other
   *     — duplicate ids across providers are rejected too, since ids are
   *     global within Workbench's one ActionRegistry).
   *
   * The `def` object is read exactly once per field, at validation time,
   * into this service's own storage — a caller that mutates the object it
   * passed to `register()` afterwards has no effect on the live
   * registration (also closes a TOCTOU: a hostile getter cannot pass
   * validation with one value and then supply a different one to storage).
   *
   * `label()` is called once when the action is first built into a live
   * registry, and again every time Workbench rebuilds the registry (a
   * settings change, hydration, another provider's catalog changing, or a
   * Harness `locale/change` — Finding 2 smoke fix: see applyShortcuts'
   * `locale/change` subscription in shortcuts.tsx and ACTIONS_API.md's
   * "Labels and the active locale") — NOT on every render or keystroke. A
   * plugin whose label text just changed and needs that reflected
   * immediately should dispose and re-register. A `label()` that throws, or
   * returns a non-string, never
   * takes down the registry build — it falls back to rendering `id` (see
   * toActionDef) — but the underlying bug should still be fixed; treat a
   * fallback-rendered id as a signal something is wrong, not a supported
   * mode.
   *
   * `run()` is invoked synchronously from the keydown dispatcher, AFTER the
   * dispatcher has already called `event.preventDefault()` on the
   * triggering keystroke. Workbench does not wrap this call: a throwing
   * `run()` still consumes the keystroke (nothing else fires on that chord)
   * and the exception propagates to the window's default error handling
   * (visible in devtools, not surfaced as product UI). Handle your own
   * errors inside `run()`.
   *
   * No default chord is ever assigned (design.md anti-goals): the action
   * starts unbound; only an explicit user binding (or a previously
   * persisted one, keyed by `id`) ever occupies a chord.
   *
   * @returns an idempotent disposer that unregisters the action — removes
   * it from the live registry (freeing whatever chord it held) AND from
   * this service's own store, so a later `register()` with the same `id`
   * succeeds.
   */
  register(def: WorkbenchActionDef): () => void
}

/** Reserved namespaces (design.md §3 L2): Workbench's own built-ins and the
 * L1 host-command bridge. Imported, not duplicated, so this file can never
 * drift from the actual constants those two providers register under.
 * Compared case-insensitively against a candidate provider segment — see
 * firstSegment's own doc comment for why an exact-case Set.has() alone is
 * not enough (SF3: `Workbench.foo` / `HOST.foo` must be rejected too, not
 * just the exact-case forms). */
const RESERVED_PROVIDERS: ReadonlySet<string> = new Set([DEFAULT_PROVIDER, HOST_PROVIDER])

/** Provider-segment charset: must start with a letter or digit, and contain
 * only letters, digits, or hyphens afterwards. A provider segment is a
 * technical namespace token (it becomes part of a persisted binding key AND
 * a Settings group heading), not free-form display text — excluding
 * whitespace, punctuation, and non-ASCII characters closes a UI-
 * impersonation gap (SF3): without this, a provider segment that merely
 * differs from a reserved name by leading whitespace (` workbench.x`) or
 * script (`工作台.x`) rendered as its own, seemingly legitimate, fully
 * editable Settings group with confusable-looking text. */
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]*$/i

/** Validated, normalized form of a `WorkbenchActionDef` — `provider` is
 * always resolved (never left to default at every read site). */
interface ValidatedActionDef {
  readonly id: string
  readonly label: () => string
  readonly run: () => void
  readonly isEnabled?: () => boolean
  readonly provider: string
  readonly allowWhileTyping?: boolean
}

/** `id`'s own first dot-segment, or `null` when `id` is not validly
 * namespaced: no dot; a leading, trailing, or duplicate (adjacent) dot
 * anywhere in `id`; or a provider segment outside {@link PROVIDER_PATTERN}. */
function firstSegment(id: string): string | null {
  if (id.includes('..') || id.startsWith('.') || id.endsWith('.')) return null
  const dot = id.indexOf('.')
  if (dot <= 0 || dot === id.length - 1) return null
  const provider = id.slice(0, dot)
  return PROVIDER_PATTERN.test(provider) ? provider : null
}

/**
 * Fail-closed validation for actions protocol 1 — see {@link
 * WorkbenchActionsService.register}'s doc comment for the full rule set.
 * Pure (no store access — the "duplicate live id" check is the store's own
 * job, since it needs the current registration set). Exported for direct
 * unit coverage of every rejection path without needing a whole handle.
 *
 * Every field is read from `def` exactly once, into a local, which both the
 * validation check AND the returned snapshot then reuse — never re-read
 * `def.<field>` a second time. A getter-backed `def` that returns one value
 * to pass a check and a different value on the next read (TOCTOU) cannot
 * bypass validation this way, and the returned object is a true snapshot:
 * mutating the caller's original `def` afterwards has no effect on it.
 */
export function validateActionDef(def: WorkbenchActionDef): ValidatedActionDef {
  if (typeof def !== 'object' || def === null) {
    throw new Error('workbench.actions: register(def) requires an object')
  }
  const id = def.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('workbench.actions: register(def).id must be a non-empty string')
  }
  const provider = firstSegment(id)
  if (provider === null) {
    throw new Error(
      `workbench.actions: register(def).id "${id}" must be namespaced as "<provider>.<something>" — no leading, trailing, or duplicate dots, and the provider segment must match /^[a-z0-9][a-z0-9-]*$/i`,
    )
  }
  if (RESERVED_PROVIDERS.has(provider.toLowerCase())) {
    throw new Error(`workbench.actions: register(def).id "${id}" uses the reserved "${provider}." namespace (case-insensitive)`)
  }
  const label = def.label
  if (typeof label !== 'function') {
    throw new Error(`workbench.actions: register(def).label must be a function (action "${id}")`)
  }
  const run = def.run
  if (typeof run !== 'function') {
    throw new Error(`workbench.actions: register(def).run must be a function (action "${id}")`)
  }
  const isEnabled = def.isEnabled
  if (isEnabled !== undefined && typeof isEnabled !== 'function') {
    throw new Error(`workbench.actions: register(def).isEnabled must be a function when present (action "${id}")`)
  }
  const allowWhileTyping = def.allowWhileTyping
  if (allowWhileTyping !== undefined && typeof allowWhileTyping !== 'boolean') {
    throw new Error(`workbench.actions: register(def).allowWhileTyping must be a boolean when present (action "${id}")`)
  }
  const explicitProvider = def.provider
  if (explicitProvider !== undefined && explicitProvider !== provider) {
    throw new Error(
      `workbench.actions: register(def).provider "${explicitProvider}" does not match the id's own namespace "${provider}" (action "${id}")`,
    )
  }
  return { id, label, run, isEnabled, provider, allowWhileTyping }
}

/** Same '' -> explicit-unbind / undefined -> default-chord mapping used by
 * shortcuts.tsx and host-commands.ts. Duplicated (not imported) for the same
 * reason host-commands.ts duplicates it: avoids a circular import back to
 * shortcuts.tsx. Third-party actions never have a default chord (see
 * toActionDef), so — same as host-commands.ts's copy — this only ever
 * distinguishes an explicit Unbound override from "no override yet". */
function unbindSpec(spec: string | undefined): string | null {
  return spec === UNBOUND_SENTINEL ? '' : (spec ?? null)
}

/**
 * BLOCKING 1 fix: `def.label()` is a third-party plugin's own code — it can
 * throw, or return a non-string — and this function runs from inside
 * `registerInto`, which runs from inside `buildShortcutRegistry`, which
 * shortcuts.tsx's `reload()` calls AFTER it has already detached the live
 * keydown listener (and reassigns/reattaches only after `buildShortcutRegistry`
 * returns). An unguarded throw here would propagate all the way out of
 * `reload()`, leaving the dispatcher permanently detached (every action,
 * from every provider, stops firing) and leaving THIS entry's own
 * `liveDispose` unset (register()'s emitChange() already ran, synchronously,
 * before this ever executes — so the poisoned def has no way to be cleanly
 * torn down either). A single plugin's bug must never be able to do that:
 * fall back to the raw `id` — the exact same "render the id when there is no
 * good label" fallback W1.3 already applies to an unrecognized dictionary
 * key — and keep going.
 */
function toActionDef(def: ValidatedActionDef): ActionDef {
  let label: string
  try {
    const result = def.label()
    label = typeof result === 'string' ? result : def.id
  } catch {
    label = def.id
  }
  return {
    id: def.id,
    label,
    // design.md anti-goals: never auto-assign a default chord to a
    // discovered/third-party action — only an explicit user binding ever
    // occupies a key.
    defaultChord: null,
    provider: def.provider,
    run: def.run,
    isEnabled: def.isEnabled,
    allowWhileTyping: def.allowWhileTyping,
  }
}

interface ThirdPartyEntry {
  readonly def: ValidatedActionDef
  /** The disposer from the most recent `ActionRegistry.register()` call
   * this entry went through (via `registerInto`), or `null` if it has never
   * been synced into any live registry yet (e.g. registered before
   * Workbench's own applyShortcuts ran for the first time). Always the
   * LATEST one: an older registry a previous rebuild discarded is simply
   * left to be garbage collected — calling its stale disposer would be
   * harmless (RegisterResult.dispose() only ever tears down the exact
   * registration it came from) but is never reached because this field is
   * overwritten on every registerInto sync. */
  liveDispose: (() => void) | null
}

export interface ThirdPartyActionsHandle {
  /** The public workbench.actions service surface — exposed on
   * `ctx.workbenchActions` by src/client/index.tsx. */
  readonly service: WorkbenchActionsService
  /** Reconcile `registry` to the current live third-party defs. Called by
   * shortcuts.tsx's buildShortcutRegistry on every rebuild — mirrors
   * HostCommandsHandle.registerInto exactly: a `registry` instance not seen
   * before gets every currently-live def freshly registered into it (this
   * is what makes a registration "survive" a settings-reload rebuild); the
   * same `registry` instance seen again is a no-op (every live def is
   * already synced into it — register()/the returned disposer keep it
   * current incrementally, see the module doc comment). */
  registerInto(registry: ActionRegistry, opts: { overrides: BindingOverrides; disabled: ReadonlySet<string> }): void
  /** O(1) membership check: does `provider` have at least one LIVE
   * third-party registration right now (registered through this handle's
   * `service.register`, not merely present as some action's `provider`
   * field in a registry someone poked directly — a test double, or a
   * future L3 adapter, could do that without ever going through this
   * trusted API). This is the hot-path check shortcuts.tsx's Settings-UI
   * consults once PER ROW on every render — see liveProviders()'s own doc
   * comment for why that call site specifically must not allocate. */
  hasLiveProvider(provider: string): boolean
  /** Distinct provider ids with at least one LIVE third-party registration
   * right now — same trust semantics as {@link hasLiveProvider}. Snapshot
   * (allocates a new Set) — for introspection and tests, NOT for a
   * per-row/per-render hot path (use `hasLiveProvider` there instead; it
   * used to be `liveProviders().has(provider)`, which allocated one Set per
   * Settings row on every render for no reason). */
  liveProviders(): ReadonlySet<string>
  /** Fires whenever the live def set changes (a registration or a dispose).
   * shortcuts.tsx re-triggers its own registry rebuild, exactly like
   * HostCommandsHandle.onChange. A listener that throws is isolated (SF2):
   * it neither blocks delivery to any other listener nor propagates back
   * out of whatever register()/dispose() call triggered this emit. */
  onChange(fn: () => void): () => void
  /** apply()-lifecycle teardown: clears the store and disposes every live
   * registration this handle currently holds in whatever registry it was
   * last synced into. Idempotent. After this, `service.register` throws
   * (fail-closed — a plugin that keeps a reference to the service across
   * Workbench's own unload gets a clear error, not a silent no-op or a
   * crash reaching into torn-down state). */
  dispose(): void
}

/** W3.1 entry point — see the module doc comment for the push/pull split
 * this factory implements. Pure: takes no `ctx`, since registration is
 * push-based (the service object itself is the only thing a caller needs). */
export function createThirdPartyActionsHandle(): ThirdPartyActionsHandle {
  const defs = new Map<string, ThirdPartyEntry>()
  // Incrementally maintained provider -> live-registration-count, so
  // hasLiveProvider() is an O(1) Map lookup with zero allocation instead of
  // building a Set from every entry on every call (nit c: shortcuts.tsx
  // calls the equivalent check once per Settings row on every render).
  const providerCounts = new Map<string, number>()
  let syncedRegistry: ActionRegistry | null = null
  let disposed = false
  const changeListeners = new Set<() => void>()

  /**
   * SF2 fix, half 1: isolate each listener's own throw — a listener that
   * throws must not prevent any OTHER listener from running, and must not
   * propagate back out into whatever register()/dispose() call triggered
   * this emit (that caller's own bookkeeping has already fully completed by
   * the time emitChange() runs; see register()'s call site below).
   */
  const emitChange = (): void => {
    for (const fn of [...changeListeners]) {
      try {
        fn()
      } catch (error) {
        console.error('[dsh-workbench] workbench.actions: an onChange listener threw', error)
      }
    }
  }

  function registerInto(
    registry: ActionRegistry,
    opts: { overrides: BindingOverrides; disabled: ReadonlySet<string> },
  ): void {
    if (disposed) return
    if (registry === syncedRegistry) return // already holds every live def (kept current incrementally)
    syncedRegistry = registry
    for (const [id, entry] of defs) {
      const result = registry.register(toActionDef(entry.def), unbindSpec(opts.overrides[id]), opts.disabled.has(id))
      entry.liveDispose = result.dispose
    }
  }

  function incrementProvider(provider: string): void {
    providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1)
  }

  function decrementProvider(provider: string): void {
    const next = (providerCounts.get(provider) ?? 1) - 1
    if (next <= 0) providerCounts.delete(provider)
    else providerCounts.set(provider, next)
  }

  const service: WorkbenchActionsService = {
    protocol: ACTIONS_PROTOCOL,
    register(rawDef: WorkbenchActionDef): () => void {
      if (disposed) {
        throw new Error('workbench.actions: cannot register — the service has been disposed (the Workbench plugin is unloading)')
      }
      const def = validateActionDef(rawDef)
      if (defs.has(def.id)) {
        throw new Error(`workbench.actions: action "${def.id}" already has a live registration`)
      }
      const entry: ThirdPartyEntry = { def, liveDispose: null }
      defs.set(def.id, entry)
      incrementProvider(def.provider)
      // SF2 fix, half 2: emitChange() itself now isolates every listener's
      // own throw (see its own doc comment above), so this catch is
      // UNREACHABLE from an ordinary listener failure today — kept as a
      // second, independent layer of defense in case a future change to the
      // emit path (or something else entirely) throws before every listener
      // has run. register() must never leave a stored, disposer-less entry
      // behind that its own caller believes it already unwound via the
      // (never-returned) disposer.
      try {
        emitChange()
      } catch (error) {
        defs.delete(def.id)
        decrementProvider(def.provider)
        throw error
      }
      let entryDisposed = false
      return () => {
        if (entryDisposed) return
        entryDisposed = true
        if (defs.get(def.id) === entry) {
          defs.delete(def.id)
          decrementProvider(def.provider)
        }
        entry.liveDispose?.() // frees the chord immediately, no rebuild required
        entry.liveDispose = null
        emitChange()
      }
    },
  }

  return {
    service,
    registerInto,
    hasLiveProvider(provider: string): boolean {
      return providerCounts.has(provider)
    },
    liveProviders(): ReadonlySet<string> {
      return new Set(providerCounts.keys())
    },
    onChange(fn: () => void): () => void {
      changeListeners.add(fn)
      return () => changeListeners.delete(fn)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const entry of defs.values()) entry.liveDispose?.()
      defs.clear()
      providerCounts.clear()
      syncedRegistry = null
      changeListeners.clear()
    },
  }
}
