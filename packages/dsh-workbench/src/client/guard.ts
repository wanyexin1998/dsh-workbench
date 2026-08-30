import type { SupportedHarnessBuild } from './contract.ts'

/** A failed split-pane compatibility verdict; other Workbench modules remain active. */
export interface GuardFailure {
  readonly disabled: true
  readonly reason: 'incompatible DeepSeek Harness presentation'
  readonly detected: string
  readonly supported: string
}

/** A compatible presentation verdict. */
export interface GuardPass { readonly disabled: false }

/** Split-pane startup verdict. */
export type GuardVerdict = GuardPass | GuardFailure

/**
 * Verify the versioned Presentation face without probing private DOM or
 * unversioned session members.
 * @param sessions - injected sessions service at client activation.
 * @param supported - protocol revision this release was tested against.
 * @returns fail-closed verdict for the split-pane module only.
 */
export function runStartupGuard(sessions: unknown, supported: SupportedHarnessBuild): GuardVerdict {
  const presentation = (sessions as { presentation?: unknown } | undefined)?.presentation
  const supportedLabel = `${supported.version} (presentation protocol ${supported.protocol})`
  if (typeof presentation !== 'object' || presentation === null) {
    return {
      disabled: true,
      reason: 'incompatible DeepSeek Harness presentation',
      detected: 'missing: sessions.presentation',
      supported: supportedLabel,
    }
  }
  const protocol = (presentation as { protocol?: unknown }).protocol
  if (protocol !== supported.protocol) {
    return {
      disabled: true,
      reason: 'incompatible DeepSeek Harness presentation',
      detected: `presentation.protocol ${typeof protocol === 'number' ? protocol : 'absent'}`,
      supported: supportedLabel,
    }
  }
  // The protocol number alone is not proof of shape: a downstream fork may
  // claim the same number for a face this plugin cannot actually drive.
  // Probe the exact members index.tsx calls before trusting the number.
  const face = presentation as { requestCapacity?: unknown; state?: unknown }
  if (typeof face.requestCapacity !== 'function') {
    return {
      disabled: true,
      reason: 'incompatible DeepSeek Harness presentation',
      detected: 'presentation.requestCapacity absent',
      supported: supportedLabel,
    }
  }
  const state = face.state as { getSnapshot?: unknown } | undefined
  if (typeof state !== 'object' || state === null || typeof state.getSnapshot !== 'function') {
    return {
      disabled: true,
      reason: 'incompatible DeepSeek Harness presentation',
      detected: 'presentation.state.getSnapshot absent',
      supported: supportedLabel,
    }
  }
  let snapshot: unknown
  try {
    snapshot = (state.getSnapshot as () => unknown)()
  } catch {
    return {
      disabled: true,
      reason: 'incompatible DeepSeek Harness presentation',
      detected: 'state.getSnapshot() threw',
      supported: supportedLabel,
    }
  }
  const snapshotFace = snapshot as { visible?: unknown; capacity?: unknown } | undefined
  if (typeof snapshotFace !== 'object' || snapshotFace === null || !Array.isArray(snapshotFace.visible)) {
    return {
      disabled: true,
      reason: 'incompatible DeepSeek Harness presentation',
      detected: 'snapshot.visible not an array',
      supported: supportedLabel,
    }
  }
  if (typeof snapshotFace.capacity !== 'number') {
    return {
      disabled: true,
      reason: 'incompatible DeepSeek Harness presentation',
      detected: 'snapshot.capacity not a number',
      supported: supportedLabel,
    }
  }
  return { disabled: false }
}

/** Workbench product limit: focused session plus one beside pane. */
export const WORKBENCH_VISIBLE_CAPACITY = 2 as const

/** The member a disabled verdict withholds from every module below. */
const PRESENTATION = 'presentation'

/**
 * Read-through view of `source`, built on a private empty target.
 *
 * A Proxy is not allowed to contradict the invariants of its own target, so a
 * view whose target IS the host object cannot answer `undefined` for a member
 * the host installed as a non-writable, non-configurable own data property,
 * cannot report that member absent from `has`, and cannot hand back a
 * method bound to the source (a bound function is a different value than the
 * target's own). Each of those throws a TypeError at the access site, and
 * hosts reach that state with nothing more exotic than
 * `Object.freeze(sessions)` or
 * `Object.defineProperty(sessions, 'presentation', { value, writable: false,
 * configurable: false })` — turning the graceful stock degradation this view
 * exists to provide into a crash on every read.
 *
 * A fresh empty target owns no properties and stays extensible, so it
 * constrains no trap: every trap below answers for `source` instead. The
 * descriptors reported for it are marked configurable precisely because the
 * target genuinely does not own them, which is what keeps `Object.keys`,
 * spread and `in` both accurate and legal. This is a read path only; writes
 * land on the private target and are not forwarded.
 * @param source - the real object every trap answers for.
 * @param hidden - own member withheld from `has` and key enumeration, if any.
 * @param read - resolves `get`; it receives `hidden` too and decides its value.
 * @returns a view of `source` that cannot throw a proxy-invariant TypeError.
 */
function blindView<T extends object>(
  source: T,
  hidden: string | undefined,
  read: (property: string | symbol) => unknown,
): T {
  return new Proxy({}, {
    get: (_target, property) => read(property),
    has: (_target, property) => property !== hidden && Reflect.has(source, property),
    ownKeys: () => Reflect.ownKeys(source).filter((key) => key !== hidden),
    getOwnPropertyDescriptor: (_target, property) => {
      if (property === hidden) return undefined
      const descriptor = Reflect.getOwnPropertyDescriptor(source, property)
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true }
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(source),
  }) as T
}

/**
 * Read one member off the real object, binding methods back to it so a host
 * implemented as a class instance keeps working through a view — including
 * one whose methods touch true private fields.
 */
function boundMember(source: object, property: string | symbol): unknown {
  const value = Reflect.get(source, property)
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(source) : value
}

/**
 * Hide `sessions.presentation` behind a read-through view of the host
 * service.
 *
 * This is the enforcement half of the startup verdict. The guard above is
 * the only place that decides whether this build can drive a host's
 * presentation face, but it used to be the only place that ACTED on that
 * decision: the downstream capability gates (`sideChatServices` in
 * harness-adapter.ts, `editionPresentation` in chat-actions.ts) re-probe the
 * same face with a strictly weaker predicate — protocol plus
 * `state.getSnapshot`/`open`/`focus` — and neither one checks
 * `requestCapacity`, that the snapshot actually carries a `visible` array
 * and a numeric `capacity`, or that `getSnapshot()` returns at all instead
 * of throwing. A host that fails the guard on any of those could still hand
 * forked side chat and fresh chat a face this release was never tested
 * against: the banner said "disabled", capacity was never requested, and a
 * side-chat click still forked a child and displaced the source Pane.
 * Rather than duplicating the probe into each gate (where the two copies
 * would drift apart again), a disabled verdict removes the face from what
 * every downstream module can see, so all of them degrade exactly the way
 * they do on a stock Harness that never had a presentation face.
 *
 * Members are read straight off the original object and methods are bound
 * back to it, so a host service implemented as a class instance keeps
 * working through the view — including one holding true private fields.
 * @param sessions - the host `sessions` service, whatever shape it has.
 * @returns a view of `sessions` where `presentation` reads as absent.
 */
export function presentationBlindSessions(sessions: unknown): unknown {
  if (typeof sessions !== 'object' || sessions === null) return sessions
  return blindView(sessions, PRESENTATION, (property) =>
    property === PRESENTATION ? undefined : boundMember(sessions, property))
}

/**
 * A view of the plugin context whose `get('sessions')` resolves to
 * `blindSessions` — how `presentationBlindSessions` reaches the modules that
 * resolve their own services from `ctx` (applyShortcuts, applyNavigator)
 * rather than receiving a bundle from `apply()`. Every other member is
 * forwarded to the real context untouched — including a `presentation` of its
 * own, which on a context is a different member than the one the sessions
 * view withholds.
 * @param ctx - the real client context.
 * @param blindSessions - the value `get('sessions')` must resolve to.
 * @returns a context view usable anywhere the real one is.
 */
export function presentationBlindContext<T extends object>(ctx: T, blindSessions: unknown): T {
  return blindView(ctx, undefined, (property) => {
    const value = boundMember(ctx, property)
    if (property !== 'get' || typeof value !== 'function') return value
    const get = value as (name: string) => unknown
    return (name: string) => name === 'sessions' ? blindSessions : get(name)
  })
}
