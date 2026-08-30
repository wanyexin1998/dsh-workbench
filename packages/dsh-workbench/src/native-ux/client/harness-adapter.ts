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
  /** Scope-addressed queued prompt used only by More Details side chat. */
  send?(text: string): Promise<void>
  /** Public per-session input resolver used by the injected draft adapter. */
  readonly input?: {
    for(scope: SessionScope): SessionInputFace
  }
}

export interface SessionInputReferenceFace {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance?: 'session' | 'file' | 'folder'
  readonly clipboardText: string
}

export interface SessionInputFace {
  readonly state: ObservableSnapshotFace<{ readonly draft: string; readonly draftRev: number }>
  setDraft(text: string): void
  insertReference(
    reference: SessionInputReferenceFace,
    span: { readonly start: number; readonly end: number; readonly draftRev: number },
  ): boolean
}

/** Scope handle for one session: the plugin reads only `conversation`. */
export interface SessionScope {
  get(name: 'conversation'): ConversationFace | undefined
}

/** Minimal observable-store face shared by the Sessions and Workspaces seams. */
export interface ObservableSnapshotFace<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}

/** Session-list row fields used by the fresh-chat reuse policy. */
export interface SessionSummaryFace {
  readonly id: string
  readonly agentPreset?: string
  readonly blank: boolean
  readonly updatedAt: number
}

/** Session-list snapshot fields used by chat creation and navigation. */
export interface SessionListSnapshotFace {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionSummaryFace | undefined>>
  readonly current?: string
}

/** Workspace-list row fields used by the chat workspace resolution chain. */
export interface WorkspaceSummaryFace {
  readonly workspaceId: string
  /** Current Harness name; `name` keeps the adapter compatible with older hosts. */
  readonly title?: string
  readonly name?: string
  readonly sessionIds: readonly string[]
}

export interface WorkspaceListSnapshotFace {
  readonly items: readonly WorkspaceSummaryFace[]
}

export interface WorkspacesService {
  readonly list: ObservableSnapshotFace<WorkspaceListSnapshotFace>
}

export interface RpcErrorFace {
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

export type RpcResultFace<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RpcErrorFace }

/** The connection seam needed to create one chat-preset Session. */
export interface ConnectionService {
  readonly api: {
    readonly sessions: {
      create(payload: { workspaceId: string; agentPreset: 'chat' }): Promise<{
        readonly result: RpcResultFace<{ readonly sessionId: string; readonly agentPreset?: string }>
      }>
    }
  }
}

export interface SessionsService {
  scope(sessionId: string): SessionScope | undefined
  /** Fork a completed-turn prefix; resolution returns the retained child id. */
  fork?(options: { sessionId: string; atSeq?: number; increaseTitle?: boolean }): Promise<string>
  presentation?: {
    /** Protocol 2 is the Edition split-pane contract; absent means stock. */
    readonly protocol?: number
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
    state: {
      getSnapshot(): { visible?: readonly string[]; focused?: string; capacity?: number }
      subscribe?(fn: () => void): () => void
    }
    open?(id: string, options?: { readonly disposition?: 'replace-focused' | 'beside' }): void
    focus?(id: string): void
    close(id: string): void
  }
  /**
   * native-actions-pivot (workbench.session.new): mirrors the always-public
   * `ISessions.clear(): void` — "Clear the current selection into the
   * no-session view state" — verified at the pinned 0.1.1-rc.2 store:
   * `@deepseek-ai/dsh-client-runtime/lib/types/client/contract/
   * sessions.d.ts:67-68`. This is the SAME fallback the fork's own
   * `WorkspaceRuntime.startSession()` verb reaches for when it has no
   * Workspace context to create into — NIT 6 (Opus review, round 2)
   * corrected citation: `packages/client/runtime/src/client/workspaces/
   * service.ts:172-183` (fork source): "...with no Workspace at all, clear
   * the selection into the New Session view state" — `ISessions.create(...)`
   * itself is NOT on the public `ISessions` interface (only on the concrete
   * `SessionRuntime` class), so `clear()` is the narrowest honest path to
   * "start a new session" reachable through a plugin's own `ctx.sessions`.
   *
   * NIT 5 (Opus review, round 2): why not call `startSession()` itself (the
   * sidebar 新会话 button's exact verb, per that method's own doc comment —
   * service.ts:168, "the shared New Session action behind the shell entry
   * points") instead of reimplementing its no-workspace fallback branch?
   * Because it lives on `WorkspaceRuntime` (`ctx.workspaces` — provided via
   * `ctx.reflect.provide('workspaces', ...)`, service.ts:74), and this
   * package's `dsh.client.inject` list (`package.json`) does not declare the
   * fork's workspace-providing plugin — only `dsh-client-runtime`,
   * `dsh-client-ui-slots`, `dsh-client-locale`, `dsh-client-ui-layout`,
   * `dsh-client-ui-settings`, `dsh-client-ui-conversation`. `ctx.workspaces`
   * is simply not a seam this plugin can reach.
   * User-visible consequence: Ctrl+N always lands on the plain New-Session
   * (no-Workspace) home, exactly like `startSession()`'s own no-workspace
   * branch — it never resolves or connects a Workspace the way the sidebar
   * button's full `startSession()` call additionally does when one is
   * available (explicit -> current session's -> most-recent Workspace).
   * Optional: a `sessions` double predating this action (every existing test
   * fixture) legitimately lacks it.
   */
  clear?(): void
  /**
   * native-actions-pivot (workbench.session.previous): mirrors the
   * always-public `ISessions.open(id): void` — "Select a session as
   * current" — verified at the pinned 0.1.1-rc.2 store: `.../contract/
   * sessions.d.ts:31-35`. Unlike the fork-only `presentation.open`, this
   * verb requires no split-pane presentation face at all: `SessionRuntime.
   * open()` itself is implemented as `openPresentation(id,
   * 'replace-focused')`, so calling the plain public `open(id)` produces
   * the exact same session switch on a compatible Harness, and is the ONLY
   * switch verb a stock Harness needs to expose. Optional for the same
   * pre-existing-fixture reason as `clear` above.
   */
  open?(id: string): void
  /**
   * MEDIUM 1 (Opus review, round 2 of native-actions-pivot): the tracker
   * feed for workbench.session.previous. Mirrors the always-public
   * `ISessions.list: ObservableSnapshot<SessionListState>` — verified at the
   * pinned 0.1.1-rc.2 store: `.../contract/sessions.d.ts:22` declares it
   * unconditionally (no split-pane compatibility required, unlike
   * `presentation` above); `SessionListState.current: SessionId | undefined`
   * sits at `.../sessions/service.d.ts:67-85` (line 72). The original
   * implementation fed the tracker from `presentation.state` instead — a
   * FORK-ONLY face genuinely absent from this pinned `ISessions` (it has no
   * `presentation` member at all) — so on a real stock Harness the action
   * registered (its OTHER gate, `open`, is stock-public) but the tracker was
   * never fed anything, making Alt+Q permanently inert. `list` is the
   * correct single feed instead: traced against the fork source
   * (`packages/client/runtime/src/client/sessions/service.ts`), `list.current`
   * and `presentation.focused` never diverge — every mutation that changes
   * `focused` (`openPresentation`/`focusPresentation`, backing
   * `presentation.open`/`.focus`) ALSO calls `this.manager.select(id)` in
   * the same step (service.ts's own `openPresentation`/`focusPresentation`
   * methods), and `projectList()` — the one place `list.current` is
   * written — re-derives `presentation.focused` FROM `current` right after
   * (`current !== undefined -> focus/open transition onto current`). They
   * are eventually-consistent projections of the SAME underlying selection,
   * not two independent facts, so this one feed is correct on both the fork
   * (split-pane) and a stock Harness (no `presentation` at all) — no
   * fork-preferred/list-fallback duality needed. Optional for the same
   * pre-existing-fixture reason as `clear`/`open` above.
   */
  list?: {
    getSnapshot(): SessionListSnapshotFace | { current?: string }
    subscribe?(fn: () => void): () => void
  }
}

/**
 * The cross-plugin panel-action face (`ctx.layout`) — narrowed to the seams
 * this plugin actually consumes. Mirrors `ILayout`, verified at the pinned
 * 0.1.1-rc.2 store: `@deepseek-ai/dsh-client-ui-layout/lib/types/client/
 * service.d.ts` declares exactly `toggleSidebar()` / `openDetails()` /
 * `closeDetails()` — no verb exists there (or anywhere else this package
 * depends on) to open the Settings surface.
 */
export interface LayoutService {
  toggleSidebar(): void
  /**
   * native-actions-pivot (workbench.settings.open): speculative — NO public
   * seam exists today. Investigated and ruled out: `ILayout` (above) has no
   * settings verb; the Settings shell (`sidebar.settings` occupant,
   * `@deepseek-ai/dsh-client-ui-settings-general`, not a declared dependency
   * of this package) renders its own modal open/close as component-local
   * React `useState` with zero external control (verified at both the fork
   * source — `SettingsRoot.tsx`'s own doc comment: "No store is registered —
   * modal open state ... is component-local viewing state" — and the pinned
   * `dsh-client-ui-settings-general` `SettingsRoot.d.ts`, which exposes no
   * prop for it). `openSettings` names the verb such a future seam would
   * most naturally take (mirroring `openDetails`/`closeDetails`'s own
   * naming), so the action activates the day one ships, with zero further
   * plugin changes — see `settingsOpenOn` in shortcuts.tsx for the
   * registration gate this backs. Until then this is always `undefined` in
   * production (fail-soft, same outward behavior as `favoriteAgent`), but
   * a test double may supply it to exercise the registration path.
   */
  openSettings?(): void
}

/** Aggregate of the injected services the plugin uses. */
export interface HarnessServices {
  connection?: ConnectionService
  layout?: LayoutService
  sessions?: SessionsService
  workspaces?: WorkspacesService
}

/** Capability-complete service bundle required by `workbench.chat.open`. */
export interface ChatActionServices {
  readonly connection: ConnectionService
  readonly sessions: Omit<SessionsService, 'list' | 'open'> & {
    readonly list: ObservableSnapshotFace<SessionListSnapshotFace>
    open(sessionId: string): void
  }
  readonly workspaces: WorkspacesService
}

/** Capability-complete Edition bundle required by forked side chat. */
export interface SideChatServices {
  readonly sessions: SessionsService & {
    scope(sessionId: string): SessionScope | undefined
    fork(options: { sessionId: string; atSeq?: number; increaseTitle?: boolean }): Promise<string>
    readonly presentation: NonNullable<SessionsService['presentation']> & {
      readonly protocol: 2
      open(id: string, options?: { readonly disposition?: 'replace-focused' | 'beside' }): void
      focus(id: string): void
    }
  }
}

/**
 * Narrow the optional host services into the exact fresh-chat capability.
 * Presentation is intentionally not part of this gate: stock Harness must
 * register the action and use `sessions.open()`.
 */
export function chatActionServices(services: HarnessServices): ChatActionServices | undefined {
  const create = services.connection?.api?.sessions?.create
  const sessionList = services.sessions?.list
  const workspaceList = services.workspaces?.list
  if (typeof create !== 'function'
    || typeof services.sessions?.open !== 'function'
    || typeof sessionList?.getSnapshot !== 'function'
    || typeof sessionList.subscribe !== 'function'
    || typeof workspaceList?.getSnapshot !== 'function') return undefined
  return services as ChatActionServices
}

/** Presentation is mandatory here: stock Harness must hide side actions. */
export function sideChatServices(services: HarnessServices): SideChatServices | undefined {
  const sessions = services.sessions
  const presentation = sessions?.presentation
  if (typeof sessions?.scope !== 'function'
    || typeof sessions.fork !== 'function'
    || presentation?.protocol !== 2
    || typeof presentation.state?.getSnapshot !== 'function'
    || typeof presentation.open !== 'function'
    || typeof presentation.focus !== 'function') return undefined
  return { sessions: sessions as SideChatServices['sessions'] }
}

/**
 * Resolve a session id to the focused pane, or `undefined` when nothing is
 * focused / the presentation face is absent or malformed. Shared by every
 * L0 action in shortcuts.tsx so each reads the exact same defensive path
 * instead of separate copies that could drift — see the doc comment this
 * carried at its original site (shortcuts.tsx) for the full fail-closed
 * rationale: `presentation` is a
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
 * Subscribe to the focused-PANE store, if `presentation.state` actually
 * exposes a `subscribe` method (see the `subscribe` doc comment on
 * `SessionsService.presentation.state` above for the verified
 * `ObservableSnapshot` contract this is asserted to satisfy). Fork-only (no
 * `presentation` face on a stock Harness — see `SessionsService.list`'s own
 * doc comment) — currently unused by any L0 action (workbench.session.
 * previous's tracker moved to `subscribeCurrentSessionId`/`list` at MEDIUM 1,
 * Opus review round 2, precisely because a stock Harness needs that action
 * to actually work). Kept as the paired subscribe-side of `focusedSessionId`
 * for the same fork-only-DOM-pane-scoping reason that function is kept: a
 * future feature that needs to react to PANE focus changes specifically
 * (not just "which session is current" — the two differ only in a
 * split-pane fork, per `SessionsService.list`'s divergence trace) has this
 * seam ready without re-deriving it.
 *
 * Same defensive-narrowing shape as `focusedSessionId`: a missing or
 * non-function `subscribe`, or a `subscribe` call that itself throws,
 * degrades to "no subscription available" (a no-op unsubscribe) rather
 * than throwing — a caller that never receives a real subscription simply
 * gets no tracking (a stock Harness without the split-pane presentation
 * face, for instance), not a crash.
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

/**
 * MEDIUM 1 (Opus review, round 2 of native-actions-pivot): resolve the
 * current session id from the stock-public `SessionsService.list` snapshot
 * (`SessionListState.current` — see that field's doc comment above for the
 * full divergence trace against the fork source, and why this single feed
 * is correct on both stock and fork Harnesses). Deliberately a SEPARATE
 * function from `focusedSessionId` above, not a shared implementation:
 * `focusedSessionId`/`focusedPaneScope` back DOM pane-scoping (composer
 * focus, jump-latest, session-stop, navigator toggle), where "no
 * `presentation` face" correctly means "fall back to document scope" — a
 * different, already-correct degradation this function must not disturb.
 * Same defensive-narrowing shape as `focusedSessionId`: a missing/malformed
 * `list`, or a `getSnapshot` that itself throws, degrades to "no current
 * session known" rather than throwing inside a keydown handler or a store
 * subscription callback.
 */
export function currentSessionId(services: HarnessServices): string | undefined {
  const list: unknown = services.sessions?.list
  if (typeof list !== 'object' || list === null) return undefined
  const getSnapshot = (list as { getSnapshot?: unknown }).getSnapshot
  if (typeof getSnapshot !== 'function') return undefined
  let snapshot: unknown
  try {
    snapshot = getSnapshot.call(list)
  } catch {
    return undefined
  }
  return typeof snapshot === 'object' && snapshot !== null ? (snapshot as { current?: string }).current : undefined
}

/**
 * Subscribe to the session-list store, if `list` actually exposes a
 * `subscribe` method — the `list`-feed counterpart of
 * `subscribeFocusedSessionId` above, backing the SAME most-recent-two
 * session tracker (workbench.session.previous) that function used to feed
 * before MEDIUM 1. Same fail-soft contract: a missing/non-function
 * `subscribe`, or one that itself throws, degrades to a no-op unsubscribe
 * rather than throwing — a caller that never receives a real subscription
 * simply gets no tracking, not a crash.
 * @param services - the harness services bundle.
 * @param listener - invoked (with no arguments, per the store's own
 *   `subscribe(fn: () => void)` contract) on every store notification; the
 *   caller re-reads `currentSessionId(services)` itself to learn the new
 *   value — this function does not diff or debounce.
 * @returns an unsubscribe function; always safe to call, even when no real
 *   subscription was established.
 */
export function subscribeCurrentSessionId(services: HarnessServices, listener: () => void): () => void {
  const list: unknown = services.sessions?.list
  if (typeof list !== 'object' || list === null) return () => {}
  const subscribe = (list as { subscribe?: unknown }).subscribe
  if (typeof subscribe !== 'function') return () => {}
  try {
    const unsubscribe: unknown = subscribe.call(list, listener)
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
  get(name: 'connection' | 'layout' | 'sessions' | 'workspaces'): unknown
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
   * parameters is a valid implementation of one declared with more.
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
    connection: ctx.get('connection') as ConnectionService | undefined,
    layout: ctx.get('layout') as LayoutService | undefined,
    sessions: ctx.get('sessions') as SessionsService | undefined,
    workspaces: ctx.get('workspaces') as WorkspacesService | undefined,
  }
}
