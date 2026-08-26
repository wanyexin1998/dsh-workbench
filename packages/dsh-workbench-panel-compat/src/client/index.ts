import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
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
