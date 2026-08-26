import { describe, expect, it } from 'vitest'
import { runStartupGuard, WORKBENCH_VISIBLE_CAPACITY } from '../src/client/guard.ts'
import { SUPPORTED_HARNESS } from '../src/client/contract.ts'

const faceOf = (protocol: unknown) => ({ presentation: { protocol } })

describe('split-pane presentation guard', () => {
  it('accepts the latest Harness presentation protocol', () => {
    expect(runStartupGuard(faceOf(2), SUPPORTED_HARNESS)).toEqual({ disabled: false })
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

  it('requests exactly the two-visible-pane product limit', () => {
    expect(WORKBENCH_VISIBLE_CAPACITY).toBe(2)
    expect(SUPPORTED_HARNESS).toEqual({ version: '0.1.1-rc.2', protocol: 2 })
  })
})
