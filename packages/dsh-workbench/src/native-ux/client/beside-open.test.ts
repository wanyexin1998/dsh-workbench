import { describe, expect, it, vi } from 'vitest'
import { openBeside, preflightBesideOpen, type BesidePresentation } from './beside-open.js'

/**
 * Host responses that each break exactly one post-open verification predicate:
 * `evict-source` drops the source Pane, `no-membership` reports focus for a
 * target that never joined `visible`, `no-focus` lists the target but leaves
 * focus where it was.
 */
type OpenEffect = 'evict-source' | 'no-membership' | 'no-focus'

function presentationFixture(
  visible: string[],
  focused: string,
  options: {
    readonly focusNoop?: boolean
    readonly openError?: Error
    readonly openEffect?: OpenEffect
  } = {},
) {
  const state = { visible: [...visible], focused }
  const calls: string[] = []
  const presentation: BesidePresentation = {
    state: { getSnapshot: () => ({ visible: [...state.visible], focused: state.focused }) },
    focus: vi.fn((id: string) => {
      calls.push('focus:' + id)
      if (!options.focusNoop && state.visible.includes(id)) state.focused = id
    }),
    open: vi.fn((id: string, request: { disposition: 'beside' | 'replace-focused' }) => {
      calls.push('open:' + request.disposition + ':' + id)
      if (options.openError !== undefined) throw options.openError
      if (options.openEffect === 'evict-source') {
        state.visible = [id]
        state.focused = id
        return
      }
      if (options.openEffect === 'no-membership') {
        state.focused = id
        return
      }
      if (request.disposition === 'beside') {
        const at = state.visible.indexOf(state.focused)
        state.visible.splice(at + 1, 0, id)
      } else {
        const at = state.visible.indexOf(state.focused)
        state.visible[at] = id
      }
      if (options.openEffect !== 'no-focus') state.focused = id
    }),
  }
  return { presentation, state, calls }
}

describe('openBeside', () => {
  it('preflights a full layout once and reuses that approval after child creation', async () => {
    const { presentation, state } = presentationFixture(['source', 'other'], 'source')
    const confirmReplace = vi.fn(async () => true)
    const preflight = await preflightBesideOpen({
      presentation,
      sourceSessionId: 'source',
      confirmReplace,
    })
    expect(preflight).toEqual({
      kind: 'ready',
      replaceApproval: { sourceSessionId: 'source', replacedSessionId: 'other' },
    })

    const lateConfirm = vi.fn(() => false)
    const result = await openBeside({
      presentation,
      sourceSessionId: 'source',
      targetSessionId: 'child',
      confirmReplace: lateConfirm,
      replaceApproval: preflight.kind === 'ready' ? preflight.replaceApproval : null,
    })
    expect(confirmReplace).toHaveBeenCalledOnce()
    expect(lateConfirm).not.toHaveBeenCalled()
    expect(result).toMatchObject({ kind: 'opened', disposition: 'replace-focused' })
    expect(state.visible).toEqual(['source', 'child'])
  })

  it('preflight cancellation happens before any target exists', async () => {
    const { presentation, calls } = presentationFixture(['source', 'other'], 'source')
    await expect(preflightBesideOpen({
      presentation,
      sourceSessionId: 'source',
      confirmReplace: () => false,
    })).resolves.toEqual({
      kind: 'cancelled', sourceSessionId: 'source', replacedSessionId: 'other',
    })
    expect(calls).toEqual([])
  })

  it('refuses an unapproved capacity change instead of confirming after creation', async () => {
    const { presentation, state, calls } = presentationFixture(['source'], 'source')
    const preflight = await preflightBesideOpen({
      presentation,
      sourceSessionId: 'source',
      confirmReplace: vi.fn(),
    })
    expect(preflight).toEqual({ kind: 'ready', replaceApproval: null })
    state.visible.push('other')
    const confirmReplace = vi.fn(() => true)
    const result = await openBeside({
      presentation,
      sourceSessionId: 'source',
      targetSessionId: 'child',
      confirmReplace,
      replaceApproval: null,
    })
    expect(result).toMatchObject({ kind: 'open-failed', phase: 'capacity' })
    expect(confirmReplace).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('opens beside one visible source, then focuses and verifies the target', async () => {
    const { presentation, state, calls } = presentationFixture(['source'], 'source')
    const result = await openBeside({
      presentation,
      sourceSessionId: 'source',
      targetSessionId: 'chat',
      confirmReplace: vi.fn(),
    })

    expect(result).toEqual({
      kind: 'opened', targetSessionId: 'chat', disposition: 'beside', verified: true,
    })
    expect(calls).toEqual(['open:beside:chat', 'focus:chat'])
    expect(state).toEqual({ visible: ['source', 'chat'], focused: 'chat' })
  })

  it('confirms at capacity, focuses and verifies the non-source Pane, then replaces it', async () => {
    const { presentation, state, calls } = presentationFixture(['source', 'other'], 'source')
    const confirmReplace = vi.fn(async () => true)
    const result = await openBeside({
      presentation,
      sourceSessionId: 'source',
      targetSessionId: 'chat',
      confirmReplace,
    })

    expect(confirmReplace).toHaveBeenCalledWith({
      sourceSessionId: 'source', replacedSessionId: 'other', targetSessionId: 'chat',
    })
    expect(calls).toEqual([
      'focus:other',
      'open:replace-focused:chat',
      'focus:chat',
    ])
    expect(state).toEqual({ visible: ['source', 'chat'], focused: 'chat' })
    expect(result).toEqual({
      kind: 'opened', targetSessionId: 'chat', disposition: 'replace-focused',
      verified: true, replacedSessionId: 'other',
    })
  })

  it('returns cancelled without changing focus or membership', async () => {
    const { presentation, state, calls } = presentationFixture(['source', 'other'], 'source')
    const result = await openBeside({
      presentation,
      sourceSessionId: 'source',
      targetSessionId: 'chat',
      confirmReplace: () => false,
    })

    expect(result).toEqual({
      kind: 'cancelled', sourceSessionId: 'source', targetSessionId: 'chat',
      replacedSessionId: 'other',
    })
    expect(calls).toEqual([])
    expect(state).toEqual({ visible: ['source', 'other'], focused: 'source' })
  })

  it('rejects a source that is absent from visible membership', async () => {
    const { presentation, calls } = presentationFixture(['other'], 'other')
    await expect(openBeside({
      presentation,
      sourceSessionId: 'source',
      targetSessionId: 'chat',
      confirmReplace: vi.fn(),
    })).resolves.toEqual({
      kind: 'source-not-visible', sourceSessionId: 'source', targetSessionId: 'chat',
    })
    expect(calls).toEqual([])
  })

  it('fails before replacement when the non-source focus cannot be verified', async () => {
    const { presentation, calls } = presentationFixture(
      ['source', 'other'],
      'source',
      { focusNoop: true },
    )
    const result = await openBeside({
      presentation,
      sourceSessionId: 'source',
      targetSessionId: 'chat',
      confirmReplace: () => true,
    })

    expect(result).toMatchObject({ kind: 'open-failed', phase: 'protect-source' })
    expect(calls).toEqual(['focus:other'])
  })

  it('reports an open failure without hiding the target identity', async () => {
    const failure = new Error('host rejected open')
    const { presentation } = presentationFixture(['source'], 'source', { openError: failure })
    await expect(openBeside({
      presentation,
      sourceSessionId: 'source',
      targetSessionId: 'chat-created',
      confirmReplace: vi.fn(),
    })).resolves.toEqual({
      kind: 'open-failed', sourceSessionId: 'source', targetSessionId: 'chat-created',
      phase: 'open', error: failure,
    })
  })
})

const VERIFY_MESSAGE =
  'beside-open verification failed: target is not focused and visible while source remains visible'

/**
 * Mutation pins for the post-open verification block. Deleting it leaves every
 * other test green because the happy paths already end focused and visible;
 * these three cases are the only ones that separate "the host did what we
 * asked" from "we reported success on trust". Each failure is what
 * side-chat-actions turns into `child-open-partial` (stage `open`), so a
 * silently-dropped check would report a fork as fully opened.
 */
describe('openBeside post-open verification', () => {
  it('fails verification when the host evicts the source Pane while opening the target', async () => {
    const { presentation, state, calls } = presentationFixture(['source'], 'source', {
      openEffect: 'evict-source',
    })
    const result = await openBeside({
      presentation,
      sourceSessionId: 'source',
      targetSessionId: 'chat',
      confirmReplace: vi.fn(),
    })

    expect(result).toMatchObject({
      kind: 'open-failed', sourceSessionId: 'source', targetSessionId: 'chat', phase: 'verify',
    })
    expect((result as { error: Error }).error.message).toBe(VERIFY_MESSAGE)
    expect(calls).toEqual(['open:beside:chat', 'focus:chat'])
    // Reported as a failure even though the target itself is focused and visible.
    expect(state).toEqual({ visible: ['chat'], focused: 'chat' })
  })

  it('fails verification when the target never joins visible membership', async () => {
    const { presentation, state, calls } = presentationFixture(['source'], 'source', {
      openEffect: 'no-membership',
    })
    const result = await openBeside({
      presentation,
      sourceSessionId: 'source',
      targetSessionId: 'chat',
      confirmReplace: vi.fn(),
    })

    expect(result).toMatchObject({
      kind: 'open-failed', sourceSessionId: 'source', targetSessionId: 'chat', phase: 'verify',
    })
    expect((result as { error: Error }).error.message).toBe(VERIFY_MESSAGE)
    expect(calls).toEqual(['open:beside:chat', 'focus:chat'])
    expect(state).toEqual({ visible: ['source'], focused: 'chat' })
  })

  it('fails verification when the target is visible but focus never lands on it', async () => {
    const { presentation, state, calls } = presentationFixture(['source'], 'source', {
      openEffect: 'no-focus', focusNoop: true,
    })
    const result = await openBeside({
      presentation,
      sourceSessionId: 'source',
      targetSessionId: 'chat',
      confirmReplace: vi.fn(),
    })

    expect(result).toMatchObject({
      kind: 'open-failed', sourceSessionId: 'source', targetSessionId: 'chat', phase: 'verify',
    })
    expect((result as { error: Error }).error.message).toBe(VERIFY_MESSAGE)
    expect(calls).toEqual(['open:beside:chat', 'focus:chat'])
    expect(state).toEqual({ visible: ['source', 'chat'], focused: 'source' })
  })

  it('never reports verified on the replace-focused path when the source is evicted', async () => {
    const { presentation, calls } = presentationFixture(['source', 'other'], 'source', {
      openEffect: 'evict-source',
    })
    const result = await openBeside({
      presentation,
      sourceSessionId: 'source',
      targetSessionId: 'chat',
      confirmReplace: () => true,
    })

    expect(result).toMatchObject({
      kind: 'open-failed', sourceSessionId: 'source', targetSessionId: 'chat', phase: 'verify',
    })
    expect((result as { error: Error }).error.message).toBe(VERIFY_MESSAGE)
    expect(calls).toEqual(['focus:other', 'open:replace-focused:chat', 'focus:chat'])
  })
})

describe('openBeside already-visible fast path', () => {
  it('focuses an already-visible target without re-confirming capacity or re-opening', async () => {
    const { presentation, state, calls } = presentationFixture(['source', 'chat'], 'source')
    const confirmReplace = vi.fn(() => true)
    const result = await openBeside({
      presentation,
      sourceSessionId: 'source',
      targetSessionId: 'chat',
      confirmReplace,
    })

    expect(result).toEqual({
      kind: 'opened', targetSessionId: 'chat', disposition: 'already-visible', verified: true,
    })
    // Without the fast path the layout reads as full and 'chat' becomes the
    // replacement candidate for its own re-open.
    expect(confirmReplace).not.toHaveBeenCalled()
    expect(calls).toEqual(['focus:chat'])
    expect(state).toEqual({ visible: ['source', 'chat'], focused: 'chat' })
  })

  it('still verifies the fast path instead of trusting existing membership', async () => {
    const { presentation, calls } = presentationFixture(['source', 'chat'], 'source', {
      focusNoop: true,
    })
    const result = await openBeside({
      presentation,
      sourceSessionId: 'source',
      targetSessionId: 'chat',
      confirmReplace: vi.fn(),
    })

    expect(result).toMatchObject({
      kind: 'open-failed', sourceSessionId: 'source', targetSessionId: 'chat', phase: 'verify',
    })
    expect(calls).toEqual(['focus:chat'])
  })
})
