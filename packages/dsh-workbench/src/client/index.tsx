import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { runStartupGuard, WORKBENCH_VISIBLE_CAPACITY } from './guard.ts'
import { SUPPORTED_HARNESS } from './contract.ts'
import { makeGuardFailureBanner } from './guard-failure.tsx'
import { SameWorkspaceWarning, useWorkspacePathIndex, type PaneWorkspace, type WorkspaceFacts } from './same-workspace-warning.tsx'
import { en, zh } from './dictionaries.ts'
import { applyNavigator } from '../native-ux/client/navigator.js'
import { applyShortcuts } from '../native-ux/client/shortcuts.js'
import type { HarnessContext } from '../native-ux/client/harness-adapter.js'
import { warnOnce } from '../native-ux/client/capabilities.js'
import type { WorkbenchActionsService } from '../native-ux/client/actions-api.js'

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

/** Required services for split presentation and the merged Native UX modules. */
export const inject = ['sessions', 'slots', 'locale', 'layout', 'settingsScope'] as const

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
  register(options: { name: string; id: string; label: () => string; locale: string }, component: unknown): () => void
}

/** The locale share the plugin consumes (dictionary registration + bound translator). */
interface WorkbenchLocale {
  register(ns: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
  bind(ns: string): (key: string) => string
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
 * Register Navigator and shortcuts, then enable the split-pane module only
 * when the Harness Session Presentation protocol is compatible.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // The npm Context type declares sessions/slots but not locale; resolve all
  // three through one platform cast (the cordis fiber gates them at runtime).
  const platform = ctx as never as { sessions?: unknown; slots?: unknown; locale?: unknown }
  const slots = platform.slots as WorkbenchSlots
  const locale = platform.locale as WorkbenchLocale
  // Dictionaries first: the failure surface (below) needs the bound
  // translator to render its localized copy, so the locale is registered
  // before the guard verdict is consumed.
  ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-workbench: dictionaries')
  const t = locale.bind(NS)
  const sessions = platform.sessions as WorkbenchSessions
  try {
    applyNavigator(ctx as never as HarnessContext)
  } catch (error) {
    warnOnce('navigator-apply-failed', 'navigator module failed to register: ' + String(error))
  }
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
    thirdPartyActionsHandle = applyShortcuts(ctx as never as HarnessContext)
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
  const verdict = runStartupGuard(platform.sessions, SUPPORTED_HARNESS)
  if (verdict.disabled) {
    // The role="alert" entry reports why only the split-pane module is
    // disabled. Navigator and non-presentation shortcuts remain registered.
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
