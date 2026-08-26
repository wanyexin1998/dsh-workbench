// @vitest-environment jsdom
import * as React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NavigatorAnchor } from './navigator.js'

function makeSnapshot() {
  const nodes = new Map<string, any>([
    ['a', { key: 'a', kind: 'user', seq: 1, content: [{ kind: 'text', text: '第一问' }] }],
    ['b', { key: 'b', kind: 'steering', seq: 2, content: [{ kind: 'text', text: '改一下方案' }] }],
    ['c', { key: 'c', kind: 'context', seq: 0, content: [] }],
  ])
  return { chat: { order: ['a', 'b', 'c'], nodes: { get: (k: string) => nodes.get(k) } } }
}

describe('NavigatorAnchor', () => {
  let scrollport: HTMLElement

  beforeEach(() => {
    ;(globalThis as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    ;(HTMLElement.prototype as any).scrollIntoView = vi.fn()
    scrollport = document.createElement('div')
    scrollport.setAttribute('data-conversation-scroll', '')
    const rowA = document.createElement('div')
    rowA.setAttribute('data-chat-anchor-key', 'a')
    rowA.setAttribute('data-chat-flow-kind', 'user')
    const rowAssistant = document.createElement('div')
    rowAssistant.setAttribute('data-chat-anchor-key', 'assistant-1')
    rowAssistant.setAttribute('data-chat-flow-kind', 'assistant-step')
    const rowB = document.createElement('div')
    rowB.setAttribute('data-chat-anchor-key', 'b')
    rowB.setAttribute('data-chat-flow-kind', 'steering')
    scrollport.append(rowA, rowAssistant, rowB)
    document.body.appendChild(scrollport)
    vi.spyOn(scrollport, 'getBoundingClientRect').mockReturnValue({
      top: 60, bottom: 560, right: 1200, left: 240, width: 960, height: 500, x: 240, y: 60, toJSON: () => ({}),
    } as DOMRect)
  })

  afterEach(() => {
    cleanup()
    scrollport.remove()
    vi.restoreAllMocks()
  })

  function renderNavigator(overrides: { sessionId?: string; hasMore?: boolean; loadingOlder?: boolean; sessions?: any } = {}) {
    const snapshot = makeSnapshot()
    const patched = { ...snapshot, hasMore: overrides.hasMore ?? false, loadingOlder: overrides.loadingOlder ?? false }
    const props = {
      sessionId: overrides.sessionId ?? 's1',
      useSession: (selector: (s: any) => any) => selector(patched),
      t: (key: string) => key,
      sessions: overrides.sessions,
    }
    return render(<NavigatorAnchor {...props} />)
  }

  function firstMarker(): HTMLElement {
    return document.querySelector<HTMLElement>('[data-dsh-nux-marker]')!
  }

  it('renders collapsed rail with one marker per human input', () => {
    renderNavigator()
    const rail = screen.getByRole('navigation')
    expect(rail).toBeTruthy()
    expect(rail.querySelectorAll('[data-dsh-nux-marker]').length).toBe(2)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('expands the floating list on rail hover', () => {
    renderNavigator()
    fireEvent.mouseEnter(firstMarker())
    const list = screen.getByRole('listbox')
    expect(list).toBeTruthy()
    expect(screen.getAllByRole('option').length).toBe(2)
  })

  it('marks steering items', () => {
    renderNavigator()
    fireEvent.mouseEnter(firstMarker())
    expect(screen.getByText('navigator.steering')).toBeTruthy()
    expect(screen.getByText('第一问')).toBeTruthy()
  })

  it('collapses after the pointer leaves (delayed), unless pinned', () => {
    vi.useFakeTimers()
    renderNavigator()
    const marker = firstMarker()
    fireEvent.mouseEnter(marker)
    fireEvent.mouseLeave(marker)
    act(() => { vi.advanceTimersByTime(350) })
    expect(screen.queryByRole('listbox')).toBeNull()
    vi.useRealTimers()
  })

  it('pointer clicks never pin the list after the marker cluster is left', () => {
    vi.useFakeTimers()
    renderNavigator()
    const rail = screen.getByRole('navigation')
    const marker = firstMarker()
    fireEvent.mouseEnter(marker)
    fireEvent.click(rail)
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.mouseLeave(marker)
    act(() => { vi.advanceTimersByTime(350) })
    expect(screen.queryByRole('listbox')).toBeNull()
    vi.useRealTimers()
  })

  it('escape closes the list', () => {
    renderNavigator()
    fireEvent.mouseEnter(firstMarker())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('item click reveals the node and closes the unpinned list', () => {
    renderNavigator()
    fireEvent.mouseEnter(firstMarker())
    const options = screen.getAllByRole('option')
    fireEvent.click(options[0])
    expect(screen.queryByRole('listbox')).toBeNull()
    const rowA = scrollport.querySelector('[data-chat-anchor-key="a"]')!
    expect(rowA.hasAttribute('data-dsh-nux-reveal')).toBe(true)
  })

  // --- T5 keyboard / a11y ---

  it('rail is focusable with aria-expanded and opens on Enter', () => {
    renderNavigator()
    const rail = screen.getByRole('navigation')
    expect(rail.getAttribute('tabindex')).toBe('0')
    expect(rail.getAttribute('aria-expanded')).toBe('false')
    fireEvent.keyDown(rail, { key: 'Enter' })
    expect(rail.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('arrow keys move the focused option and Enter reveals it', () => {
    renderNavigator()
    const rail = screen.getByRole('navigation')
    fireEvent.keyDown(rail, { key: 'Enter' }) // keyboard open = pinned-open
    expect(rail.getAttribute('aria-activedescendant')).toBe('dsh-nux-option-0')
    fireEvent.keyDown(rail, { key: 'ArrowDown' })
    expect(rail.getAttribute('aria-activedescendant')).toBe('dsh-nux-option-1')
    fireEvent.keyDown(rail, { key: 'Enter' })
    const rowB = scrollport.querySelector('[data-chat-anchor-key="b"]')!
    expect(rowB.hasAttribute('data-dsh-nux-reveal')).toBe(true)
    // pinned-open stays open until Esc (keyboard flow semantics)
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('Space toggles like Enter when collapsed', () => {
    renderNavigator()
    const rail = screen.getByRole('navigation')
    fireEvent.keyDown(rail, { key: ' ' })
    expect(rail.getAttribute('aria-expanded')).toBe('true')
  })

  it('reduced motion reveals without smooth behavior', () => {
    ;(window as any).matchMedia = vi.fn().mockReturnValue({ matches: true })
    renderNavigator()
    fireEvent.mouseEnter(firstMarker())
    fireEvent.click(screen.getAllByRole('option')[0])
    const rowA = scrollport.querySelector('[data-chat-anchor-key="a"]')!
    expect(rowA.hasAttribute('data-dsh-nux-reveal')).toBe(false)
  })

  // --- T6 boundaries ---

  it('renders the load-older boundary only when hasMore', () => {
    renderNavigator({ hasMore: true })
    fireEvent.mouseEnter(firstMarker())
    expect(screen.queryByText('navigator.loadOlderHint')).toBeNull()
    const list = screen.getByRole('listbox') as HTMLElement
    const button = document.querySelector<HTMLElement>('[data-dsh-nux-load-older-button]')
    expect(list.style.background).toContain('--dsw-alias-bg-layer-2')
    expect(list.style.color).toBe('var(--dsw-alias-label-primary)')
    expect(button?.style.border).toBe('0px')
    expect(button?.style.background).toBe('transparent')
    expect(button?.style.fontSize).toBe('11px')
  })

  it('uses only the visible marker cluster as the hover target and keeps active thickness unchanged', () => {
    renderNavigator()
    const wrapper = document.querySelector<HTMLElement>('[data-dsh-nux="rail"]')!
    const cluster = screen.getByRole('navigation')
    const markers = Array.from(cluster.querySelectorAll<HTMLElement>('[data-dsh-nux-marker]'))
    expect(wrapper.style.pointerEvents).toBe('none')
    expect(cluster.style.pointerEvents).toBe('auto')
    expect(markers.map(marker => marker.style.height)).toEqual(['2px', '2px'])
    fireEvent.mouseEnter(cluster)
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.mouseEnter(markers[0]!)
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('load-older button calls the scoped conversation face and never auto-fires', () => {
    const loadOlder = vi.fn()
    const sessions = { scope: vi.fn(() => ({ get: vi.fn(() => ({ loadOlder })) })) }
    renderNavigator({ hasMore: true, sessions })
    expect(loadOlder).not.toHaveBeenCalled() // never auto-load
    fireEvent.mouseEnter(firstMarker())
    fireEvent.click(screen.getByText('navigator.loadOlder'))
    expect(loadOlder).toHaveBeenCalledOnce()
  })

  it('load-older button disables while loading', () => {
    renderNavigator({ hasMore: true, loadingOlder: true })
    fireEvent.mouseEnter(firstMarker())
    const button = screen.getByRole('button', { name: 'navigator.loadingOlder' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  // --- GA-010 rail marker visuals (Roadmap §9A.8) ---

  it('every rail marker is an equal-length 18px horizontal dash', () => {
    renderNavigator()
    const rail = screen.getByRole('navigation')
    const markers = rail.querySelectorAll<HTMLElement>('[data-dsh-nux-marker]')
    expect(markers.length).toBeGreaterThan(0)
    markers.forEach((marker) => {
      // Idle and active differ only by color depth — never geometry.
      expect(marker.style.width).toBe('18px')
      expect(marker.style.height).toBe('2px')
    })
    expect(rail.style.gap).toBe('8px')
  })

  // --- GA-031 scrollport observer scope (Roadmap §9A.10) ---

  it('never observes document.body once the conversation root exists', () => {
    const observed: Element[] = []
    vi.stubGlobal('MutationObserver', class {
      constructor(_cb: (m: MutationRecord[]) => void) {}
      observe(target: Element) { observed.push(target) }
      disconnect() {}
    })
    const container = document.createElement('div')
    const root = document.createElement('div')
    root.className = 'ConversationRoot_root'
    root.setAttribute('data-phase', 'ready')
    root.appendChild(scrollport)
    container.appendChild(root)
    document.body.appendChild(container)
    try {
      renderNavigator()
      expect(observed).not.toContain(document.body)
      // Scope is the root's parent: both scrollport rebuilds and root
      // replacement (view switch / HMR) stay visible.
      expect(observed).toContain(container)
    } finally {
      vi.unstubAllGlobals()
      container.remove()
    }
  })

  it('falls back to document.body discovery when the host has no conversation root', () => {
    const observed: Element[] = []
    vi.stubGlobal('MutationObserver', class {
      constructor(_cb: (m: MutationRecord[]) => void) {}
      observe(target: Element) { observed.push(target) }
      disconnect() {}
    })
    try {
      renderNavigator()
      expect(observed).toContain(document.body)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // --- GA-011 floating prompt list visuals (Roadmap §9A.9) ---

  it('expanded floating list matches the GA-011 card spec', () => {
    renderNavigator()
    fireEvent.mouseEnter(firstMarker())
    const list = screen.getByRole('listbox') as HTMLElement
    expect(list.style.width).toBe('326px')
    expect(list.style.borderRadius).toBe('14px')
    expect(list.style.getPropertyValue('backdrop-filter')).toBe('blur(16px) saturate(132%)')
    // jsdom's cssstyle cannot round-trip vendor-prefixed setProperty calls,
    // so read back through the same accessor React uses to assign it.
    const webkitBlur = (list.style as CSSStyleDeclaration & { WebkitBackdropFilter?: string }).WebkitBackdropFilter
    expect(webkitBlur).toBe('blur(16px) saturate(132%)')
  })
})
