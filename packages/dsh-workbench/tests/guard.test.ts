import { describe, expect, it } from 'vitest'
import { runStartupGuard, WORKBENCH_VISIBLE_CAPACITY } from '../src/client/guard.ts'
import { SUPPORTED_HARNESS } from '../src/client/contract.ts'

const faceOf = (protocol: unknown) => ({ presentation: { protocol } })

/** A structurally complete presentation face, as consumed by client/index.tsx. */
const validPresentation = (overrides: Record<string, unknown> = {}) => ({
  protocol: 2,
  requestCapacity: () => () => {},
  state: { getSnapshot: () => ({ visible: [], capacity: 2 }) },
  ...overrides,
})

describe('split-pane presentation guard', () => {
  it('accepts the latest Harness presentation protocol', () => {
    expect(runStartupGuard({ presentation: validPresentation() }, SUPPORTED_HARNESS)).toEqual({ disabled: false })
  })

  it('fails closed for the split module when presentation is missing', () => {
    const verdict = runStartupGuard(undefined, SUPPORTED_HARNESS)
    expect(verdict).toMatchObject({
      disabled: true,
      reason: 'incompatible DeepSeek Harness presentation',
      detected: 'missing: sessions.presentation',
      supported: '0.1.1-rc.2 (presentation protocol 2)',
    })
  })

  it('rejects an older or untyped presentation protocol', () => {
    expect(runStartupGuard(faceOf(1), SUPPORTED_HARNESS)).toMatchObject({
      disabled: true, detected: 'presentation.protocol 1',
    })
    expect(runStartupGuard(faceOf(undefined), SUPPORTED_HARNESS)).toMatchObject({
      disabled: true, detected: 'presentation.protocol absent',
    })
  })

  it('fails closed when a same-numbered fork face is missing requestCapacity', () => {
    const presentation = validPresentation({ requestCapacity: undefined })
    expect(runStartupGuard({ presentation }, SUPPORTED_HARNESS)).toMatchObject({
      disabled: true, detected: 'presentation.requestCapacity absent',
    })
  })

  it('fails closed when state.getSnapshot is missing or not a function', () => {
    expect(runStartupGuard({ presentation: validPresentation({ state: {} }) }, SUPPORTED_HARNESS)).toMatchObject({
      disabled: true, detected: 'presentation.state.getSnapshot absent',
    })
    expect(runStartupGuard({ presentation: validPresentation({ state: { getSnapshot: 'nope' } }) }, SUPPORTED_HARNESS)).toMatchObject({
      disabled: true, detected: 'presentation.state.getSnapshot absent',
    })
  })

  it('fails closed when state.getSnapshot throws', () => {
    const state = { getSnapshot: () => { throw new Error('boom') } }
    expect(runStartupGuard({ presentation: validPresentation({ state }) }, SUPPORTED_HARNESS)).toMatchObject({
      disabled: true, detected: 'state.getSnapshot() threw',
    })
  })

  it('fails closed when the snapshot shape is malformed', () => {
    const withSnapshot = (snapshot: unknown) => validPresentation({ state: { getSnapshot: () => snapshot } })
    expect(runStartupGuard({ presentation: withSnapshot({ visible: 'nope', capacity: 2 }) }, SUPPORTED_HARNESS)).toMatchObject({
      disabled: true, detected: 'snapshot.visible not an array',
    })
    expect(runStartupGuard({ presentation: withSnapshot({ visible: [], capacity: '2' }) }, SUPPORTED_HARNESS)).toMatchObject({
      disabled: true, detected: 'snapshot.capacity not a number',
    })
  })

  it('requests exactly the two-visible-pane product limit', () => {
    expect(WORKBENCH_VISIBLE_CAPACITY).toBe(2)
    expect(SUPPORTED_HARNESS).toEqual({ version: '0.1.1-rc.2', protocol: 2 })
  })
})
