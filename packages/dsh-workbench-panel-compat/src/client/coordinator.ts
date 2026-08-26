import type { PanePanelAdapter, PanePanelAttachment, PanePanelTarget, WorkbenchPanels } from './types.ts'

interface MountedAttachment {
  readonly adapter: PanePanelAdapter
  readonly target: PanePanelTarget
  readonly attachment: PanePanelAttachment
}

/** Coordinates explicit provider adapters over the current Workbench Pane DOM. */
export class PanePanelCoordinator implements WorkbenchPanels {
  readonly #document: Document
  readonly #adapters = new Map<string, PanePanelAdapter>()
  readonly #mounted = new Map<string, MountedAttachment>()
  readonly #failed = new Map<string, PanePanelTarget>()
  #observer: MutationObserver | undefined
  #syncQueued = false

  /** @param document - page document containing Workbench Pane hosts. */
  constructor(document: Document) {
    this.#document = document
  }

  /** @inheritdoc */
  register(adapter: PanePanelAdapter): () => void {
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`Workbench panel adapter "${adapter.id}" is already registered`)
    }
    this.#adapters.set(adapter.id, adapter)
    this.#ensureObserver()
    this.#sync()
    return () => {
      if (this.#adapters.get(adapter.id) !== adapter) return
      this.#adapters.delete(adapter.id)
      this.#disposeAdapter(adapter.id)
      if (this.#adapters.size === 0) this.#stopObserver()
    }
  }

  /** Dispose the coordinator and every provider attachment. */
  dispose(): void {
    this.#adapters.clear()
    this.#stopObserver()
  }

  #ensureObserver(): void {
    if (this.#observer !== undefined) return
    this.#observer = new MutationObserver(() => { this.#queueSync() })
    this.#observer.observe(this.#document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-focused', 'data-session-pane'],
    })
  }

  #stopObserver(): void {
    this.#observer?.disconnect()
    this.#observer = undefined
    for (const mounted of this.#mounted.values()) mounted.attachment.dispose()
    this.#mounted.clear()
    this.#failed.clear()
  }

  #queueSync(): void {
    if (this.#syncQueued) return
    this.#syncQueued = true
    queueMicrotask(() => {
      this.#syncQueued = false
      if (this.#adapters.size > 0) this.#sync()
    })
  }

  #sync(): void {
    const targets = this.#targets()
    const live = new Set<string>()
    for (const adapter of this.#adapters.values()) {
      for (const target of targets) {
        const key = `${adapter.id}\u0000${target.sessionId}`
        live.add(key)
        const mounted = this.#mounted.get(key)
        if (mounted === undefined) {
          const failed = this.#failed.get(key)
          if (failed !== undefined
            && failed.pane === target.pane
            && failed.rightHost === target.rightHost
            && failed.bottomHost === target.bottomHost) {
            continue
          }
          this.#attach(key, adapter, target)
          continue
        }
        if (mounted.target.pane !== target.pane
          || mounted.target.rightHost !== target.rightHost
          || mounted.target.bottomHost !== target.bottomHost) {
          mounted.attachment.dispose()
          this.#mounted.delete(key)
          this.#attach(key, adapter, target)
          continue
        }
        if (mounted.target.focused !== target.focused) {
          mounted.attachment.update(target)
          this.#mounted.set(key, { ...mounted, target })
        }
      }
    }
    for (const [key, mounted] of this.#mounted) {
      if (live.has(key)) continue
      mounted.attachment.dispose()
      this.#mounted.delete(key)
    }
    for (const key of this.#failed.keys()) {
      if (!live.has(key)) this.#failed.delete(key)
    }
  }

  #attach(key: string, adapter: PanePanelAdapter, target: PanePanelTarget): void {
    try {
      const attachment = adapter.attach(target)
      this.#failed.delete(key)
      this.#mounted.set(key, { adapter, target, attachment })
    } catch (error) {
      this.#failed.set(key, target)
      console.error(`[dsh-workbench-panel-compat] adapter "${adapter.id}" failed for Session "${target.sessionId}":`, error)
    }
  }

  #targets(): PanePanelTarget[] {
    return [...this.#document.querySelectorAll<HTMLElement>('[data-session-pane]')].flatMap((pane) => {
      const sessionId = pane.dataset.sessionPane
      const rightHost = pane.querySelector<HTMLElement>('[data-session-pane-right]')
      const bottomHost = pane.querySelector<HTMLElement>('[data-session-pane-bottom]')
      if (sessionId === undefined || rightHost === null || bottomHost === null) return []
      return [{
        sessionId,
        pane,
        rightHost,
        bottomHost,
        focused: pane.hasAttribute('data-focused'),
      }]
    })
  }

  #disposeAdapter(id: string): void {
    const prefix = `${id}\u0000`
    for (const [key, mounted] of this.#mounted) {
      if (!key.startsWith(prefix)) continue
      mounted.attachment.dispose()
      this.#mounted.delete(key)
    }
    for (const key of this.#failed.keys()) {
      if (key.startsWith(prefix)) this.#failed.delete(key)
    }
  }
}
