import { describe, expect, it } from 'vitest'
import { initialNavigatorState, navigatorReducer } from './navigator-state.js'

describe('navigatorReducer', () => {
  it('hover expands the list', () => {
    const s = navigatorReducer(initialNavigatorState, { type: 'rail-hover-start' })
    expect(s.expanded).toBe(true)
    expect(s.pointerInside).toBe(true)
  })

  it('rail click pins and unpins', () => {
    const pinned = navigatorReducer(initialNavigatorState, { type: 'rail-click' })
    expect(pinned.pinned).toBe(true)
    expect(pinned.expanded).toBe(true)
    const unpinned = navigatorReducer(pinned, { type: 'rail-click' })
    expect(unpinned.pinned).toBe(false)
    expect(unpinned.expanded).toBe(false)
  })

  it('item click collapses when not pinned, stays open when pinned', () => {
    const open = { ...initialNavigatorState, expanded: true }
    expect(navigatorReducer(open, { type: 'item-click' }).expanded).toBe(false)
    const pinned = navigatorReducer(open, { type: 'rail-click' })
    expect(navigatorReducer(pinned, { type: 'item-click' }).expanded).toBe(true)
  })

  it('escape always collapses and unpins', () => {
    const pinned = { ...initialNavigatorState, expanded: true, pinned: true }
    const s = navigatorReducer(pinned, { type: 'escape' })
    expect(s.expanded).toBe(false)
    expect(s.pinned).toBe(false)
    expect(s.focusedIndex).toBe(-1)
  })

  it('outside click collapses unless pinned', () => {
    expect(navigatorReducer({ ...initialNavigatorState, expanded: true }, { type: 'outside-click' }).expanded).toBe(false)
    const pinned = { ...initialNavigatorState, expanded: true, pinned: true }
    expect(navigatorReducer(pinned, { type: 'outside-click' }).expanded).toBe(true)
  })

  it('reset clears transient state for session switch', () => {
    const dirty = { ...initialNavigatorState, expanded: true, pinned: true, activeKey: 'k', focusedIndex: 2 }
    expect(navigatorReducer(dirty, { type: 'reset' })).toEqual(initialNavigatorState)
  })

  it('set-active is a no-op for the same key', () => {
    const a = { ...initialNavigatorState, activeKey: 'k1' }
    expect(navigatorReducer(a, { type: 'set-active', key: 'k1' })).toBe(a)
    expect(navigatorReducer(a, { type: 'set-active', key: 'k2' }).activeKey).toBe('k2')
  })
})
