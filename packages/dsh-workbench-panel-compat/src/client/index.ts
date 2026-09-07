// 0.1.2-rc.1 删掉了 `@deepseek-ai/dsh-client-runtime`；`ClientContext` 本来就是
// cordis `Context` 的别名，直接从 cordis 取。别名保留，`apply(ctx: ClientContext)`
// 的签名因此不变。
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { WorkbenchPanels } from './types.ts'
import { betterSidebarAdapter } from './better-sidebar.ts'
import { PanePanelCoordinator } from './coordinator.ts'

export type { PanePanelAdapter, PanePanelAttachment, PanePanelTarget, WorkbenchPanels } from './types.ts'
export type { BetterSidebarPaneCapability } from './better-sidebar.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional Pane-local panel adapter registry supplied by Workbench compatibility. */
    workbenchPanels: WorkbenchPanels
  }
}

/** Panel providers are optional; Cordis reflection is a built-in context face. */
export const inject: readonly string[] = []

/** Install the Pane adapter registry and connect Better Sidebar when present. */
export function apply(ctx: ClientContext): void {
  const coordinator = new PanePanelCoordinator(document)
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('workbenchPanels', coordinator)
    return () => {
      coordinator.dispose()
      void disposeService()
    }
  }, 'dsh-workbench-panel-compat: service')

  ctx.inject(['betterSidebar'], (providerCtx) => {
    const adapter = betterSidebarAdapter(providerCtx.get('betterSidebar'))
    if (adapter === undefined) return
    return coordinator.register(adapter)
  })
}
