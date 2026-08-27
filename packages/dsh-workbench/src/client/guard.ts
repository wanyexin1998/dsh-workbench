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
  // The protocol number alone is not proof of shape: a downstream fork may
  // claim the same number for a face this plugin cannot actually drive.
  // Probe the exact members index.tsx calls before trusting the number.
  const face = presentation as { requestCapacity?: unknown; state?: unknown }
  if (typeof face.requestCapacity !== 'function') {
    return {
      disabled: true,
      reason: 'incompatible DeepSeek Harness presentation',
      detected: 'presentation.requestCapacity absent',
      supported: supportedLabel,
    }
  }
  const state = face.state as { getSnapshot?: unknown } | undefined
  if (typeof state !== 'object' || state === null || typeof state.getSnapshot !== 'function') {
    return {
      disabled: true,
      reason: 'incompatible DeepSeek Harness presentation',
      detected: 'presentation.state.getSnapshot absent',
      supported: supportedLabel,
    }
  }
  let snapshot: unknown
  try {
    snapshot = (state.getSnapshot as () => unknown)()
  } catch {
    return {
      disabled: true,
      reason: 'incompatible DeepSeek Harness presentation',
      detected: 'state.getSnapshot() threw',
      supported: supportedLabel,
    }
  }
  const snapshotFace = snapshot as { visible?: unknown; capacity?: unknown } | undefined
  if (typeof snapshotFace !== 'object' || snapshotFace === null || !Array.isArray(snapshotFace.visible)) {
    return {
      disabled: true,
      reason: 'incompatible DeepSeek Harness presentation',
      detected: 'snapshot.visible not an array',
      supported: supportedLabel,
    }
  }
  if (typeof snapshotFace.capacity !== 'number') {
    return {
      disabled: true,
      reason: 'incompatible DeepSeek Harness presentation',
      detected: 'snapshot.capacity not a number',
      supported: supportedLabel,
    }
  }
  return { disabled: false }
}

/** Workbench product limit: focused session plus one beside pane. */
export const WORKBENCH_VISIBLE_CAPACITY = 2 as const
