import { describe, expect, it } from 'vitest'
import { findActiveKey } from './active-tracking.js'

describe('findActiveKey', () => {
  it('picks the last anchor above the reading line', () => {
    const anchors = [
      { key: 'a', top: 0 },
      { key: 'b', top: 200 },
      { key: 'c', top: 500 },
    ]
    // Reading line = 0 + 1000 * 0.3 = 300, so a(0) and b(200) are above it.
    expect(findActiveKey(anchors, 0, 1000)).toBe('b')
  })

  it('returns null when nothing is above the line', () => {
    const anchors = [{ key: 'a', top: 800 }]
    expect(findActiveKey(anchors, 0, 1000)).toBeNull()
  })

  it('returns the last anchor when all are above', () => {
    const anchors = [{ key: 'a', top: 0 }, { key: 'b', top: 50 }]
    expect(findActiveKey(anchors, 0, 1000)).toBe('b')
  })
})
