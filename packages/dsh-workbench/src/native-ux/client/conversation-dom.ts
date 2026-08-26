// Adapter layer — the ONLY module allowed to touch conversation DOM
// structure (ADR-0001). Everything here is replaceable when the upstream
// ConversationNavigation service + overlay seat land (issue #1).
import type { ContentBlockView, InputNodeView } from '../core/derive-index.js'

export const SCROLLPORT_SELECTOR = '[data-conversation-scroll]'
export const ANCHOR_SELECTOR = '[data-chat-anchor-key]'
export const COMPOSER_SELECTOR = '[data-composer-seat]'

/** Locate the conversation scrollport within one pane-owned DOM scope. */
export function locateScrollport(root: ParentNode = document): HTMLElement | null {
  const el = root.querySelector(SCROLLPORT_SELECTOR)
  return el instanceof HTMLElement ? el : null
}

export interface ScrollportRect {
  top: number
  bottom: number
  right: number
  height: number
}

export function scrollportRect(scrollport: HTMLElement): ScrollportRect {
  const rect = scrollport.getBoundingClientRect()
  return { top: rect.top, bottom: rect.bottom, right: rect.right, height: Math.max(0, rect.bottom - rect.top) }
}

/**
 * Right inset for a fixed-position rail: distance from the viewport's
 * right edge to the rail, kept clear of the system scrollbar gutter
 * (offsetWidth - clientWidth measures the classic scrollbar width).
 */
export function railInset(scrollport: HTMLElement, rect: { right: number }, baseInset: number): number {
  const scrollbarWidth = Math.max(0, scrollport.offsetWidth - scrollport.clientWidth)
  return window.innerWidth - rect.right + scrollbarWidth + baseInset
}

/**
 * Normalize a render-layer node (harness shape is `unknown`) to the core
 * `InputNodeView` the projection consumes. Render-layer ChatNodes carry their
 * domain payload under `.data` (ChatNodeDataMap); tolerate both shapes
 * defensively. Single narrowing point for the harness node boundary.
 */
export function normalizeInputNode(node: unknown): InputNodeView | null {
  if (typeof node !== 'object' || node === null) return null
  const n = node as Record<string, unknown>
  if (typeof n.kind !== 'string' || typeof n.key !== 'string') return null
  const data = (typeof n.data === 'object' && n.data !== null ? n.data : n) as Record<string, unknown>
  return {
    kind: n.kind,
    key: n.key,
    seq: typeof data.seq === 'number' ? data.seq : 0,
    time: typeof data.time === 'number' ? data.time : undefined,
    content: (Array.isArray(data.content) ? data.content : []) as readonly ContentBlockView[],
  }
}

/**
 * Conversation root for scoping the MutationObserver (sdk-facts.md:
 * `div.ConversationRoot_root[data-phase]`). Null on hosts without the
 * marker — the caller falls back to document.body.
 */
export function locateConversationRoot(root: ParentNode = document): HTMLElement | null {
  const fromScrollport = locateScrollport(root)?.closest<HTMLElement>('.ConversationRoot_root[data-phase]')
  if (fromScrollport) return fromScrollport
  return root.querySelector<HTMLElement>('.ConversationRoot_root[data-phase]') ?? null
}

/** Static presence of the conversation DOM anchors the navigator depends on. */
export interface ConversationDomCapabilities {
  scrollport: boolean
  anchors: boolean
  composer: boolean
}

/** One-shot presence probe for the capability report (GA-030). Pure DOM read,
 * confined to the adapter (ADR-0001). */
export function detectConversationDom(root: ParentNode = document): ConversationDomCapabilities {
  return {
    scrollport: locateScrollport(root) !== null,
    anchors: root.querySelector(ANCHOR_SELECTOR) !== null,
    composer: root.querySelector(COMPOSER_SELECTOR) !== null,
  }
}

export interface HumanAnchorElement {
  key: string
  element: HTMLElement
}

/**
 * GA-032 (Roadmap §9A.7): human-anchor element cache. Structural changes
 * refresh a coalesced (queueMicrotask-merged) snapshot, so the scroll
 * handler only reads cached elements and never re-queries the full DOM
 * per frame.
 */
export function createHumanAnchorCache(scrollport: HTMLElement) {
  let anchors: HumanAnchorElement[] = []
  let refreshQueued = false

  const refresh = () => {
    refreshQueued = false
    anchors = []
    for (const row of Array.from(scrollport.querySelectorAll(ANCHOR_SELECTOR))) {
      const el = row as HTMLElement
      const kind = el.dataset.chatFlowKind
      const key = el.dataset.chatAnchorKey
      if ((kind === 'user' || kind === 'steering') && key !== undefined) {
        anchors.push({ key, element: el })
      }
    }
  }

  const queueRefresh = () => {
    if (refreshQueued) return
    refreshQueued = true
    queueMicrotask(refresh)
  }

  refresh()
  const observer = new MutationObserver(queueRefresh)
  observer.observe(scrollport, { childList: true, subtree: true })

  return {
    snapshot: () => anchors,
    dispose: () => observer.disconnect(),
  }
}

/** Cached anchor elements → rect list for active-tracking (DOM order kept). */
export function anchorRectsFromCache(anchors: readonly HumanAnchorElement[]): Array<{ key: string; top: number }> {
  const rects: Array<{ key: string; top: number }> = []
  for (const anchor of anchors) {
    if (!anchor.element.isConnected) continue
    rects.push({ key: anchor.key, top: anchor.element.getBoundingClientRect().top })
  }
  return rects
}

/** Anchor lookup for reveal (exact dataset match, scoped). */
export function findAnchor(scrollport: HTMLElement, nodeKey: string): HTMLElement | null {
  for (const row of Array.from(scrollport.querySelectorAll(ANCHOR_SELECTOR))) {
    const el = row as HTMLElement
    if (el.dataset.chatAnchorKey === nodeKey) return el
  }
  return null
}

/**
 * Inject the reveal-highlight stylesheet once (harness has no CSS seam
 * for plugin styles; a scoped <style> tag is the adapter-level trade).
 */
let highlightCssInjected = false
export function ensureHighlightStyles(): void {
  if (highlightCssInjected) return
  highlightCssInjected = true
  const style = document.createElement('style')
  style.setAttribute('data-dsh-nux-styles', 'reveal-highlight')
  style.textContent =
    '[data-dsh-nux-reveal]{outline:2px solid var(--dsw-alias-brand-primary,#4f7cff);outline-offset:2px;border-radius:4px;transition:outline-color .15s ease}'
  document.head.appendChild(style)
}
