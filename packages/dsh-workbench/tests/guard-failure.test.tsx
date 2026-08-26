// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeGuardFailureBanner } from '../src/client/guard-failure.tsx'
import type { GuardFailure } from '../src/client/guard.ts'

afterEach(cleanup)

const verdict: GuardFailure = {
  disabled: true,
  reason: 'incompatible DeepSeek Harness presentation',
  detected: 'presentation.protocol 1',
  supported: '0.1.1-rc.2 (presentation protocol 2)',
}

describe('Startup-Guard failure surface (ARCH-02 / #25: visible, role="alert", no DOM fallback)', () => {
  const t = (key: string) => key

  it('renders a role="alert" with the localized title and detected/supported detail', () => {
    const Banner = makeGuardFailureBanner(verdict)
    const { getByRole, queryByText } = render(<Banner t={t} />)
    const alert = getByRole('alert')
    expect(alert).toBeTruthy()
    // The title, both detail labels and both verdict values are visible.
    expect(queryByText('guard.title')).toBeTruthy()
    expect(queryByText('guard.detected')).toBeTruthy()
    expect(queryByText('guard.supported')).toBeTruthy()
    expect(alert.textContent).toContain(verdict.detected)
    expect(alert.textContent).toContain(verdict.supported)
  })

  it('closes over the SPECIFIC verdict (each failure shows its own reason)', () => {
    const other: GuardFailure = { ...verdict, detected: 'missing: capabilities.visiblePaneFocus' }
    const First = makeGuardFailureBanner(verdict)
    const Second = makeGuardFailureBanner(other)
    const { unmount } = render(<First t={t} />)
    unmount()
    const { getByRole } = render(<Second t={t} />)
    expect(getByRole('alert').textContent).toContain('missing: capabilities.visiblePaneFocus')
  })

  it('stays click-through (pointer-events: none) — no interactive Workbench feature on failure', () => {
    const Banner = makeGuardFailureBanner(verdict)
    const { container } = render(<Banner t={t} />)
    const alert = container.querySelector('[data-guard-failure]') as HTMLElement
    expect(alert.style.pointerEvents).toBe('none')
    // No buttons/inputs anywhere: the failure surface is informational only.
    expect(container.querySelector('button, input, a')).toBeNull()
  })
})
