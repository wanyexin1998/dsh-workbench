import { describe, expect, it } from 'vitest'
import { deriveNavigatorIndex, type HumanInputSource, type InputNodeView } from './derive-index.js'

function source(nodes: Record<string, InputNodeView>, order?: string[]): HumanInputSource {
  const keys = order ?? Object.keys(nodes)
  return { order: keys, getNode: (key) => nodes[key] }
}

function node(partial: Partial<InputNodeView> & { key: string; kind: string }): InputNodeView {
  return { seq: 1, content: [], ...partial }
}

describe('deriveNavigatorIndex', () => {
  it('keeps only user and steering, in source order', () => {
    const src = source({
      a: node({ key: 'a', kind: 'user', seq: 1, content: [{ kind: 'text', text: '第一问' }] }),
      b: node({ key: 'b', kind: 'context', seq: 2 }),
      c: node({ key: 'c', kind: 'assistant', seq: 3 }),
      d: node({ key: 'd', kind: 'steering', seq: 4, content: [{ kind: 'text', text: '改一下方案' }] }),
      e: node({ key: 'e', kind: 'tool-result', seq: 5 }),
    }, ['a', 'b', 'c', 'd', 'e'])
    const items = deriveNavigatorIndex(src)
    expect(items.map((i) => i.key)).toEqual(['a', 'd'])
    expect(items[0].kind).toBe('user')
    expect(items[1].kind).toBe('steering')
    expect(items[1].preview).toBe('改一下方案')
  })

  it('skips nodes missing from the source lookup', () => {
    const src = source({ a: node({ key: 'a', kind: 'user' }) }, ['a', 'ghost'])
    expect(deriveNavigatorIndex(src).length).toBe(1)
  })

  it('excludes compaction, retry and unknown kinds', () => {
    const src = source({
      a: node({ key: 'a', kind: 'compaction' }),
      b: node({ key: 'b', kind: 'model-retry' }),
      c: node({ key: 'c', kind: 'unknown' }),
    })
    expect(deriveNavigatorIndex(src)).toEqual([])
  })

  it('preserves seq and time', () => {
    const src = source({ a: node({ key: 'a', kind: 'user', seq: 7, time: 1700000000000 }) })
    const [item] = deriveNavigatorIndex(src)
    expect(item.seq).toBe(7)
    expect(item.time).toBe(1700000000000)
  })
})
