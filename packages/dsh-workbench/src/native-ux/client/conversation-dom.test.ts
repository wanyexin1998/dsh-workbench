// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  anchorRectsFromCache, createHumanAnchorCache, detectConversationDom,
  locateConversationRoot, locateScrollport,
} from './conversation-dom.js'

// MutationObserver delivery (one microtask) + the coalesced refresh (the next
// microtask) — a macrotask flush drains both turns.
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function anchor(key: string, kind: string): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-chat-anchor-key', key)
  el.setAttribute('data-chat-flow-kind', kind)
  return el
}

function makeScrollport() {
  const scrollport = document.createElement('div')
  scrollport.setAttribute('data-conversation-scroll', '')
  document.body.appendChild(scrollport)
  return scrollport
}

describe('createHumanAnchorCache (GA-032, Roadmap §9A.7)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('seeds with the anchors present at creation, user/steering only', () => {
    const scrollport = makeScrollport()
    const userA = anchor('a', 'user')
    const step = anchor('s1', 'assistant-step')
    const steeringB = anchor('b', 'steering')
    scrollport.append(userA, step, steeringB)
    const cache = createHumanAnchorCache(scrollport)
    try {
      const snapshot = cache.snapshot()
      expect(snapshot.map((a) => a.key)).toEqual(['a', 'b'])
      expect(snapshot[0]?.element).toBe(userA)
      expect(snapshot[1]?.element).toBe(steeringB)
    } finally {
      cache.dispose()
    }
  })

  it('refreshes coalesced when the structure changes (multiple mutations → one refresh)', async () => {
    const scrollport = makeScrollport()
    const original = anchor('a', 'user')
    scrollport.append(original)
    const cache = createHumanAnchorCache(scrollport)
    try {
      const added1 = anchor('b', 'user')
      const added2 = anchor('c', 'steering')
      const swapIn = anchor('a2', 'user')
      scrollport.append(added1, added2)
      scrollport.replaceChild(swapIn, original)
      // Two structural mutations within the same turn → coalesced into one
      // refresh; until the microtask flushes, the cache still holds the
      // pre-mutation snapshot.
      expect(cache.snapshot().map((a) => a.key)).toEqual(['a'])
      await flush()
      expect(cache.snapshot().map((a) => a.key)).toEqual(['a2', 'b', 'c'])
    } finally {
      cache.dispose()
    }
  })

  it('dispose stops structural refreshes', async () => {
    const scrollport = makeScrollport()
    const cache = createHumanAnchorCache(scrollport)
    cache.dispose()
    scrollport.append(anchor('late', 'user'))
    await flush()
    expect(cache.snapshot().map((a) => a.key)).toEqual([])
  })
})

describe('anchorRectsFromCache', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('maps cached elements to top-to-bottom rect entries, skipping detached ones', () => {
    const scrollport = makeScrollport()
    const userA = anchor('a', 'user')
    const userB = anchor('b', 'user')
    scrollport.append(userA, userB)
    const cache = createHumanAnchorCache(scrollport)
    try {
      userA.remove() // detached mid-session (e.g. virtualization)
      const rects = anchorRectsFromCache(cache.snapshot())
      expect(rects).toHaveLength(1)
      expect(rects[0]?.key).toBe('b')
      expect(typeof rects[0]?.top).toBe('number')
    } finally {
      cache.dispose()
    }
  })
})

describe('locateConversationRoot (GA-031 scope, sdk-facts.md)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('finds the ConversationRoot_root[data-phase] ancestor of the scrollport', () => {
    const root = document.createElement('div')
    root.className = 'ConversationRoot_root'
    root.setAttribute('data-phase', 'ready')
    const scrollport = makeScrollport()
    root.appendChild(scrollport)
    document.body.appendChild(root)
    expect(locateConversationRoot()).toBe(root)
  })

  it('returns null when the host has no root marker (caller falls back to body)', () => {
    makeScrollport()
    expect(locateConversationRoot()).toBeNull()
  })
})

describe('pane-scoped DOM lookup', () => {
  it('resolves each pane scrollport without falling back to the first document match', () => {
    const firstPane = document.createElement('section')
    const secondPane = document.createElement('section')
    const first = document.createElement('div')
    const second = document.createElement('div')
    first.dataset.conversationScroll = ''
    second.dataset.conversationScroll = ''
    firstPane.appendChild(first)
    secondPane.appendChild(second)
    document.body.append(firstPane, secondPane)

    expect(locateScrollport(firstPane)).toBe(first)
    expect(locateScrollport(secondPane)).toBe(second)
    firstPane.remove()
    secondPane.remove()
  })
})

describe('detectConversationDom (GA-030 probe, ADR-0001)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('reports the presence of each anchor independently', () => {
    expect(detectConversationDom()).toEqual({ scrollport: false, anchors: false, composer: false })
    const sp = document.createElement('div')
    sp.setAttribute('data-conversation-scroll', '')
    document.body.appendChild(sp)
    expect(detectConversationDom()).toEqual({ scrollport: true, anchors: false, composer: false })
    const row = document.createElement('div')
    row.setAttribute('data-chat-anchor-key', 'a')
    document.body.appendChild(row)
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    document.body.appendChild(seat)
    expect(detectConversationDom()).toEqual({ scrollport: true, anchors: true, composer: true })
  })
})
