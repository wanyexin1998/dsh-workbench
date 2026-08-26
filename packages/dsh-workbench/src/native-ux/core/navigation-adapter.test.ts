// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HIGHLIGHT_MS, HIGHLIGHT_ATTR, revealNode } from './navigation-adapter.js'

function row(key: string) {
  const el = document.createElement('div')
  el.setAttribute('data-chat-anchor-key', key)
  return el
}

describe('navigation adapter (upstream-shaped API)', () => {
  let container: HTMLElement
  let currentSession: string | null

  const deps = {
    locateScrollport: () => container as HTMLElement | null,
    findAnchor: (scrollport: HTMLElement, nodeKey: string) => {
      const found = scrollport.querySelector('[data-chat-anchor-key="' + nodeKey + '"]')
      return found instanceof HTMLElement ? found : null
    },
    currentSessionId: () => currentSession,
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    container.appendChild(row('n1'))
    container.appendChild(row('n2'))
    container.appendChild(row('n3'))
    currentSession = 's1'
    ;(HTMLElement.prototype as any).scrollIntoView = vi.fn()
    vi.useFakeTimers()
  })

  afterEach(() => {
    container.remove()
    vi.useRealTimers()
  })

  it('reveals: scrolls, highlights, and clears the highlight after the window', async () => {
    const anchor = deps.findAnchor(container, 'n2')!
    const scrollSpy = vi.mocked(HTMLElement.prototype.scrollIntoView)
    scrollSpy.mockClear()
    const result = await revealNode('s1', 'n2', {}, deps)
    expect(result).toBe('revealed')
    expect(scrollSpy).toHaveBeenCalledOnce()
    expect(anchor.hasAttribute(HIGHLIGHT_ATTR)).toBe(true)
    vi.advanceTimersByTime(DEFAULT_HIGHLIGHT_MS)
    expect(anchor.hasAttribute(HIGHLIGHT_ATTR)).toBe(false)
  })

  it('returns not-loaded when the anchor is absent', async () => {
    expect(await revealNode('s1', 'ghost', {}, deps)).toBe('not-loaded')
  })

  it('returns view-unavailable without a scrollport', async () => {
    expect(await revealNode('s1', 'n1', {}, { ...deps, locateScrollport: () => null })).toBe('view-unavailable')
  })

  it('returns session-mismatch when the current session differs', async () => {
    currentSession = 's2'
    expect(await revealNode('s1', 'n1', {}, deps)).toBe('session-mismatch')
  })

  it('reduced motion: auto behavior and no lingering highlight', async () => {
    const anchor = deps.findAnchor(container, 'n1')!
    const scrollSpy = vi.mocked(HTMLElement.prototype.scrollIntoView)
    scrollSpy.mockClear()
    const result = await revealNode('s1', 'n1', { behavior: 'smooth', reducedMotion: true }, deps)
    expect(result).toBe('revealed')
    expect((scrollSpy.mock.calls[0][0] as ScrollIntoViewOptions)?.behavior).toBe('auto')
    expect(anchor.hasAttribute(HIGHLIGHT_ATTR)).toBe(false)
  })

  it('honors highlight:false', async () => {
    const anchor = deps.findAnchor(container, 'n3')!
    await revealNode('s1', 'n3', { highlight: false }, deps)
    expect(anchor.hasAttribute(HIGHLIGHT_ATTR)).toBe(false)
  })
})
