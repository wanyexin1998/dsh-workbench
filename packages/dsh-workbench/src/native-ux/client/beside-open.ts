/** Shared two-Pane capacity decision for fresh chat and forked side chats. */

export interface BesidePresentation {
  readonly state: {
    getSnapshot(): { readonly visible?: readonly string[]; readonly focused?: string }
  }
  open(id: string, options: { readonly disposition: 'beside' | 'replace-focused' }): void
  focus(id: string): void
}

export interface ReplaceConfirmation {
  readonly sourceSessionId: string
  readonly replacedSessionId: string
  readonly targetSessionId: string
}

export interface ReplaceApproval {
  readonly sourceSessionId: string
  readonly replacedSessionId: string
}

export type BesidePreflightResult =
  | { readonly kind: 'ready'; readonly replaceApproval: ReplaceApproval | null }
  | { readonly kind: 'source-not-visible'; readonly sourceSessionId: string | undefined }
  | { readonly kind: 'cancelled'; readonly sourceSessionId: string; readonly replacedSessionId: string }
  | {
    readonly kind: 'preflight-failed'
    readonly sourceSessionId: string
    readonly phase: 'confirm' | 'capacity'
    readonly error: unknown
  }

export interface BesidePreflightOptions {
  readonly presentation: BesidePresentation
  readonly sourceSessionId: string | undefined
  readonly confirmReplace: (request: ReplaceApproval) => boolean | Promise<boolean>
}

export type BesideOpenResult =
  | {
    readonly kind: 'opened'
    readonly targetSessionId: string
    readonly disposition: 'already-visible' | 'beside' | 'replace-focused'
    readonly verified: boolean
    readonly replacedSessionId?: string
  }
  | {
    readonly kind: 'source-not-visible'
    readonly sourceSessionId: string | undefined
    readonly targetSessionId: string
  }
  | {
    readonly kind: 'cancelled'
    readonly sourceSessionId: string
    readonly targetSessionId: string
    readonly replacedSessionId: string
  }
  | {
    readonly kind: 'open-failed'
    readonly sourceSessionId: string
    readonly targetSessionId: string
    readonly phase: 'confirm' | 'capacity' | 'protect-source' | 'open' | 'focus' | 'verify'
    readonly error: unknown
  }

export interface BesideOpenOptions {
  readonly presentation: BesidePresentation
  /** Captured before any fork/create/confirmation await. */
  readonly sourceSessionId: string | undefined
  readonly targetSessionId: string
  readonly confirmReplace: (request: ReplaceConfirmation) => boolean | Promise<boolean>
  /** `undefined` keeps the original confirm-on-open flow; side-chat passes
   * its pre-fork decision so cancellation can never leave a new child. */
  readonly replaceApproval?: ReplaceApproval | null
}

interface PresentationSnapshot {
  readonly visible: readonly string[]
  readonly focused?: string
}

function readSnapshot(presentation: BesidePresentation): PresentationSnapshot | undefined {
  try {
    const snapshot = presentation.state.getSnapshot()
    if (!Array.isArray(snapshot.visible) || !snapshot.visible.every(id => typeof id === 'string')) return undefined
    return { visible: snapshot.visible, ...(typeof snapshot.focused === 'string' ? { focused: snapshot.focused } : {}) }
  } catch {
    return undefined
  }
}

function verificationError(message: string): Error {
  return new Error('beside-open verification failed: ' + message)
}

/** Capacity/source check that can run before a fork creates durable state. */
export async function preflightBesideOpen(options: BesidePreflightOptions): Promise<BesidePreflightResult> {
  const { presentation, sourceSessionId } = options
  const initial = readSnapshot(presentation)
  if (sourceSessionId === undefined || initial === undefined || !initial.visible.includes(sourceSessionId)) {
    return { kind: 'source-not-visible', sourceSessionId }
  }
  if (initial.visible.length < 2) return { kind: 'ready', replaceApproval: null }
  const replacedSessionId = initial.visible.find(id => id !== sourceSessionId)
  if (replacedSessionId === undefined) return { kind: 'source-not-visible', sourceSessionId }

  let confirmed: boolean
  try {
    confirmed = await options.confirmReplace({ sourceSessionId, replacedSessionId })
  } catch (error) {
    return { kind: 'preflight-failed', sourceSessionId, phase: 'confirm', error }
  }
  if (!confirmed) return { kind: 'cancelled', sourceSessionId, replacedSessionId }

  const current = readSnapshot(presentation)
  if (current === undefined || !current.visible.includes(sourceSessionId)) {
    return { kind: 'source-not-visible', sourceSessionId }
  }
  if (current.visible.length < 2) return { kind: 'ready', replaceApproval: null }
  const currentReplacement = current.visible.find(id => id !== sourceSessionId)
  if (currentReplacement !== replacedSessionId) {
    return {
      kind: 'preflight-failed', sourceSessionId, phase: 'capacity',
      error: verificationError('replacement Pane changed during confirmation'),
    }
  }
  return {
    kind: 'ready',
    replaceApproval: { sourceSessionId, replacedSessionId },
  }
}

function focusAndVerify(
  presentation: BesidePresentation,
  sourceSessionId: string,
  targetSessionId: string,
  disposition: 'already-visible' | 'beside' | 'replace-focused',
  replacedSessionId?: string,
): BesideOpenResult {
  try {
    presentation.focus(targetSessionId)
  } catch (error) {
    return { kind: 'open-failed', sourceSessionId, targetSessionId, phase: 'focus', error }
  }
  const final = readSnapshot(presentation)
  if (final === undefined) {
    return {
      kind: 'opened', targetSessionId, disposition, verified: false,
      ...(replacedSessionId === undefined ? {} : { replacedSessionId }),
    }
  }
  const sourceRetained = sourceSessionId === targetSessionId || final.visible.includes(sourceSessionId)
  if (!sourceRetained || !final.visible.includes(targetSessionId) || final.focused !== targetSessionId) {
    return {
      kind: 'open-failed', sourceSessionId, targetSessionId, phase: 'verify',
      error: verificationError('target is not focused and visible while source remains visible'),
    }
  }
  return {
    kind: 'opened', targetSessionId, disposition, verified: true,
    ...(replacedSessionId === undefined ? {} : { replacedSessionId }),
  }
}

function openWithDisposition(
  presentation: BesidePresentation,
  sourceSessionId: string,
  targetSessionId: string,
  disposition: 'beside' | 'replace-focused',
  replacedSessionId?: string,
): BesideOpenResult {
  try {
    presentation.open(targetSessionId, { disposition })
  } catch (error) {
    return { kind: 'open-failed', sourceSessionId, targetSessionId, phase: 'open', error }
  }
  return focusAndVerify(presentation, sourceSessionId, targetSessionId, disposition, replacedSessionId)
}

/**
 * Open a listed target without ever replacing the captured source Pane.
 * The source identity is caller-owned and never re-derived after awaits.
 */
export async function openBeside(options: BesideOpenOptions): Promise<BesideOpenResult> {
  const { presentation, sourceSessionId, targetSessionId } = options
  const initial = readSnapshot(presentation)
  if (sourceSessionId === undefined || initial === undefined || !initial.visible.includes(sourceSessionId)) {
    return { kind: 'source-not-visible', sourceSessionId, targetSessionId }
  }
  if (initial.visible.includes(targetSessionId)) {
    return focusAndVerify(presentation, sourceSessionId, targetSessionId, 'already-visible')
  }
  if (initial.visible.length === 1) {
    return openWithDisposition(presentation, sourceSessionId, targetSessionId, 'beside')
  }

  const initiallyReplaced = initial.visible.find(id => id !== sourceSessionId)
  if (initiallyReplaced === undefined) {
    return { kind: 'source-not-visible', sourceSessionId, targetSessionId }
  }
  const approval = options.replaceApproval
  if (approval !== undefined) {
    if (approval === null
      || approval.sourceSessionId !== sourceSessionId
      || approval.replacedSessionId !== initiallyReplaced) {
      return {
        kind: 'open-failed', sourceSessionId, targetSessionId, phase: 'capacity',
        error: verificationError('no matching preflight replacement approval'),
      }
    }
  } else {
    let confirmed: boolean
    try {
      confirmed = await options.confirmReplace({
        sourceSessionId,
        replacedSessionId: initiallyReplaced,
        targetSessionId,
      })
    } catch (error) {
      return { kind: 'open-failed', sourceSessionId, targetSessionId, phase: 'confirm', error }
    }
    if (!confirmed) {
      return {
        kind: 'cancelled', sourceSessionId, targetSessionId,
        replacedSessionId: initiallyReplaced,
      }
    }
  }

  // Confirmation is an await boundary. Re-read membership, but never change
  // which Pane is the protected source captured by the caller.
  const current = readSnapshot(presentation)
  if (current === undefined || !current.visible.includes(sourceSessionId)) {
    return { kind: 'source-not-visible', sourceSessionId, targetSessionId }
  }
  if (current.visible.includes(targetSessionId)) {
    return focusAndVerify(presentation, sourceSessionId, targetSessionId, 'already-visible')
  }
  const replacedSessionId = current.visible.find(id => id !== sourceSessionId)
  if (replacedSessionId === undefined) {
    return openWithDisposition(presentation, sourceSessionId, targetSessionId, 'beside')
  }

  // Protocol 2 replaces the focused Pane. Move focus to the non-source Pane
  // and prove that move landed before issuing replace-focused.
  try {
    presentation.focus(replacedSessionId)
  } catch (error) {
    return { kind: 'open-failed', sourceSessionId, targetSessionId, phase: 'protect-source', error }
  }
  const protectedState = readSnapshot(presentation)
  if (protectedState === undefined
    || !protectedState.visible.includes(sourceSessionId)
    || protectedState.focused !== replacedSessionId) {
    return {
      kind: 'open-failed', sourceSessionId, targetSessionId, phase: 'protect-source',
      error: verificationError('non-source Pane did not receive focus'),
    }
  }
  return openWithDisposition(
    presentation,
    sourceSessionId,
    targetSessionId,
    'replace-focused',
    replacedSessionId,
  )
}
