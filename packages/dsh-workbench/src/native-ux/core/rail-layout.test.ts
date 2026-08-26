import { describe, expect, it } from 'vitest'
import { railMarkers } from './rail-layout.js'

describe('railMarkers', () => {
  it('returns nothing for zero items', () => {
    expect(railMarkers(0)).toEqual([])
  })

  it('single item sits at the middle', () => {
    expect(railMarkers(1, 0)).toEqual([{ nodeIndex: 0, offset: 0, active: true }])
  })

  it('clusters markers around the rail midpoint at a fixed gap', () => {
    const markers = railMarkers(5)
    expect(markers.length).toBe(5)
    expect(markers.map((m) => m.offset)).toEqual([-20, -10, 0, 10, 20])
    expect(markers.map((m) => m.nodeIndex)).toEqual([0, 1, 2, 3, 4])
  })

  it('keeps every marker in long histories', () => {
    const markers = railMarkers(500)
    expect(markers.length).toBe(500)
    expect(markers[0]?.nodeIndex).toBe(0)
    expect(markers[499]?.nodeIndex).toBe(499)
  })

  it('marks the active node without changing its geometry', () => {
    const active = 400
    const markers = railMarkers(500, active)
    expect(markers.some((m) => m.active)).toBe(true)
    const activeMarker = markers.find((m) => m.active)!
    expect(activeMarker.nodeIndex).toBe(active)
    expect(activeMarker.offset).toBe((active - 499 / 2) * 10)
  })

  it('never duplicates a node index', () => {
    const markers = railMarkers(64)
    const keys = new Set(markers.map((m) => m.nodeIndex))
    expect(keys.size).toBe(markers.length)
  })
})
