// @vitest-environment jsdom
import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addSelectionToConversation, createSelectionItemId, SelectionDock, SelectionToolbar,
  type SelectionApplyServices,
} from './selection-actions.js'
import { SelectionController } from './selection-controller.js'
import type { ConversationSelection } from './selection-contract.js'
import {
  encodeSelectionAggregate, SELECTION_AGGREGATE_VERSION, SELECTION_REFERENCE_SOURCE,
  type SelectionAggregateV1,
} from './selection-reference.js'
import type { SideChatActions, SideChatResult } from './side-chat-actions.js'

const t = (key: string, vars?: Record<string, string>) => key === 'selection.side.partial'
  ? `${key} ${vars?.childId ?? ''}`.trim()
  : key

function selection(): ConversationSelection {
  return {
    parentSessionId: 's', nodeKey: 'n', nodeKind: 'user', atSeq: 1,
    text: 'selected', startOffset: 0, endOffset: 8,
    rect: { x: 100, y: 80, width: 20, height: 10 },
  }
}

function controllerWith(value: ConversationSelection | null): SelectionController {
  const snapshot = { selection: value }
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    clear: vi.fn(),
  } as unknown as SelectionController
}

function sideChat(
  moreDetails: SideChatActions['moreDetails'] = vi.fn(),
  askInSideChat: SideChatActions['askInSideChat'] = vi.fn(),
): SideChatActions {
  return { available: true, moreDetails, askInSideChat }
}

function opened(action: 'more-details' | 'ask-in-side-chat'): SideChatResult {
  return {
    kind: 'opened', action, childId: 'child',
    delivery: action === 'more-details' ? 'sent' : 'draft',
    status: {
      code: action === 'more-details' ? 'child-opened-and-sent' : 'child-opened-with-draft',
      level: 'success', action, childId: 'child',
    },
  }
}

afterEach(cleanup)

describe('SelectionToolbar', () => {
  it('renders one accessible action and sends the captured selection', () => {
    const captured = selection()
    const onAdd = vi.fn(() => ({ ok: true }))
    render(<SelectionToolbar controller={controllerWith(captured)} onAdd={onAdd} t={t} />)
    expect(screen.getByRole('toolbar', { name: 'selection.toolbar.label' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'selection.add' }))
    expect(onAdd).toHaveBeenCalledWith(captured)
  })

  it('surfaces a failed stale/CAS action through an aria status', () => {
    render(<SelectionToolbar
      controller={controllerWith(selection())}
      onAdd={() => ({ ok: false, message: 'stale selection' })}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'selection.add' }))
    expect(screen.getByRole('status').textContent).toBe('stale selection')
  })

  it('renders nothing without a valid selection', () => {
    render(<SelectionToolbar controller={controllerWith(null)} onAdd={() => ({ ok: true })} t={t} />)
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('renders Add only on stock and all three actions when side chat is available', () => {
    const captured = selection()
    const { rerender } = render(
      <SelectionToolbar controller={controllerWith(captured)} onAdd={() => ({ ok: true })} t={t} />,
    )
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'selection.add' })).toBeTruthy()

    rerender(<SelectionToolbar
      controller={controllerWith(captured)}
      onAdd={() => ({ ok: true })}
      sideChat={sideChat()}
      t={t}
    />)
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'selection.moreDetails' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'selection.askInSideChat' })).toBeTruthy()
  })

  it('shares one pending gate across side buttons and ignores a double click', async () => {
    let resolve: ((result: SideChatResult) => void) | undefined
    const moreDetails = vi.fn(() => new Promise<SideChatResult>((done) => { resolve = done }))
    const controller = controllerWith(selection())
    render(<SelectionToolbar
      controller={controller}
      onAdd={() => ({ ok: true })}
      sideChat={sideChat(moreDetails)}
      t={t}
    />)
    const button = screen.getByRole('button', { name: 'selection.moreDetails' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(moreDetails).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toBe('selection.side.pending')
    expect(screen.getAllByRole('button').every((item) => (item as HTMLButtonElement).disabled)).toBe(true)

    await act(async () => {
      resolve?.({
        kind: 'cancelled', action: 'more-details', replacedSessionId: 'other',
        status: { code: 'replace-cancelled', level: 'info', action: 'more-details' },
      })
    })
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('selection.side.cancelled'))
    expect(controller.clear).not.toHaveBeenCalled()
    expect(screen.getByRole('toolbar')).toBeTruthy()
  })

  it.each([
    ['selection.moreDetails', 'more-details' as const],
    ['selection.askInSideChat', 'ask-in-side-chat' as const],
  ])('clears the captured selection after %s success', async (label, action) => {
    const controller = controllerWith(selection())
    const moreDetails = vi.fn(async () => opened('more-details'))
    const askInSideChat = vi.fn(async () => opened('ask-in-side-chat'))
    render(<SelectionToolbar
      controller={controller}
      onAdd={() => ({ ok: true })}
      sideChat={sideChat(moreDetails, askInSideChat)}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect(controller.clear).toHaveBeenCalledOnce())
    expect(action === 'more-details' ? moreDetails : askInSideChat).toHaveBeenCalledOnce()
  })

  it.each([
    [{
      kind: 'partial', action: 'more-details', childId: 'child-retained', stage: 'open',
      status: { code: 'child-open-partial', level: 'error', action: 'more-details', childId: 'child-retained' },
    } satisfies SideChatResult, 'selection.side.partial child-retained'],
    [{
      kind: 'stale-selection', action: 'more-details',
      status: { code: 'selection-stale', level: 'error', action: 'more-details' },
    } satisfies SideChatResult, 'selection.error.stale'],
    [{
      kind: 'failed', action: 'more-details', stage: 'fork', error: new Error('fork'),
      status: { code: 'fork-failed', level: 'error', action: 'more-details' },
    } satisfies SideChatResult, 'selection.side.error.failed'],
  ])('retains the toolbar and renders a visible alert for %s', async (result, expected) => {
    const controller = controllerWith(selection())
    render(<SelectionToolbar
      controller={controller}
      onAdd={() => ({ ok: true })}
      sideChat={sideChat(vi.fn(async () => result))}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'selection.moreDetails' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(expected))
    expect(controller.clear).not.toHaveBeenCalled()
    expect(screen.getByRole('toolbar')).toBeTruthy()
  })
})

describe('SelectionDock', () => {
  it('edits comments and removes ordered aggregate items through injected actions', () => {
    const aggregate: SelectionAggregateV1 = {
      version: SELECTION_AGGREGATE_VERSION,
      items: [
        { id: 'one', parentSessionId: 's', nodeKey: 'n1', nodeKind: 'user', atSeq: 1, text: 'first', startOffset: 0, endOffset: 5 },
        { id: 'two', parentSessionId: 's', nodeKey: 'n2', nodeKind: 'user', atSeq: 2, text: 'second', startOffset: 0, endOffset: 6 },
      ],
    }
    const ref = encodeSelectionAggregate(aggregate)
    const input = {
      draft: 'Selected context ', draftRev: 1,
      occurrences: [{ source: SELECTION_REFERENCE_SOURCE, ref, offset: 0, length: 16 }],
    }
    const updateComment = vi.fn(() => ({ ok: true as const, aggregate }))
    const removeItem = vi.fn(() => ({ ok: true as const, aggregate }))
    render(<SelectionDock
      sessionId="s"
      session={{ sessionId: 's' }}
      input={input}
      updateComment={updateComment}
      removeItem={removeItem}
      t={t}
    />)

    expect(screen.getByLabelText('selection.dock.label').textContent).toContain('(2)')
    const comment = screen.getByLabelText('selection.comment 1')
    fireEvent.change(comment, { target: { value: 'important' } })
    fireEvent.blur(comment)
    expect(updateComment).toHaveBeenCalledWith('one', 'important')
    fireEvent.click(screen.getByRole('button', { name: 'selection.remove 2' }))
    expect(removeItem).toHaveBeenCalledWith('two')
  })
})

describe('createSelectionItemId', () => {
  it('produces reload-safe non-counter ids', () => {
    const first = createSelectionItemId()
    const second = createSelectionItemId()
    expect(first).toMatch(/^selection-/)
    expect(second).toMatch(/^selection-/)
    expect(second).not.toBe(first)
    expect(first).not.toBe('selection-1')
  })
})

describe('addSelectionToConversation routing', () => {
  it('writes to the captured left Session after focus switches right', () => {
    const node = { key: 'left-node', kind: 'user', anchorSeq: 9, visibility: 'visible', data: {} }
    const face = {
      getSnapshot: () => ({ sessionId: 'left', chat: { nodes: { get: (key: string) => key === 'left-node' ? node : undefined } } }),
      subscribe: () => () => {},
    }
    const leftScope = { id: 'left', bail: vi.fn() }
    const rightScope = { id: 'right', bail: vi.fn() }
    let focused = 'left'
    const sessions = {
      list: { getSnapshot: () => ({ current: focused }) },
      presentation: { state: { getSnapshot: () => ({ visible: ['left', 'right'], focused }) } },
      scope: (id: string) => id === 'left' ? leftScope : rightScope,
      sessionOf: (scope: unknown) => (scope as { id: string }).id === 'left' ? face : undefined,
    }
    const makeInput = () => {
      let snapshot = { draft: 'draft', draftRev: 0, occurrences: [] as Array<Record<string, unknown>> }
      return {
        state: { getSnapshot: () => snapshot },
        insertReference: vi.fn((reference: { source: string; ref: string; label: string }, span: { draftRev: number }) => {
          if (span.draftRev !== snapshot.draftRev) return false
          snapshot = {
            draft: snapshot.draft + reference.label + ' ',
            draftRev: snapshot.draftRev + 1,
            occurrences: [{ source: reference.source, ref: reference.ref, offset: 5, length: reference.label.length }],
          }
          return true
        }),
        notify: vi.fn(),
      }
    }
    const leftInput = makeInput()
    const rightInput = makeInput()
    const services = {
      sessions,
      conversation: { input: { for: (scope: unknown) => (scope as { id: string }).id === 'left' ? leftInput : rightInput } },
    } as unknown as SelectionApplyServices

    const pane = document.createElement('section')
    pane.dataset.sessionPane = 'left'
    const root = document.createElement('main')
    root.className = 'ConversationRoot_root'
    root.dataset.phase = 'ready'
    const flow = document.createElement('div')
    flow.dataset.chatFlow = ''
    const row = document.createElement('article')
    row.dataset.chatAnchorKey = 'left-anchor'
    row.dataset.chatFlowKey = 'left-node'
    row.dataset.chatFlowKind = 'user'
    const text = document.createTextNode('left selection')
    row.append(text)
    flow.append(row)
    const seat = document.createElement('div')
    seat.dataset.composerSeat = ''
    const composer = document.createElement('textarea')
    seat.append(composer)
    root.append(flow, seat)
    pane.append(root)
    document.body.append(pane)
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, text.length)

    const controller = new SelectionController(sessions)
    const captured = controller.captureRange(range)
    expect(captured?.parentSessionId).toBe('left')
    focused = 'right'
    expect(addSelectionToConversation(controller, services, captured!, 'selection-uuid', t)).toEqual({ ok: true })
    expect(leftInput.insertReference).toHaveBeenCalledTimes(1)
    expect(rightInput.insertReference).not.toHaveBeenCalled()
    expect(leftInput.state.getSnapshot().draft.startsWith('draft')).toBe(true)
    expect(document.activeElement).toBe(composer)
    controller.dispose()
  })
})
