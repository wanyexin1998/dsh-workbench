// Adapter layer — the ONLY module allowed to touch conversation DOM
// structure (ADR-0001). Everything here is replaceable when the upstream
// ConversationNavigation service + overlay seat land (issue #1).
import type { ContentBlockView, InputNodeView } from '../core/derive-index.js'

export const SCROLLPORT_SELECTOR = '[data-conversation-scroll]'
export const ANCHOR_SELECTOR = '[data-chat-anchor-key]'
export const COMPOSER_SELECTOR = '[data-composer-seat]'
export const SESSION_PANE_SELECTOR = '[data-session-pane]'
export const CHAT_FLOW_SELECTOR = '[data-chat-flow]'
export const BUSINESS_ROW_SELECTOR = '[data-chat-anchor-key][data-chat-flow-key]'
export const SELECTION_CONTROL_SELECTOR = [
  'a[href]', 'button', 'input', 'textarea', 'select', 'option',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]', '[role="link"]', '[role="menuitem"]',
  '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="tab"]',
].join(',')
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

/** DOM-only selection facts. Session identity and node state are verified by selection-controller. */
export interface ConversationRangeCapture {
  readonly row: HTMLElement
  readonly range: Range
  readonly focusScope: ParentNode
  readonly paneSessionId: string | undefined
  readonly nodeKey: string
  readonly nodeKind: string
  readonly text: string
  readonly startOffset: number
  readonly endOffset: number
  readonly rect: { x: number; y: number; width: number; height: number }
}

function elementAt(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement
}

function normalizedVisibleText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function elementIsVisible(element: Element, boundary: Element): boolean {
  let current: Element | null = element
  while (current !== null) {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false
    const style = current.ownerDocument.defaultView?.getComputedStyle(current)
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false
    if (current === boundary) break
    current = current.parentElement
  }
  return current === boundary
}

function eligibleTextNodes(row: HTMLElement): Text[] {
  const nodes: Text[] = []
  const showText = row.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4
  const walker = row.ownerDocument.createTreeWalker(row, showText)
  let current = walker.nextNode()
  while (current !== null) {
    if (current instanceof Text) {
      const parent = current.parentElement
      const control = parent?.closest(SELECTION_CONTROL_SELECTOR) ?? null
      if (parent !== null && (control === null || !row.contains(control)) && elementIsVisible(parent, row)) nodes.push(current)
    }
    current = walker.nextNode()
  }
  return nodes
}

function intersectsControl(range: Range, row: HTMLElement): boolean {
  for (const control of Array.from(row.querySelectorAll(SELECTION_CONTROL_SELECTOR))) {
    try {
      if (range.intersectsNode(control)) return true
    } catch {
      return true
    }
  }
  return false
}

function rowIsStreaming(row: HTMLElement): boolean {
  if (row.getAttribute('data-streaming') === 'true') return true
  return row.querySelector('[data-streaming="true"]') !== null
}

/**
 * Resolve a browser Range inside one verified business row. This function is
 * deliberately strict: unsupported DOM endpoints fail closed instead of
 * guessing offsets or falling back to the document's first conversation.
 */
export function captureConversationRange(range: Range, maxBytes: number): ConversationRangeCapture | null {
  if (range.collapsed || !(range.startContainer instanceof Text) || !(range.endContainer instanceof Text)) return null
  const startElement = elementAt(range.startContainer)
  const endElement = elementAt(range.endContainer)
  const startRow = startElement?.closest<HTMLElement>(BUSINESS_ROW_SELECTOR) ?? null
  const endRow = endElement?.closest<HTMLElement>(BUSINESS_ROW_SELECTOR) ?? null
  if (startRow === null || startRow !== endRow || !startRow.isConnected || rowIsStreaming(startRow)) return null

  const startFlow = startElement?.closest<HTMLElement>(CHAT_FLOW_SELECTOR) ?? null
  const endFlow = endElement?.closest<HTMLElement>(CHAT_FLOW_SELECTOR) ?? null
  if (startFlow === null || startFlow !== endFlow || intersectsControl(range, startRow)) return null

  const startPane = startElement?.closest<HTMLElement>(SESSION_PANE_SELECTOR) ?? null
  const endPane = endElement?.closest<HTMLElement>(SESSION_PANE_SELECTOR) ?? null
  if (startPane !== endPane) return null
  const paneSessionId = startPane?.dataset.sessionPane
  if (startPane !== null && (paneSessionId === undefined || paneSessionId.length === 0)) return null

  const nodeKey = startRow.dataset.chatFlowKey
  const nodeKind = startRow.dataset.chatFlowKind
  if (nodeKey === undefined || nodeKey.length === 0 || nodeKind === undefined || nodeKind.length === 0) return null
  if (!elementIsVisible(startRow, startRow)) return null

  const nodes = eligibleTextNodes(startRow)
  const startIndex = nodes.indexOf(range.startContainer)
  const endIndex = nodes.indexOf(range.endContainer)
  if (startIndex < 0 || endIndex < startIndex) return null
  if (range.startOffset < 0 || range.startOffset > range.startContainer.data.length) return null
  if (range.endOffset < 0 || range.endOffset > range.endContainer.data.length) return null

  let cursor = 0
  let startOffset = -1
  let endOffset = -1
  let rowText = ''
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!
    const normalized = normalizedVisibleText(node.data)
    if (index === startIndex) startOffset = cursor + normalizedVisibleText(node.data.slice(0, range.startOffset)).length
    if (index === endIndex) endOffset = cursor + normalizedVisibleText(node.data.slice(0, range.endOffset)).length
    rowText += normalized
    cursor += normalized.length
  }
  if (startOffset < 0 || endOffset <= startOffset) return null
  const text = rowText.slice(startOffset, endOffset)
  if (new TextEncoder().encode(text).byteLength > maxBytes) return null

  const rect = typeof range.getBoundingClientRect === 'function'
    ? range.getBoundingClientRect()
    : { x: 0, y: 0, width: 0, height: 0 }
  const focusScope = startPane ?? startRow.closest<HTMLElement>('.ConversationRoot_root[data-phase]') ?? startFlow
  return {
    row: startRow,
    range: range.cloneRange(),
    focusScope,
    paneSessionId,
    nodeKey,
    nodeKind,
    text,
    startOffset,
    endOffset,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  }
}

/**
 * Write text into a composer input the React-controlled way (adapter,
 * tracked in issue #1 proposal 4 alongside `focusComposer` — no public
 * composer/draft-write API exists in the harness rc; the one public API this
 * repo did find, `dsh-client-ui-conversation`'s `SessionInput.setDraft`, only
 * writes the draft text with no "focus the composer" verb of its own, so it
 * would still need this same DOM marker for focus anyway — not currently a
 * live consumer of this function, but kept here as the sanctioned adapter
 * seam (ADR-0001) for the next feature that needs to write into the composer).
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
