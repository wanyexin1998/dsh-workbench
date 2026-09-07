// 0.1.2-rc.1 删掉了 `@deepseek-ai/dsh-client-runtime`（上游把 runtime 包拆散、
// 整个删除），这里原来从它 type-import 的两个名字各自搬到了新的声明处：
// `ClientContext` 本来就是 cordis `Context` 的别名——上游自己的客户端包也这么写
// （`@deepseek-ai/dsh-client-ui-input-trigger/lib/types/client/index.d.ts:1`：
// `import type { Context as ClientContext } from '@deepseek-ai/cordis'`），
// 别名保留是为了让下面 `apply(ctx: ClientContext)` 的签名不变；
// `SessionId` 由 API 装配包再导出（`@deepseek-ai/dsh-api-remotes/lib/types/
// client/index.d.ts` 的 `export type { … SessionId … }`），与本包
// `same-workspace-warning.tsx` 里已有的那条导入同源，不为一个类型别名新拉
// `@deepseek-ai/dsh-session` 这条依赖。
// 已知代价（不是本次引入的，与上面那条既有导入完全同形）：api-remotes 是从
// `@deepseek-ai/dsh-client-connection` 再导出这个名字的，而那个包只在它自己的
// devDependencies 里，装不到消费者这边，所以在本仓库的编译面上 `SessionId`
// 实际退化成 `any`。宿主 profile 里包是齐的，声明处仍然是那一个。
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  presentationBlindContext,
  presentationBlindSessions,
  runStartupGuard,
  WORKBENCH_VISIBLE_CAPACITY,
} from './guard.ts'
import { SUPPORTED_HARNESS } from './contract.ts'
import { makeGuardFailureBanner } from './guard-failure.tsx'
import { SameWorkspaceWarning, useWorkspacePathIndex, type PaneWorkspace, type WorkspaceFacts } from './same-workspace-warning.tsx'
import { en, zh } from './dictionaries.ts'
import { applyShortcuts } from '../native-ux/client/shortcuts.js'
import { resolveHarnessServices, type HarnessContext } from '../native-ux/client/harness-adapter.js'
import { warnOnce } from '../native-ux/client/capabilities.js'
import type { WorkbenchActionsService } from '../native-ux/client/actions-api.js'
import { applySelectionActions } from '../native-ux/client/selection-actions.js'
import type { SelectionSessions } from '../native-ux/client/selection-controller.js'

// W3.1 — the public `workbench.actions` service (design.md §3 "L2"): the
// ecosystem's documented way for a plugin to PROVIDE a service other
// plugins can inject is Cordis's own `ctx.reflect.provide(name, value)` /
// the mixed-in `ctx.provide(name, value)` (both call the same
// ReflectService.provide — node_modules/.pnpm/@deepseek-ai+cordis@4.0.1/
// node_modules/@deepseek-ai/cordis/src/reflect.ts:44-46,277-305), paired
// with a `declare module '@deepseek-ai/cordis' { interface Context { ... }
// }` augmentation so `ctx.<name>` typechecks for injecting consumers. This
// is the exact pattern the sibling `dsh-workbench-panel-compat` package
// already ships for its own `workbenchPanels` service — see
// packages/dsh-workbench-panel-compat/src/client/index.ts:9-14,23 (`declare
// module` + `ctx.reflect.provide('workbenchPanels', coordinator)` inside a
// `ctx.effect(...)`, released via the effect's own teardown). `workbenchActions`
// mirrors that sibling's `workbench<Noun>` naming (not a bare `actions`,
// which would be far more likely to collide with an unrelated host or
// plugin service of the same generic name).
declare module '@deepseek-ai/cordis' {
  interface Context {
    workbenchActions: WorkbenchActionsService
  }
}

/**
 * Required services for split presentation and the merged Native UX modules.
 *
 * `remote` 取代了 0.1.2-rc.1 之前的 `connection`：本插件当初注入 connection 只是
 * 为了拿它身上的 `api.sessions.create`，而那条路在 rc.1 上没有了，会话创建改走
 * `ctx.remote.session.create`（见 harness-adapter.ts 的 `RemoteService`）。
 * 注入的是 `remote` 而不是继续留着 connection，因为门禁要卡的正是"随手问这条
 * 动作依赖的那个服务在不在"。
 *
 * **`'remote.session'` 必须单独写一条。** cordis 是按路径逐段放行的：只声明
 * `'remote'` 时，读 `ctx.remote.session` 会在 vendor/cordis 的 reflect.ts 抛
 * `cannot get property "remote.session" without inject`。上游自己也是两条都写
 * （`ui-deliverables`、`ui-model-selection` 都是 `[..., 'remote', 'remote.session']`）。
 * rc.4 发布版就漏了这一条：applyShortcuts 是 Navigator 退役后唯一的 apply 入口，
 * 它一抛，GA-043 的 fail-soft 把异常吞掉，插件静默地什么都不注册——页面照常，
 * 只在控制台留一行 warn。
 */
export const inject = [
  'remote', 'remote.session', 'sessions', 'workspaces', 'slots', 'locale', 'layout',
  'settingsScope', 'conversation', 'inputTriggers',
] as const

const NS = 'dsh-workbench'

/** The latest Harness Session Presentation members consumed by Workbench. */
interface WorkbenchSessions {
  presentation: {
    readonly protocol: number
    readonly state: { getSnapshot(): { visible: readonly SessionId[]; focused?: SessionId; capacity: number } }
    requestCapacity(capacity: 2): () => void
  }
}

/** The slots share the plugin consumes (list-slot registration, see ui-slots). */
interface WorkbenchSlots {
  inject(name: string, setup: () => () => void): () => void
  register(options: {
    name: string
    id: string
    label?: () => string
    locale?: string
    order?: number
    inject?: (() => Record<string, unknown>) | ((sessionId: string) => Record<string, unknown>)
  }, component: unknown): () => void
}

/** The locale share the plugin consumes (dictionary registration + bound translator). */
interface WorkbenchLocale {
  register(ns: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
  bind(ns: string): (key: string, vars?: Record<string, string>) => string
}

/** Facts the banner component reads off the framework-standard useSessions seat. */
interface BannerSessionState {
  byId: Record<SessionId, { cwd?: string }>
  presentation: { visible: readonly SessionId[]; focused?: SessionId }
}

/** Workspace-list slice the banner reads off the framework-standard useWorkspaces seat. */
interface BannerWorkspaceState {
  items: readonly { sessionIds: readonly string[]; path: string }[]
}

/** Identity of one visible pane: canonical workspace tier first, cwd fallback. */
function paneOf(summary: { cwd?: string } | undefined, workspacePath: string | undefined): PaneWorkspace {
  return { ...(workspacePath !== undefined ? { workspacePath } : {}), ...(summary?.cwd !== undefined ? { cwd: summary.cwd } : {}) }
}

/** The shell.overlay banner entry: reads sessions + workspaces facts, renders the warning. */
function SameWorkspaceBanner({ useSessions, useWorkspaces, t }: {
  useSessions?: <S>(selector: (state: BannerSessionState) => S) => S
  useWorkspaces?: <S>(selector: (state: BannerWorkspaceState) => S) => S
  t: (key: string) => string
}) {
  const workspacePathOf = useWorkspacePathIndex(useWorkspaces)
  const facts = useSessions?.<WorkspaceFacts>(s => ({
    visible: s.presentation.visible.map(id => paneOf(s.byId[id], workspacePathOf.get(id))),
  })) ?? { visible: [] }
  return <SameWorkspaceWarning facts={facts} onDismiss={() => {}} t={t} />
}

/**
 * Register shortcuts and selection actions, then enable the split-pane
 * module only when the Harness Session Presentation protocol is compatible.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // The npm Context type declares sessions/slots but not locale; resolve all
  // three through one platform cast (the cordis fiber gates them at runtime).
  const platform = ctx as never as {
    sessions?: unknown
    slots?: unknown
    locale?: unknown
    conversation?: unknown
    inputTriggers?: unknown
  }
  const slots = platform.slots as WorkbenchSlots
  const locale = platform.locale as WorkbenchLocale
  // The split-pane verdict is decided here, before a single module is
  // registered, because it decides what those modules are allowed to see.
  // A disabled verdict does not merely skip the capacity request and mount a
  // banner: it withholds `sessions.presentation` from every module below, so
  // the presentation-gated capabilities (forked side chat, fresh chat's
  // beside-open, pane-scoped DOM lookups) cannot re-derive an "Edition"
  // answer the guard just rejected. See presentationBlindSessions().
  const verdict = runStartupGuard(platform.sessions, SUPPORTED_HARNESS)
  const guardedSessions = verdict.disabled
    ? presentationBlindSessions(platform.sessions)
    : platform.sessions
  const nativeContext = (verdict.disabled
    ? presentationBlindContext(ctx as object, guardedSessions)
    : ctx) as never as HarnessContext
  const harness = resolveHarnessServices(nativeContext)
  // Dictionaries first: the failure surface (below) needs the bound
  // translator to render its localized copy, so the locale is registered
  // before the guard verdict is consumed.
  ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-workbench: dictionaries')
  const t = locale.bind(NS)
  const sessions = platform.sessions as WorkbenchSessions
  // W3.1: applyShortcuts() owns the third-party-actions handle's full
  // lifecycle (create + dispose, alongside its own previous-session focus
  // tracking subscription) and hands it back so the cordis service binding
  // below can expose exactly that live handle's `.service` — never a
  // second, disconnected instance.
  // A failed applyShortcuts() (caught above) leaves no live registry for
  // third-party registrations to reach anyway, so the service is correctly
  // left unexposed in that case rather than accepting registrations into a
  // black hole.
  let thirdPartyActionsHandle: ReturnType<typeof applyShortcuts> | undefined
  try {
    thirdPartyActionsHandle = applyShortcuts(nativeContext)
  } catch (error) {
    warnOnce('shortcuts-apply-failed', 'shortcuts module failed to register: ' + String(error))
  }
  if (thirdPartyActionsHandle !== undefined) {
    const handle = thirdPartyActionsHandle
    // ctx.effect's setup may return its own teardown (see the
    // "dsh-workbench: pane capacity" effect below for the same idiom); here
    // that teardown IS ctx.reflect.provide()'s own disposer — it only
    // unregisters the ctx.workbenchActions BINDING. The service object's own
    // internal state (the def store) is torn down by applyShortcuts's own
    // `ctx.on('dispose', ...)` handler, which owns `handle` — see this
    // block's comment above.
    ctx.effect(() => ctx.reflect.provide('workbenchActions', handle.service), 'dsh-workbench: actions api service')
  }
  try {
    applySelectionActions(ctx, {
      sessions: guardedSessions as SelectionSessions,
      conversation: platform.conversation as IConversation,
      inputTriggers: platform.inputTriggers as InputTriggerServiceContract,
      slots: slots as never,
      harness,
    }, t, NS)
  } catch (error) {
    warnOnce('selection-actions-apply-failed', 'selection actions failed to register: ' + String(error))
  }
  if (verdict.disabled) {
    // The role="alert" entry reports why only the split-pane module is
    // disabled. Non-presentation shortcuts and selection actions remain
    // registered.
    console.error(
      '[dsh-workbench] disabled:', verdict.reason,
      'detected:', verdict.detected,
      'supported:', verdict.supported,
    )
    slots.inject('shell.overlay', () => slots.register({
      name: 'shell.overlay',
      id: 'dsh-workbench.guard-failure',
      label: () => t('guard.title'),
      locale: NS,
    }, makeGuardFailureBanner(verdict)))
    return
  }
  // Protocol 2 caps Workbench at two visible panes. The max-wins request is
  // released with the plugin lifecycle.
  const releaseCapacity = sessions.presentation.requestCapacity(WORKBENCH_VISIBLE_CAPACITY)
  ctx.effect(() => releaseCapacity, 'dsh-workbench: pane capacity')
  // shell.overlay is a list slot: an id is required, the label resolves
  // per active locale, and the registration rides ctx.slots.inject so the
  // seat is declared before this entry registers into it.
  slots.inject('shell.overlay', () => slots.register({
    name: 'shell.overlay',
    id: 'dsh-workbench.same-workspace',
    label: () => t('banner.label'),
    locale: NS,
  }, SameWorkspaceBanner))
}
