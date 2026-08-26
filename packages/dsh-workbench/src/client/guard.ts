import type { SupportedHarnessBuild } from './contract.ts'

/** A failed split-pane compatibility verdict; other Workbench modules remain active. */
export interface GuardFailure {
  readonly disabled: true
  readonly reason: 'incompatible DeepSeek Harness presentation'
  readonly detected: string
  readonly supported: string
}

/** A compatible presentation verdict. */
export interface GuardPass { readonly disabled: false }

/** Split-pane startup verdict. */
export type GuardVerdict = GuardPass | GuardFailure

/**
 * Verify the versioned Presentation face without probing private DOM or
 * unversioned session members.
 * @param sessions - injected sessions service at client activation.
 * @param supported - protocol revision this release was tested against.
 * @returns fail-closed verdict for the split-pane module only.
 */
export function runStartupGuard(sessions: unknown, supported: SupportedHarnessBuild): GuardVerdict {
  const presentation = (sessions as { presentation?: unknown } | undefined)?.presentation
  const supportedLabel = `${supported.version} (presentation protocol ${supported.protocol})`
  if (typeof presentation !== 'object' || presentation === null) {
    return {
      disabled: true,
      reason: 'incompatible DeepSeek Harness presentation',
      detected: 'missing: sessions.presentation',
      supported: supportedLabel,
    }
  }
  const protocol = (presentation as { protocol?: unknown }).protocol
  if (protocol !== supported.protocol) {
    return {
      disabled: true,
      reason: 'incompatible DeepSeek Harness presentation',
      detected: `presentation.protocol ${typeof protocol === 'number' ? protocol : 'absent'}`,
      supported: supportedLabel,
    }
  }
  return { disabled: false }
}

/** Workbench product limit: focused session plus one beside pane. */
export const WORKBENCH_VISIBLE_CAPACITY = 2 as const
