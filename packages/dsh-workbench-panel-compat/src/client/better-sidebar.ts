import type { PanePanelAdapter, PanePanelAttachment, PanePanelTarget } from './types.ts'

/** Better Sidebar's optional multi-Pane adapter capability. */
export interface BetterSidebarPaneCapability {
  readonly protocol: 1
  mountPane(target: PanePanelTarget): PanePanelAttachment
}

interface BetterSidebarWithPanes {
  readonly panes: BetterSidebarPaneCapability
}

/** Narrow an optional Cordis service to the multi-Pane capability. */
export function betterSidebarAdapter(value: unknown): PanePanelAdapter | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const panes = (value as Partial<BetterSidebarWithPanes>).panes
  if (typeof panes !== 'object' || panes === null || panes.protocol !== 1 || typeof panes.mountPane !== 'function') {
    return undefined
  }
  return {
    id: 'dsh-better-sidebar',
    attach: (target) => panes.mountPane(target),
  }
}
