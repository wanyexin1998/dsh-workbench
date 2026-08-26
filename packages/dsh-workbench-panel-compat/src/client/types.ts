/** DOM hosts owned by one visible Workbench Session Pane. */
export interface PanePanelTarget {
  readonly sessionId: string
  readonly pane: HTMLElement
  readonly rightHost: HTMLElement
  readonly bottomHost: HTMLElement
  readonly focused: boolean
}

/** One live adapter attachment for a Pane. */
export interface PanePanelAttachment {
  /** Receive focus-only changes without remounting the panel. */
  update(target: PanePanelTarget): void
  /** Remove every node, listener and layout write owned by this attachment. */
  dispose(): void
}

/** An explicit compatibility adapter for one panel provider. */
export interface PanePanelAdapter {
  readonly id: string
  /** Attach the provider to one stable Session Pane. */
  attach(target: PanePanelTarget): PanePanelAttachment
}

/** Public client service used by provider-specific adapter plugins. */
export interface WorkbenchPanels {
  /** Register one adapter until its Cordis effect is disposed. */
  register(adapter: PanePanelAdapter): () => void
}
