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
  /**
   * 0.1.2-rc.1 起宿主的列表行**不再带这个字段**：`SessionSummary`
   * （`@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/
   * service.d.ts:32-55`）只剩 id / title / displayTitle / cwd / parentId /
   * origin / running / completed / blank / updatedAt / projectionValues，
   * 0.1.1-rc.2 上还在的 `agentPreset?: string`（旧 runtime 包
   * `lib/types/client/sessions/service.d.ts:42`）与配套的
   * `ISessions.noteAgentPreset` 一起被删掉了。
   *
   * 后果是**当日空白 chat 会话的复用（{@link reusableChatSessionId}）在
   * 0.1.2-rc.1 上恒不命中**——字段永远是 undefined，过滤条件
   * `agentPreset !== 'chat'` 于是永远为真，随手问每次都新建一个会话，而不是
   * 接着用今天那个还空着的。这是失败方向正确的退化（不会误用别的预设的会话），
   * 不是崩溃，所以这里保持可选、保持这条过滤：等我们决定换一个"这是不是 chat
   * 会话"的判据（宿主还没有替代品）再动它。
   */
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
  /**
   * Most recently active Workspace — the last resort of the fresh-chat
   * workspace resolution chain (`resolveChatWorkspace`), used when no source
   * Session was captured at all (zero-Pane home state: nothing focused and
   * `sessions.list.current` empty, e.g. right after `sessions.clear()`).
   *
   * 0.1.2-rc.1 起宿主**不再投影这个字段**。它在 0.1.1-rc.2 上是真实存在的
   * （旧 runtime 包 `lib/types/client/workspaces/service.d.ts:24-25`：
   * `WorkspaceListState.recentWorkspaceId: WorkspaceId | undefined`）；
   * 搬家之后的 workspace 快照是
   * `@deepseek-ai/dsh-api-workspace-controller/lib/types/client/model.d.ts:9-16`
   * 的 `WorkspaceSnapshot`，只有 items / archivedSessionIds / state / phase /
   * error 五个字段，没有任何"最近活跃 Workspace"的投影。
   *
   * 后果：**零 Pane 首页那一档解析在 0.1.2-rc.1 上恒不命中**，随手问会落到
   * `no-workspace` 提示。这正是这个字段一开始就写成可选的原因——宿主不投影就
   * 退化成"解析不出 Workspace"（fail-closed），绝不随便挑一个。要把这一档接
   * 回来得换一个判据（`WorkspaceView` 现在带 `updatedAt`，可以按它取最近的），
   * 那是产品决定，不属于这次版本迁移。
   */
  readonly recentWorkspaceId?: string
}

export interface WorkspacesService {
  readonly list: ObservableSnapshotFace<WorkspaceListSnapshotFace>
}

/**
 * One Remote call's failure. Mirrors `RemoteError`
 * （`@deepseek-ai/dsh-typert-protocol/lib/types/remote-error.d.ts:10-22`）：
 * 一个带稳定 `code` 与结构化 `details` 的真 Error，判别只看 `code`。
 */
export interface RemoteFailureFace {
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

/**
 * `RemoteResult<T>` 的结构面
 * （`@deepseek-ai/dsh-typert-protocol/lib/types/types.d.ts:65-72`）。形状与
 * 迁移前那个 `RpcResultFace` 逐字相同——变的只是**外面那层包装没有了**，见
 * {@link RemoteService}。
 */
export type RemoteResultFace<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteFailureFace }

/**
 * The wire seam needed to create one chat-preset Session.
 *
 * 0.1.2-rc.1 的客户端不再有 `connection.api.*` 这条路（上游客户端代码里 0 处
 * 使用；我们的基线上有 4 处），一律走 `ctx.remote.<命名空间>.<方法>()`。会话
 * 创建落在 `session` 命名空间，签名由 Typert 生成器从宿主 FaceModel 生成，
 * 见 `@deepseek-ai/dsh-api-session-controller/lib/typert.remote-client.d.ts`：
 * `TypertRemoteMap['session/create']:
 *  (request: SessionCreateRequest) => Promise<RemoteResult<SessionCreateValue>>`。
 *
 * 两处必须照抄描述符，不能凭印象：
 * 1. **参数布局**——恰好一个 request 对象。网关按描述符逐参校验
 *    （`assertExactArguments`，`@deepseek-ai/dsh-api-gateway/lib/index.js`），
 *    多一个参数直接判 `arguments-invalid`，所以测试替身也得按同一张表编。
 * 2. **返回值不再包 `{ result }`**——promise 直接落在 `RemoteResult` 上。
 *
 * 字段取自同包 `lib/types/types.d.ts` 的
 * `SessionCreateRequest = { workspaceId?, cwd?, sessionId?, agentPreset? }`
 * 与 `SessionCreateValue = { sessionId, agentPreset? }`。这里只声明我们真正
 * 传的那两个字段：`agentPreset` 是这条动作存在的理由（宿主公开的
 * `ISessions.create(opts)` 在 0.1.2-rc.1 上虽然已经上了 `ISessions` 面
 * ——`.../client/contract/sessions.d.ts:33-37`——但它的 opts 只有
 * workspaceId / cwd / sessionId，**没有 agentPreset**，播不了 chat 预设）。
 */
export interface RemoteService {
  readonly session: {
    create(request: { workspaceId: string; agentPreset: 'chat' }): Promise<
      RemoteResultFace<{ readonly sessionId: string; readonly agentPreset?: string }>
    >
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
     * the pinned 0.1.2-rc.1 store, where that contract moved out of the
     * deleted runtime package into its own one:
     * `@deepseek-ai/dsh-client-store/lib/types/contract.d.ts:3-12`
     * (`{getSnapshot(): T; subscribe(fn: () => void): () => void}` —
     * "Minimal observable snapshot source shared by controllers, stores, and
     * render adapters"; the shape is unchanged from the 0.1.1-rc.2
     * declaration this comment used to cite). `subscribe` is optional here
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
   * no-session view state" — verified at the pinned 0.1.2-rc.1 store, where
   * the sessions face moved out of the deleted runtime package into the
   * session controller: `@deepseek-ai/dsh-api-session-controller/lib/types/
   * client/contract/sessions.d.ts:67`.
   *
   * Ctrl+N 落在 `clear()` 上是个产品决定，不是够不着别的动词：这条快捷键的全部
   * 契约就是"把我放到新会话首页"，`clear()` 恰好只做这一件事。
   *
   * 0.1.2-rc.1 上这段理由的**旁证换了两处**，记在这里免得下次重新争一遍：
   * - `ISessions.create(opts)` 现在**已经在**公开面上了
   *   （同文件 `:33-37`），不再是"只存在于具体类上"。但它的 opts 只有
   *   workspaceId / cwd / sessionId，仍然不接 `agentPreset`，而且它会真的建一个
   *   会话——两条都不是这条快捷键要的。
   * - 旧注释拿来做对比的 `IWorkspaces.startSession(workspaceId?)`（0.1.1-rc.2
   *   的 `@deepseek-ai/dsh-client-runtime/lib/types/client/contract/
   *   workspaces.d.ts:29`）**在 0.1.2-rc.1 上已经不存在**：搬家后的
   *   `IWorkspaces`（`@deepseek-ai/dsh-api-workspace-controller/lib/types/
   *   client/service.d.ts:27-69`）只剩 list / create / rename / delete /
   *   insertBefore / archiveSession / insertSessionBefore。所以"要不要改用
   *   startSession"这个曾经开着的产品选项，现在连动词都没有了。
   *
   * Optional: a `sessions` double predating this action (every existing test
   * fixture) legitimately lacks it.
   */
  clear?(): void
  /**
   * native-actions-pivot (workbench.session.previous): mirrors the
   * always-public `ISessions.open(id): void` — "Select a session as
   * current" — verified at the pinned 0.1.2-rc.1 store:
   * `@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/
   * sessions.d.ts:42`. Unlike the fork-only `presentation.open`, this
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
   * pinned 0.1.2-rc.1 store: `@deepseek-ai/dsh-api-session-controller/lib/
   * types/client/contract/sessions.d.ts:21` declares it unconditionally (no
   * split-pane compatibility required, unlike `presentation` above);
   * `SessionListState.current: SessionId | undefined` sits at
   * `.../client/sessions/service.d.ts:61-79` (line 66). The original
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
 * this plugin actually consumes. Mirrors `ILayout`, whose surface differs by
 * baseline: stock 0.1.2-rc.1 declares exactly `toggleSidebar()` /
 * `openDetails()` / `closeDetails()` (verified at the pinned store,
 * `@deepseek-ai/dsh-client-ui-layout/lib/types/client/service.d.ts`), while
 * the currently pinned fork adds `openSettings()`, and a not-yet-pushed fork
 * branch adds a second, newer `toggleSettings()` alongside it — see each
 * member's own doc comment.
 * Every member this plugin does not require unconditionally is optional, so
 * a baseline missing it degrades to "capability absent", never to a crash.
 */
export interface LayoutService {
  toggleSidebar(): void
  /**
   * native-actions-pivot (workbench.settings.open): the pinned Harness fork
   * ships this verb — `ILayout.openSettings()` on
   * `@deepseek-ai/dsh-client-ui-layout`, wired by the Settings shell through
   * `LayoutController.attachSettingsOpener` when the `sidebar.settings`
   * occupant mounts (fork commit `1a8cf5ba`, and its parent `be23380a` which
   * introduced the verb). It is fail-soft by construction: before the shell
   * mounts, or under a replacement layout provider that implements only the
   * documented `ILayout`, calling it is a no-op rather than a throw.
   * Stock Harness `0.1.2-rc.1` has no such verb — its `ILayout` declares
   * exactly `toggleSidebar()` / `openDetails()` / `closeDetails()` — so this
   * stays `undefined` there and the action is never registered (fail-closed;
   * see `settingsOpenOn` in shortcuts.tsx for the gate this backs).
   */
  openSettings?(): void
  /**
   * workbench.settings.open (open/close toggle): a second, newer fork verb
   * — `ILayout.toggleSettings()` on `@deepseek-ai/dsh-client-ui-layout`,
   * named to match `toggleSidebar()`'s own convention. It ships on the
   * `feat/toggle-settings-verb` branch of the pinned Harness fork (commit
   * `82de604afc683cd8c7692d0736f26f9ebc0f1823`, not yet pushed at the time
   * this comment was written), alongside `openSettings()` above rather than
   * replacing it: `openSettings()` is untouched, same signature and
   * semantics, because the already-shipped `v0.2.0-rc.2` release calls it
   * directly and cannot be broken retroactively. `LayoutController` gains a
   * paired `attachSettingsToggle(toggle)` — wired by the Settings shell
   * store's new `toggle` action through `shellInjected`, the same injection
   * shape `attachSettingsOpener` already uses for `openSettings()` — and
   * `LayoutController.toggleSettings()` is fail-soft by that identical
   * construction: before the shell mounts, or under a replacement layout
   * provider implementing only the documented `ILayout`, calling it is a
   * no-op rather than a throw.
   * Neither the currently pinned fork commit (the one `openSettings()`
   * above documents) nor stock Harness `0.1.2-rc.1` ships this member, so it
   * stays `undefined` on both today. The action prefers this verb when
   * present and falls back to `openSettings()` otherwise — open-only on a
   * host that has not picked up `feat/toggle-settings-verb` yet, open-and-
   * close once it has — see `settingsOpenOn` and the `workbench.settings.
   * open` action `run()` in shortcuts.tsx for the preference-then-fallback
   * wiring this backs.
   */
  toggleSettings?(): void
}

/** Aggregate of the injected services the plugin uses. */
export interface HarnessServices {
  remote?: RemoteService
  layout?: LayoutService
  sessions?: SessionsService
  workspaces?: WorkspacesService
}

/** Capability-complete service bundle required by `workbench.chat.open`. */
export interface ChatActionServices {
  readonly remote: RemoteService
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
  const create = services.remote?.session?.create
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
  get(name: 'remote' | 'layout' | 'sessions' | 'workspaces'): unknown
  locale: LocaleService
  slots: SlotService
  settingsScope: { bind(options: { namespace: string }): SettingsScopeFace }
  effect(fn: () => void, label?: string): void
  on(event: 'dispose', fn: () => void): void
  /**
   * Finding 2 (smoke test) — the active-locale-switch signal. Verified
   * against the pinned 0.1.2-rc.1 store:
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
    remote: ctx.get('remote') as RemoteService | undefined,
    layout: ctx.get('layout') as LayoutService | undefined,
    sessions: ctx.get('sessions') as SessionsService | undefined,
    workspaces: ctx.get('workspaces') as WorkspacesService | undefined,
  }
}
