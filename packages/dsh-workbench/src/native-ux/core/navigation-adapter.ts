// T3 — navigation adapter (seam A/B).
// Reveal semantics live here; the DOM-structure access is delegated to
// the client conversation-dom adapter so this module stays DOM-free where
// possible. The public shape matches the upstream proposal (issue #1):
//   revealNode(sessionId, nodeKey, options?): Promise<RevealResult>

export type RevealResult = 'revealed' | 'not-loaded' | 'session-mismatch' | 'view-unavailable'

export const DEFAULT_HIGHLIGHT_MS = 1000
export const HIGHLIGHT_ATTR = 'data-dsh-nux-reveal'

export interface RevealOptions {
  behavior?: 'auto' | 'smooth'
  highlight?: boolean
  highlightMs?: number
  reducedMotion?: boolean
}

export interface RevealDeps {
  locateScrollport(): HTMLElement | null
  findAnchor(scrollport: HTMLElement, nodeKey: string): HTMLElement | null
  currentSessionId(): string | null
}

/**
 * Reveal a chat node: scroll to it and briefly highlight it.
 * Resolves a stable outcome enum instead of throwing. The expected
 * session is the one the target node belongs to; the current session
 * is read at reveal time so a mid-reveal switch yields session-mismatch.
 */
export async function revealNode(
  sessionId: string,
  nodeKey: string,
  options: RevealOptions = {},
  deps?: RevealDeps,
): Promise<RevealResult> {
  const scrollport = deps?.locateScrollport() ?? null
  if (scrollport === null) return 'view-unavailable'
  const current = deps?.currentSessionId()
  if (current !== undefined && current !== null && current !== sessionId) return 'session-mismatch'
  const anchor = deps?.findAnchor(scrollport, nodeKey) ?? null
  if (anchor === null) return 'not-loaded'

  const reduced = options.reducedMotion === true
  const behavior: ScrollBehavior = reduced ? 'auto' : (options.behavior ?? 'smooth')
  anchor.scrollIntoView({ behavior, block: 'start' })

  if (options.highlight !== false) {
    anchor.setAttribute(HIGHLIGHT_ATTR, '')
    const ms = options.highlightMs ?? DEFAULT_HIGHLIGHT_MS
    if (reduced) {
      anchor.removeAttribute(HIGHLIGHT_ATTR)
    } else {
      // Timer is intentionally unmanaged: removing an attribute from a
      // detached anchor is a harmless no-op (documented trade-off).
      window.setTimeout(() => anchor.removeAttribute(HIGHLIGHT_ATTR), ms)
    }
  }
  return 'revealed'
}
