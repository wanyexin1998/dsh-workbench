// Adapter layer — the ONLY module allowed to touch conversation DOM
// structure (ADR-0001). Everything here is replaceable when the upstream
// ConversationNavigation service + overlay seat land (issue #1).
import type { ContentBlockView, InputNodeView } from '../core/derive-index.js'

export const SCROLLPORT_SELECTOR = '[data-conversation-scroll]'
export const ANCHOR_SELECTOR = '[data-chat-anchor-key]'
export const COMPOSER_SELECTOR = '[data-composer-seat]'
export const SESSION_PANE_SELECTOR = '[data-session-pane]'
/** Matches the editable node inside one composer seat — textarea, plain
 * text input, or a contenteditable variant. Shared by composer-focus (L0)
 * and the W2 host-command composer-insert mapping. */
export const COMPOSER_EDITABLE_SELECTOR =
  'textarea, input[type="text"], [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'

/**
 * Resolve the DOM scope for one focused session's pane, falling back to
 * `document` when there is no focused session id or no pane element carries
 * a matching `[data-session-pane]`. Pure DOM lookup — deliberately decoupled
 * from `HarnessServices`/`focusedSessionId` (harness-adapter.ts) so this
 * adapter module never needs to know about the ctx/services boundary,
 * matching ADR-0001 ("the ONLY module allowed to touch conversation DOM
 * structure"). Callers resolve the session id first (harness-adapter.ts's
 * `focusedSessionId`) and pass the plain string in here.
 */
export function focusedPaneScope(focusedSessionId: string | undefined, root: ParentNode = document): ParentNode {
  if (focusedSessionId === undefined) return root
  for (const pane of Array.from(root.querySelectorAll<HTMLElement>(SESSION_PANE_SELECTOR))) {
    if (pane.dataset.sessionPane === focusedSessionId) return pane
  }
  return root
}

/** Locate the editable composer element inside one DOM scope (a pane, or
 * `document` for the fallback case), or `null` when no composer seat /
 * editable child is present in that scope. */
export function locateComposerInput(scope: ParentNode): HTMLElement | null {
  const seat = scope.querySelector(COMPOSER_SELECTOR)
  const target = seat?.querySelector(COMPOSER_EDITABLE_SELECTOR)
  return target instanceof HTMLElement ? target : null
}

/**
 * Write text into a composer input the React-controlled way (adapter,
 * tracked in issue #1 proposal 4 alongside `focusComposer` — no public
 * composer/draft-write API exists in the harness rc; see host-commands.ts
 * for the fuller investigation of why the DOM path was chosen over the one
 * public API this repo did find, `dsh-client-ui-conversation`'s
 * `SessionInput.setDraft`).
 *
 * Assigning `.value` directly is a no-op from React's perspective: React
 * replaces the DOM property's own setter with a tracked one so it can
 * detect the change; a plain assignment through the *original* prototype
 * setter still lands the browser-visible value, but React's fiber never
 * learns about it, and the next render can stomp the typed text right back
 * to whatever React thinks the value still is. Grabbing the prototype's
 * *native* setter (before React's override) and calling it directly writes
 * the DOM value bypassing that tracked shortcut, then dispatching a real
 * `input` event is what actually notifies React's synthetic-event listener
 * — the same signal a real keystroke produces. `contenteditable` has no
 * `.value` at all, so `textContent` + the same `input` event is the
 * parallel path for that shape.
 */
export function setComposerValue(target: HTMLElement, text: string): void {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    setter?.call(target, text)
  } else {
    target.textContent = text
  }
  target.dispatchEvent(new Event('input', { bubbles: true }))
}

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
