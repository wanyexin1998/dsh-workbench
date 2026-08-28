// GA-040 (Roadmap §9A.1) — the plugin's minimal typed contract for the
// harness boundary. The harness is in RC and its API will drift, so we
// deliberately do NOT replicate the full SDK type tree: only the seams this
// plugin actually consumes are named. `ctx.get()` returns `unknown` at the
// boundary and is narrowed exactly once, at the few sites below, so a
// signature change surfaces at compile time here instead of as a runtime
// `any`-propagated crash throughout the business layer.
//
// Slot wiring stays on ctx.slots.inject/register (a slot's existence is not
// probed via an invented ctx.slots.has / service.capabilities — §9A.1).

/** Conversation face exposed per session (the only methods the plugin calls). */
export interface ConversationFace {
  cancel?(): Promise<unknown> | unknown
  loadOlder?(): Promise<void> | void
}

/** Scope handle for one session: the plugin reads only `conversation`. */
export interface SessionScope {
  get(name: 'conversation'): ConversationFace | undefined
}

/**
 * W2.2: the session face reached through `ISessions.binding(id).session` —
 * narrowed to the single verb the host-command direct-execute path calls.
 * Mirrors `SessionFace.command` — verified against the pinned 0.1.1-rc.2
 * store: `@deepseek-ai/dsh-client-runtime/lib/types/client/contract/
 * session.d.ts:81-89` (`ISession.command(line): Promise<RemoteResult<{
 * matched: boolean }>>`, JSDoc: "pure admission semantics" — equivalent to
 * typing the line in the composer and pressing Enter).
 */
export interface SessionBindingFace {
  readonly session: {
    command(line: string): Promise<RemoteResult<{ matched: boolean }>>
  }
}

export interface SessionsService {
  scope(sessionId: string): SessionScope | undefined
  presentation?: {
    /**
     * `state` is asserted to satisfy `ObservableSnapshot<T>` — verified at
     * the pinned 0.1.1-rc.2 store: `@deepseek-ai/dsh-client-runtime/lib/
     * types/client/contract/store.d.ts:4-7` (`{getSnapshot(): T;
     * subscribe(fn: () => void): () => void}` — "Session objects and
     * snapshot stores both satisfy it"). `subscribe` is optional here
     * (unlike the verified contract) for the same reason `presentation`
     * itself is optional one level up: this whole face is an undocumented,
     * RC-only surface with no published `.d.ts` backing it, so every
     * consumer (focusedSessionId, subscribeFocusedSessionId below) treats
     * a missing/malformed member as absent rather than a contract breach.
     */
    state: { getSnapshot(): { focused?: string }; subscribe?(fn: () => void): () => void }
    close(id: string): void
  }
  /**
   * W2.2: resolve the stable session binding (direct-execute path). Mirrors
   * `ISessions.binding(id): SessionBinding | undefined` — verified at
   * `.../dsh-client-runtime/lib/types/client/contract/sessions.d.ts:126`,
   * `SessionBinding.session: SessionFace` at `.../sessions/service.d.ts:
   * 109-114`. Optional (unlike `scope`, which every existing L0 action
   * already depends on): a `sessions` double that predates W2 — including
   * every existing test fixture in this package — legitimately lacks it,
   * and that must degrade the host direct-execute path locally rather than
   * be treated as a broken `sessions` service.
   */
  binding?(id: string): SessionBindingFace | undefined
}

export interface LayoutService {
  toggleSidebar(): void
}

/**
 * W2.1: one command's discovery metadata, as returned by the Host's
 * `commands` registry. Hand-rolled rather than imported from
 * `@deepseek-ai/dsh-commands` (not a declared dependency of this package —
 * only transitively reachable through the pnpm store via
 * `@deepseek-ai/dsh-api-remotes` — so importing its types here would be an
 * undeclared, unverifiable-at-install-time coupling). Mirrors
 * `CommandDescriptor` verified at the pinned 0.1.1-rc.2 store:
 * `@deepseek-ai/dsh-commands/lib/types/types.d.ts` (the `Handler-free
 * immutable command view returned to UI adapters` interface).
 */
export interface HostCommandInputDescriptor {
  readonly hint: string
  readonly images?: boolean
}

export interface HostCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly input?: HostCommandInputDescriptor
}

/**
 * Mirrors `@deepseek-ai/dsh-typert-protocol`'s `RemoteResult<T>` — verified
 * at the pinned 0.1.1-rc.2 store: `lib/types/types.d.ts:51-57`. Every
 * generated Remote method (and `ISession.command`) resolves to this shape;
 * hand-rolled here for the same undeclared-dependency reason as
 * `HostCommandDescriptor` above.
 */
export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/**
 * The `remote.commands` mounted sub-service (`ctx.get('remote.commands')`).
 * Verified: `@deepseek-ai/dsh-commands/lib/typert.remote-client.d.ts:1-26`
 * declares `commands/list(agentId: SessionId): Promise<RemoteResult<
 * readonly CommandDescriptor[]>>` on `TypertRemoteNamespace$636f6d6d616e6473`
 * (the `commands` namespace), which `@deepseek-ai/dsh-api-gateway`'s client
 * half mounts as an independent Cordis service keyed `remote.<namespace>`
 * (`lib/types/client/index.js:96-124`, `remoteServiceKey(name)='remote.'+
 * name`) — i.e. `remote.commands`, exactly the key `dsh-client-ui-commands`
 * (a sibling first-party consumer) lists in its own `inject` array.
 */
export interface RemoteCommandsFace {
  list(agentId: string): Promise<RemoteResult<readonly HostCommandDescriptor[]>>
}

/**
 * The top-level `remote` service (`ctx.get('remote')`) — narrowed to the
 * one member W2.1 needs: subscribing to the `commands/change` forwarded
 * event. Verified: `commands/change` is in `API_REMOTE_FORWARDED_EVENTS`
 * (`@deepseek-ai/dsh-api-remotes/lib/types/remote-events.d.ts:16`), and
 * `$on<Event extends TypertRemoteEvent>(event, listener): () => void` is
 * declared on `TypertClientRemote`
 * (`@deepseek-ai/dsh-typert-protocol/lib/types/types.d.ts:202`).
 */
export interface RemoteFace {
  $on(event: 'commands/change', listener: () => void): () => void
}

/** Aggregate of the injected services the plugin uses. */
export interface HarnessServices {
  layout?: LayoutService
  sessions?: SessionsService
}

/**
 * Resolve a session id to the focused pane, or `undefined` when nothing is
 * focused / the presentation face is absent or malformed. Shared by
 * shortcuts.tsx (L0 actions) and host-commands.ts (W2 host-command actions)
 * so both read the exact same defensive path instead of two copies that
 * could drift — see the doc comment this carried at its original site
 * (shortcuts.tsx) for the full fail-closed rationale: `presentation` is a
 * host-provided, RC-only face whose `state`/`getSnapshot` shape is asserted
 * by `HarnessServices` but not guaranteed at runtime, so this accessor must
 * degrade to "no focused session" on a malformed or throwing
 * `state`/`getSnapshot` rather than throw inside a keydown handler.
 */
export function focusedSessionId(services: HarnessServices): string | undefined {
  const state: unknown = services.sessions?.presentation?.state
  if (typeof state !== 'object' || state === null) return undefined
  const getSnapshot = (state as { getSnapshot?: unknown }).getSnapshot
  if (typeof getSnapshot !== 'function') return undefined
  let snapshot: unknown
  try {
    snapshot = getSnapshot.call(state)
  } catch {
    return undefined
  }
  return typeof snapshot === 'object' && snapshot !== null ? (snapshot as { focused?: string }).focused : undefined
}

/**
 * Subscribe to the focused-session store, if `presentation.state` actually
 * exposes a `subscribe` method (see the `subscribe` doc comment on
 * `SessionsService.presentation.state` above for the verified
 * `ObservableSnapshot` contract this is asserted to satisfy). Fixes W2's
 * cold-start gap: without this, the only way to learn "a session is now
 * focused" was polling `focusedSessionId()` at a fixed enumeration moment,
 * which reads `undefined` before the session list settles and never
 * refires on its own.
 *
 * Same defensive-narrowing shape as `focusedSessionId`: a missing or
 * non-function `subscribe`, or a `subscribe` call that itself throws,
 * degrades to "no subscription available" (a no-op unsubscribe) rather
 * than throwing — a caller that never receives a real subscription simply
 * keeps working exactly as it did before this function existed (driven
 * only by whatever other resync triggers it already has, e.g.
 * `commands/change`).
 * @param services - the harness services bundle.
 * @param listener - invoked (with no arguments, per the store's own
 *   `subscribe(fn: () => void)` contract) on every store notification; the
 *   caller re-reads `focusedSessionId(services)` itself to learn the new
 *   value — this function does not diff or debounce.
 * @returns an unsubscribe function; always safe to call, even when no real
 *   subscription was established.
 */
export function subscribeFocusedSessionId(services: HarnessServices, listener: () => void): () => void {
  const state: unknown = services.sessions?.presentation?.state
  if (typeof state !== 'object' || state === null) return () => {}
  const subscribe = (state as { subscribe?: unknown }).subscribe
  if (typeof subscribe !== 'function') return () => {}
  try {
    const unsubscribe: unknown = subscribe.call(state, listener)
    return typeof unsubscribe === 'function' ? (unsubscribe as () => void) : () => {}
  } catch {
    return () => {}
  }
}

/** Bound third-party settings scope (shortcut persistence reads/writes this). */
export interface SettingsScopeFace {
  getSnapshot(): unknown
  subscribe(fn: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

export interface LocaleService {
  register(ns: string, dicts: Record<string, unknown>): void
  bind(ns: string): (key: string, vars?: Record<string, string>) => string
}

export interface SlotDef {
  name: string
  id: string
  order?: number
  label?: () => string
  inject?: () => Record<string, unknown>
}

export interface SlotService {
  register(def: SlotDef, component: unknown): void
  inject(slot: string, fn: () => void): void
}

/**
 * The plugin context surface the client consumes. `get` returns `unknown`:
 * the harness injects untyped services, and every consumer narrows it once
 * (via resolveHarnessServices or a local cast) rather than trusting `any`.
 */
export interface HarnessContext {
  get(name: 'layout' | 'sessions' | 'remote' | 'remote.commands'): unknown
  locale: LocaleService
  slots: SlotService
  settingsScope: { bind(options: { namespace: string }): SettingsScopeFace }
  effect(fn: () => void, label?: string): void
  on(event: 'dispose', fn: () => void): void
  /**
   * Finding 2 (smoke test) — the active-locale-switch signal. Verified
   * against the pinned 0.1.1-rc.2 store:
   * `@deepseek-ai/dsh-client-locale/lib/types/client/index.d.ts:44-58`
   * declares this as a genuine cordis `Context` event (`declare module
   * '@deepseek-ai/cordis' { interface Events { 'locale/change'(snapshot):
   * void } }`), fired ONLY when `LocaleRuntime.setLocale` actually changes
   * the active locale — unlike `LocaleService`'s (not yet widened here)
   * underlying `LocaleRuntime.subscribe`, which also fires on every
   * dictionary `register()` call (every feature's own boot-time namespace
   * registration), this is the precise "language changed" signal, not a
   * broader "something about locale state changed" one. The real cordis
   * `on()` calls the listener with a `LocaleSnapshot` argument; the listener
   * type here omits it (unused by any consumer) — a function with fewer
   * parameters is a valid implementation of one declared with more, the same
   * narrowing `RemoteFace.$on` already applies to `commands/change` above.
   * Return type is `(() => void) | undefined`, not a bare `() => void`: the
   * real cordis `on()` always returns a disposer, but a test double built
   * from a plain `vi.fn()` (no explicit return) resolves to `undefined` at
   * runtime — LOW 3 (Opus review, round 2) caught the previous non-optional
   * signature making the caller's `typeof localeChangeUnsub === 'function'`
   * defensive check statically dead code. Honest here, so that check is a
   * real, reachable branch rather than a lie the type system told the
   * caller was unnecessary.
   */
  on(event: 'locale/change', fn: () => void): (() => void) | undefined
}

/**
 * Collapse the injected service seams into a typed bundle. The single
 * narrowing point for ctx.get() — the business layer never calls ctx.get()
 * with `any` again.
 */
export function resolveHarnessServices(ctx: HarnessContext): HarnessServices {
  return {
    layout: ctx.get('layout') as LayoutService | undefined,
    sessions: ctx.get('sessions') as SessionsService | undefined,
  }
}

/** Runtime shape guards for the two `remote` seams — a value that resolves
 * (ctx.get() returned something) but does not actually look like the face we
 * need is treated the same as absent (W2.1 fail-soft: "absent or malformed"
 * both mean zero host actions, never a throw). */
function isRemoteFace(value: unknown): value is RemoteFace {
  return typeof value === 'object' && value !== null && typeof (value as { $on?: unknown }).$on === 'function'
}
function isRemoteCommandsFace(value: unknown): value is RemoteCommandsFace {
  return typeof value === 'object' && value !== null && typeof (value as { list?: unknown }).list === 'function'
}

/**
 * W2.1: narrow `ctx.get('remote')` / `ctx.get('remote.commands')` into the
 * typed bundle host-commands.ts consumes — the same narrow, single-
 * narrowing-point pattern as {@link resolveHarnessServices}, kept as its own
 * function (rather than folded into that one) so a host without the remote
 * command bridge mounted at all pays no extra `ctx.get()` calls through the
 * L0 path, and so `resolveHarnessServices`'s existing "reads exactly the
 * seams it uses" test stays meaningful for its own two seams.
 */
export function resolveRemoteServices(ctx: HarnessContext): { remote?: RemoteFace; remoteCommands?: RemoteCommandsFace } {
  const remote = ctx.get('remote')
  const remoteCommands = ctx.get('remote.commands')
  return {
    remote: isRemoteFace(remote) ? remote : undefined,
    remoteCommands: isRemoteCommandsFace(remoteCommands) ? remoteCommands : undefined,
  }
}
