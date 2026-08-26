import { describe, expect, it } from 'vitest'
import { ActionRegistry, type ActionDef } from './action-registry.js'
import { parseChord } from './chord.js'

const noop = () => {}

describe('ActionRegistry', () => {
  it('registers with default chords and resolves events', () => {
    const registry = new ActionRegistry()
    const action: ActionDef = { id: 'a1', label: 'A1', defaultChord: 'Primary+Shift+O', run: noop }
    expect(registry.register(action).ok).toBe(true)
    expect(registry.resolve(parseChord('Primary+Shift+O')!)?.id).toBe('a1')
    expect(registry.resolve(parseChord('Primary+B')!)).toBeNull()
  })

  it('rejects duplicate action ids', () => {
    const registry = new ActionRegistry()
    registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop })
    expect(registry.register({ id: 'a1', label: 'A2', defaultChord: 'Primary+P', run: noop }).ok).toBe(false)
  })

  it('reports chord conflicts', () => {
    const registry = new ActionRegistry()
    registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop })
    const result = registry.register({ id: 'a2', label: 'B', defaultChord: 'Primary+O', run: noop })
    expect(result.ok).toBe(true)
    expect(result.conflictWith).toBe('a1')
    expect(registry.conflicts()).toEqual([{ chord: 'Primary+o', actionIds: ['a1', 'a2'] }])
  })

  it('overrides the default chord at registration', () => {
    const registry = new ActionRegistry()
    registry.register({ id: 'a1', label: 'A', defaultChord: 'Primary+O', run: noop }, 'Primary+Shift+P')
    expect(registry.resolve(parseChord('Primary+Shift+P')!)?.id).toBe('a1')
    expect(registry.resolve(parseChord('Primary+O')!)).toBeNull()
  })

  it('supports unbound actions (null default)', () => {
    const registry = new ActionRegistry()
    registry.register({ id: 'a1', label: 'A', defaultChord: null, run: noop })
    expect(registry.all().length).toBe(1)
    expect(registry.bindingChord('a1')).toBeNull()
  })
})
