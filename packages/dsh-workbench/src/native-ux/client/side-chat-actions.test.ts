import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  SIDE_CHAT_COPY,
  composeMoreDetailsPrompt,
  createSideChatActions,
  type SideChatActionDependencies,
} from './side-chat-actions.js'
import type {
  ConversationFace,
  HarnessServices,
  SessionInputFace,
  SessionScope,
} from './harness-adapter.js'
import type { ConversationSelection } from './selection-contract.js'

type ForkMock = Mock<(options: {
  sessionId: string
  atSeq?: number
  increaseTitle?: boolean
}) => Promise<string>>
type SendMock = Mock<(text: string) => Promise<void>>

function capturedSelection(overrides: Partial<ConversationSelection> = {}): ConversationSelection {
  return {
    parentSessionId: 'source',
    nodeKey: 'node-1',
    nodeKind: 'assistant',
    atSeq: 42,
    text: 'selected text',
    startOffset: 3,
    endOffset: 16,
    rect: { x: 10, y: 20, width: 100, height: 24 },
    ...overrides,
  }
}

function presentationFixture(
  visible: string[] = ['source'],
  focused = 'source',
  options: { readonly openError?: Error } = {},
) {
  const state = { visible: [...visible], focused }
  const calls: string[] = []
  const presentation = {
    protocol: 2 as const,
    state: { getSnapshot: () => ({ visible: [...state.visible], focused: state.focused, capacity: 2 }) },
    open: vi.fn((id: string, request?: { disposition?: 'beside' | 'replace-focused' }) => {
      calls.push('open:' + request?.disposition + ':' + id)
      if (options.openError !== undefined) throw options.openError
      if (request?.disposition === 'beside') {
        state.visible.splice(state.visible.indexOf(state.focused) + 1, 0, id)
      } else {
        state.visible[state.visible.indexOf(state.focused)] = id
      }
      state.focused = id
    }),
    focus: vi.fn((id: string) => {
      calls.push('focus:' + id)
      if (state.visible.includes(id)) state.focused = id
    }),
    close: vi.fn(),
  }
  return { presentation, state, calls }
}

function inputFace(): SessionInputFace {
  return {
    state: {
      getSnapshot: () => ({ draft: '', draftRev: 0 }),
      subscribe: () => () => {},
    },
    setDraft: vi.fn(),
    insertReference: vi.fn(() => true),
  }
}

function harness(options: {
  readonly visible?: string[]
  readonly focused?: string
  readonly openError?: Error
  readonly fork?: ForkMock
  readonly send?: SendMock
} = {}) {
  const pane = presentationFixture(options.visible, options.focused, { openError: options.openError })
  const send: SendMock = options.send ?? vi.fn(async (_text: string) => {})
  const input = inputFace()
  const conversation: ConversationFace = {
    send,
    input: { for: vi.fn(() => input) },
  }
  const childScope: SessionScope = { get: vi.fn(() => conversation) }
  const fork: ForkMock = options.fork ?? vi.fn(async (_request) => 'child')
  const scope = vi.fn((id: string) => id === 'child' ? childScope : undefined)
  const services: HarnessServices = {
    sessions: { scope, fork, presentation: pane.presentation },
  }
  return { ...pane, services, fork, scope, childScope, conversation, send, input }
}

function dependencies(
  fixture: ReturnType<typeof harness>,
  overrides: Partial<SideChatActionDependencies> = {},
): SideChatActionDependencies {
  return {
    services: fixture.services,
    revalidateSelection: vi.fn(() => true),
    confirmReplace: vi.fn(() => true),
    insertDraftReference: vi.fn(async () => {}),
    focusComposer: vi.fn(async () => true),
    ...overrides,
  }
}

describe('createSideChatActions capability and source gates', () => {
  it('is unavailable on stock capability and performs no validation or mutation', async () => {
    const revalidateSelection = vi.fn(() => true)
    const actions = createSideChatActions({
      services: { sessions: { scope: vi.fn() } },
      revalidateSelection,
      confirmReplace: vi.fn(),
      insertDraftReference: vi.fn(),
    })
    expect(actions.available).toBe(false)
    await expect(actions.moreDetails(capturedSelection())).resolves.toMatchObject({
      kind: 'unavailable',
      status: { code: 'side-chat-unavailable', level: 'error' },
    })
    expect(revalidateSelection).not.toHaveBeenCalled()
  })

  it('revalidates the frozen selection before mutation and fails stale without forking', async () => {
    const fixture = harness()
    const revalidateSelection = vi.fn(() => false)
    const actions = createSideChatActions(dependencies(fixture, { revalidateSelection }))
    await expect(actions.moreDetails(capturedSelection())).resolves.toMatchObject({
      kind: 'stale-selection', status: { code: 'selection-stale' },
    })
    expect(revalidateSelection).toHaveBeenCalledWith(capturedSelection())
    expect(fixture.fork).not.toHaveBeenCalled()
    expect(fixture.presentation.open).not.toHaveBeenCalled()
  })

  it('fails before fork when the captured source Pane is no longer visible', async () => {
    const fixture = harness({ visible: ['other'], focused: 'other' })
    const actions = createSideChatActions(dependencies(fixture))
    await expect(actions.moreDetails(capturedSelection())).resolves.toMatchObject({
      kind: 'source-not-visible', status: { code: 'source-not-visible' },
    })
    expect(fixture.fork).not.toHaveBeenCalled()
  })
})

describe('side-chat preflight and fork/open lifecycle', () => {
  it('cancels at full capacity before a child is forked', async () => {
    const fixture = harness({ visible: ['source', 'other'] })
    const confirmReplace = vi.fn<SideChatActionDependencies['confirmReplace']>(() => false)
    const actions = createSideChatActions(dependencies(fixture, { confirmReplace }))
    await expect(actions.moreDetails(capturedSelection())).resolves.toMatchObject({
      kind: 'cancelled', replacedSessionId: 'other',
      status: { code: 'replace-cancelled', replacedSessionId: 'other' },
    })
    expect(confirmReplace).toHaveBeenCalledOnce()
    expect(confirmReplace.mock.calls[0]?.[0]).toMatchObject({
      action: 'more-details', sourceSessionId: 'source', replacedSessionId: 'other',
      status: { code: 'confirm-replace' },
    })
    expect(fixture.fork).not.toHaveBeenCalled()
    expect(fixture.presentation.open).not.toHaveBeenCalled()
  })

  it('confirms once, forks the completed-turn prefix, and replaces only the non-source Pane', async () => {
    const fixture = harness({ visible: ['source', 'other'] })
    const confirmReplace = vi.fn(async () => true)
    const actions = createSideChatActions(dependencies(fixture, { confirmReplace }))
    await expect(actions.moreDetails(capturedSelection())).resolves.toMatchObject({
      kind: 'opened', childId: 'child', delivery: 'sent',
    })
    expect(confirmReplace).toHaveBeenCalledOnce()
    expect(fixture.fork).toHaveBeenCalledOnce()
    expect(fixture.fork).toHaveBeenCalledWith({
      sessionId: 'source', atSeq: 42, increaseTitle: true,
    })
    expect(fixture.state).toEqual({ visible: ['source', 'child'], focused: 'child' })
    expect(fixture.presentation.close).not.toHaveBeenCalled()
  })

  it('coalesces a double click into the exact same Promise, one child, and one send', async () => {
    let resolveFork: ((childId: string) => void) | undefined
    const fork = vi.fn(() => new Promise<string>(resolve => { resolveFork = resolve }))
    const fixture = harness({ fork })
    const actions = createSideChatActions(dependencies(fixture))
    const selection = capturedSelection()

    const first = actions.moreDetails(selection)
    const second = actions.moreDetails(selection)
    expect(second).toBe(first)
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(fork).toHaveBeenCalledOnce()
    resolveFork?.('child')

    await expect(first).resolves.toMatchObject({ kind: 'opened', childId: 'child' })
    expect(fork).toHaveBeenCalledOnce()
    expect(fixture.send).toHaveBeenCalledOnce()
  })

  it('reports fork failure before any child navigation or delivery', async () => {
    const failure = new Error('fork unavailable')
    const fixture = harness()
    fixture.fork.mockRejectedValue(failure)
    const actions = createSideChatActions(dependencies(fixture))
    await expect(actions.moreDetails(capturedSelection())).resolves.toEqual({
      kind: 'failed', action: 'more-details', stage: 'fork', error: failure,
      status: { code: 'fork-failed', level: 'error', action: 'more-details' },
    })
    expect(fixture.presentation.open).not.toHaveBeenCalled()
    expect(fixture.send).not.toHaveBeenCalled()
  })

  it('retains and reports the child when source disappears after fork', async () => {
    const fixture = harness()
    fixture.fork.mockImplementation(async () => {
      fixture.state.visible = ['other']
      fixture.state.focused = 'other'
      return 'child'
    })
    const actions = createSideChatActions(dependencies(fixture))
    await expect(actions.moreDetails(capturedSelection())).resolves.toMatchObject({
      kind: 'partial', childId: 'child', stage: 'source-not-visible',
      status: { code: 'child-open-partial', childId: 'child' },
    })
    expect(fixture.send).not.toHaveBeenCalled()
    expect(fixture.presentation.close).not.toHaveBeenCalled()
  })

  it('retains and reports the child when Pane open fails', async () => {
    const failure = new Error('open failed')
    const fixture = harness({ openError: failure })
    const actions = createSideChatActions(dependencies(fixture))
    await expect(actions.moreDetails(capturedSelection())).resolves.toEqual({
      kind: 'partial', action: 'more-details', childId: 'child', stage: 'open', error: failure,
      status: {
        code: 'child-open-partial', level: 'error', action: 'more-details', childId: 'child',
      },
    })
    expect(fixture.send).not.toHaveBeenCalled()
    expect(fixture.presentation.close).not.toHaveBeenCalled()
  })
})

describe('More Details delivery', () => {
  it('sends exactly one escaped, separated boundary/context/request prompt through the child scope', async () => {
    const fixture = harness()
    const selection = capturedSelection({ text: '<tag attr="x">Tom & Jerry\'s</tag>' })
    const actions = createSideChatActions(dependencies(fixture, { copy: SIDE_CHAT_COPY.en }))
    await expect(actions.moreDetails(selection)).resolves.toMatchObject({
      kind: 'opened', childId: 'child', delivery: 'sent',
      status: { code: 'child-opened-and-sent' },
    })

    expect(fixture.scope).toHaveBeenCalledWith('child')
    expect(fixture.send).toHaveBeenCalledOnce()
    const prompt = fixture.send.mock.calls[0]?.[0] as string
    expect(prompt).toContain('<side_chat_boundary>\nInherited conversation history is reference-only.')
    expect(prompt).toContain('The current task begins after this boundary.')
    expect(prompt).toContain('lightweight, non-modifying explanation')
    expect(prompt).toContain('<selected_context version="side-chat-v1" parent_session_id="source" node_key="node-1" node_kind="assistant" at_seq="42" start_offset="3" end_offset="16">\n&lt;tag attr=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/tag&gt;\n</selected_context>')
    expect(prompt).toContain('<request>\nExplain the selected context in more detail.\n</request>')
    expect(fixture.presentation.close).not.toHaveBeenCalled()
  })

  it('supports Chinese-localized boundary and fixed request copy', () => {
    const prompt = composeMoreDetailsPrompt(capturedSelection(), SIDE_CHAT_COPY.zh)
    expect(prompt).toContain('继承的会话历史仅供参考')
    expect(prompt).toContain('当前任务从此边界之后开始')
    expect(prompt).toContain('<request>\n请更详细地解释所选上下文。\n</request>')
  })

  it('returns a typed partial with retained child when send fails', async () => {
    const failure = new Error('send failed')
    const fixture = harness({ send: vi.fn(async () => { throw failure }) })
    const actions = createSideChatActions(dependencies(fixture))
    await expect(actions.moreDetails(capturedSelection())).resolves.toEqual({
      kind: 'partial', action: 'more-details', childId: 'child', stage: 'send', error: failure,
      status: {
        code: 'child-send-partial', level: 'error', action: 'more-details', childId: 'child',
      },
    })
    expect(fixture.send).toHaveBeenCalledOnce()
    expect(fixture.presentation.close).not.toHaveBeenCalled()
  })
})

describe('Ask in side chat draft delivery', () => {
  it('inserts one structured reference with empty ordinary draft, never sends, then focuses child', async () => {
    const fixture = harness()
    const order: string[] = []
    const insertDraftReference = vi.fn<SideChatActionDependencies['insertDraftReference']>(async () => { order.push('draft') })
    const focusComposer = vi.fn(async () => { order.push('focus'); return true })
    const actions = createSideChatActions(dependencies(fixture, {
      insertDraftReference,
      focusComposer,
    }))
    const selection = capturedSelection()
    await expect(actions.askInSideChat(selection)).resolves.toMatchObject({
      kind: 'opened', action: 'ask-in-side-chat', childId: 'child', delivery: 'draft',
      status: { code: 'child-opened-with-draft' },
    })

    expect(insertDraftReference).toHaveBeenCalledOnce()
    expect(insertDraftReference.mock.calls[0]?.[0]).toMatchObject({
      childId: 'child',
      input: fixture.input,
      ordinaryDraft: '',
      reference: {
        version: 'side-chat-v1',
        kind: 'side-chat-selection',
        referenceBoundary: SIDE_CHAT_COPY.en.referenceBoundary,
        parentSessionId: 'source',
        nodeKey: 'node-1',
        nodeKind: 'assistant',
        atSeq: 42,
        text: 'selected text',
        startOffset: 3,
        endOffset: 16,
        rect: { x: 10, y: 20, width: 100, height: 24 },
      },
    })
    expect(order).toEqual(['draft', 'focus'])
    expect(focusComposer).toHaveBeenCalledWith('child')
    expect(fixture.send).not.toHaveBeenCalled()
    expect(fixture.presentation.close).not.toHaveBeenCalled()
  })

  it('retains the child and reports draft or focus mutation failure', async () => {
    const draftFailure = new Error('draft failed')
    const draftFixture = harness()
    const draftActions = createSideChatActions(dependencies(draftFixture, {
      insertDraftReference: vi.fn(async () => { throw draftFailure }),
    }))
    await expect(draftActions.askInSideChat(capturedSelection())).resolves.toMatchObject({
      kind: 'partial', childId: 'child', stage: 'draft', error: draftFailure,
      status: { code: 'child-draft-partial' },
    })
    expect(draftFixture.send).not.toHaveBeenCalled()
    expect(draftFixture.presentation.close).not.toHaveBeenCalled()

    const focusFixture = harness()
    const focusActions = createSideChatActions(dependencies(focusFixture, {
      focusComposer: vi.fn(async () => false),
    }))
    await expect(focusActions.askInSideChat(capturedSelection())).resolves.toMatchObject({
      kind: 'partial', childId: 'child', stage: 'focus',
      status: { code: 'child-focus-partial' },
    })
    expect(focusFixture.send).not.toHaveBeenCalled()
    expect(focusFixture.presentation.close).not.toHaveBeenCalled()
  })
})
