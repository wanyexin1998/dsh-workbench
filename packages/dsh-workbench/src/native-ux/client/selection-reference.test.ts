import { describe, expect, it, vi } from 'vitest'
import type { ReferenceInsert, TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ConversationSelection } from './selection-contract.js'
import {
  appendSelectionReference, createSelectionReferenceSource, createSideChatReferenceSource,
  decodeSelectionAggregate, decodeSideChatReference, insertSideChatReference,
  readSelectionAggregate, removeSelectionItem, selectionReferenceCodec, sideChatReferenceCodec,
  updateSelectionComment, type SelectionInput, type SelectionInputSnapshot,
  type SelectionOccurrence,
} from './selection-reference.js'
import { structuredSelectionReference, type SideChatCopy } from './side-chat-actions.js'

function fakeInput(initialDraft = '') {
  let state: SelectionInputSnapshot = { draft: initialDraft, draftRev: 0, occurrences: [] }
  let rejectNext = false
  const notify = vi.fn()
  const input: SelectionInput & { rejectOnce(): void } = {
    state: { getSnapshot: () => state },
    insertReference(reference: ReferenceInsert, span: TokenSpan) {
      if (rejectNext) {
        rejectNext = false
        return false
      }
      if (span.draftRev !== state.draftRev || span.start < 0 || span.end < span.start || span.end > state.draft.length) return false
      const tail = state.draft.slice(span.end)
      const gap = tail.length === 0 || tail[0] !== ' ' ? ' ' : ''
      const display = '@' + reference.label
      const inserted = display + gap
      const delta = inserted.length - (span.end - span.start)
      const retained = state.occurrences
        .filter((occurrence) => occurrence.offset + occurrence.length <= span.start || occurrence.offset >= span.end)
        .map((occurrence) => occurrence.offset >= span.end ? { ...occurrence, offset: occurrence.offset + delta } : occurrence)
      const nextOccurrence: SelectionOccurrence = {
        source: reference.source,
        ref: reference.ref,
        offset: span.start,
        length: display.length,
      }
      state = {
        draft: state.draft.slice(0, span.start) + inserted + tail,
        draftRev: state.draftRev + 1,
        occurrences: [...retained, nextOccurrence].sort((a, b) => a.offset - b.offset),
      }
      return true
    },
    consumeSpan(span: TokenSpan) {
      if (span.draftRev !== state.draftRev || span.start >= span.end || span.end > state.draft.length) return false
      const nextDraft = state.draft.slice(0, span.start) + state.draft.slice(span.end)
      let prefix = 0
      const maxCommon = Math.min(state.draft.length, nextDraft.length)
      while (prefix < maxCommon && state.draft[prefix] === nextDraft[prefix]) prefix += 1
      let suffix = 0
      const maxSuffix = maxCommon - prefix
      while (suffix < maxSuffix && state.draft[state.draft.length - 1 - suffix] === nextDraft[nextDraft.length - 1 - suffix]) suffix += 1
      const recoveredEnd = state.draft.length - suffix
      const insertedLength = nextDraft.length - suffix - prefix
      const delta = insertedLength - (recoveredEnd - prefix)
      const occurrences = state.occurrences.flatMap((occurrence) => {
        if (occurrence.offset + occurrence.length <= prefix) return [occurrence]
        if (occurrence.offset >= recoveredEnd) return [{ ...occurrence, offset: occurrence.offset + delta }]
        return []
      })
      state = {
        draft: nextDraft,
        draftRev: state.draftRev + 1,
        occurrences,
      }
      return true
    },
    notify,
    rejectOnce() {
      rejectNext = true
    },
  }
  return { input, notify }
}

function selection(text: string, offset = 0): ConversationSelection {
  return {
    parentSessionId: 's<&"',
    nodeKey: `node-${offset}`,
    nodeKind: 'user',
    atSeq: 10 + offset,
    text,
    startOffset: offset,
    endOffset: offset + text.length,
    rect: { x: 0, y: 0, width: 1, height: 1 },
  }
}

describe('selection aggregate reference', () => {
  it('preserves the ordinary draft and keeps exactly one ordered aggregate occurrence', () => {
    const { input } = fakeInput('existing draft')
    expect(appendSelectionReference(input, selection('first'), 'one', 'Selected context').ok).toBe(true)
    expect(appendSelectionReference(input, selection('second', 7), 'two', 'Selected context').ok).toBe(true)

    const snapshot = input.state.getSnapshot()
    expect(snapshot.draft.startsWith('existing draft')).toBe(true)
    expect(snapshot.occurrences).toHaveLength(1)
    const owned = readSelectionAggregate(snapshot)
    expect(owned?.aggregate.items.map((item) => item.text)).toEqual(['first', 'second'])
  })

  it('updates comments and removes one item without disturbing the other or the ordinary draft', () => {
    const { input } = fakeInput('draft')
    appendSelectionReference(input, selection('first'), 'one', 'Selected context')
    appendSelectionReference(input, selection('second', 8), 'two', 'Selected context')
    expect(updateSelectionComment(input, 'one', 'why this matters', 'Selected context').ok).toBe(true)
    expect(readSelectionAggregate(input.state.getSnapshot())?.aggregate.items[0]?.comment).toBe('why this matters')

    expect(removeSelectionItem(input, 'one', 'Selected context').ok).toBe(true)
    expect(readSelectionAggregate(input.state.getSnapshot())?.aggregate.items.map((item) => item.id)).toEqual(['two'])
    expect(input.state.getSnapshot().draft.startsWith('draft')).toBe(true)

    expect(removeSelectionItem(input, 'two', 'Selected context').ok).toBe(true)
    expect(input.state.getSnapshot()).toMatchObject({ draft: 'draft', occurrences: [] })
  })

  it('removes the last Workbench item without dropping or misplacing other-source occurrences', () => {
    const { input } = fakeInput('draft')
    expect(input.insertReference({
      source: 'other.before', ref: 'before', label: 'Selected context', clipboardText: 'before',
    }, { start: 5, end: 5, draftRev: 0 })).toBe(true)
    expect(appendSelectionReference(input, selection('selected'), 'one', '[selection]').ok).toBe(true)
    const beforeAfterInsert = input.state.getSnapshot()
    expect(input.insertReference({
      source: 'other.after', ref: 'after', label: 'Selected context', clipboardText: 'after',
    }, {
      start: beforeAfterInsert.draft.length,
      end: beforeAfterInsert.draft.length,
      draftRev: beforeAfterInsert.draftRev,
    })).toBe(true)

    expect(removeSelectionItem(input, 'one', '[selection]').ok).toBe(true)
    const snapshot = input.state.getSnapshot()
    expect(snapshot.draft).toBe('draft@Selected context @Selected context ')
    expect(snapshot.occurrences.map((occurrence) => ({ source: occurrence.source, offset: occurrence.offset }))).toEqual([
      { source: 'other.before', offset: 5 },
      { source: 'other.after', offset: 23 },
    ])
  })

  it('rejects a reload-time duplicate id before corrupting the old aggregate, while a fresh id appends cleanly', () => {
    const { input } = fakeInput('draft')
    expect(appendSelectionReference(input, selection('old'), 'selection-1', 'Selected context').ok).toBe(true)
    const before = input.state.getSnapshot()
    expect(appendSelectionReference(input, selection('duplicate'), 'selection-1', 'Selected context')).toEqual({
      ok: false,
      reason: 'invalid-reference',
    })
    expect(input.state.getSnapshot()).toBe(before)
    expect(appendSelectionReference(input, selection('after reload'), 'selection-new-uuid', 'Selected context').ok).toBe(true)
    expect(readSelectionAggregate(input.state.getSnapshot())?.aggregate.items.map((item) => item.id)).toEqual([
      'selection-1',
      'selection-new-uuid',
    ])
  })

  it('uses draftRev CAS and leaves the aggregate untouched when insertion is stale', () => {
    const { input } = fakeInput('draft')
    appendSelectionReference(input, selection('first'), 'one', 'Selected context')
    const before = input.state.getSnapshot()
    input.rejectOnce()
    expect(appendSelectionReference(input, selection('second'), 'two', 'Selected context')).toEqual({ ok: false, reason: 'stale-draft' })
    expect(input.state.getSnapshot()).toBe(before)
  })
})

describe('selection reference codec/source', () => {
  it('XML-escapes selected text, comments, and source attributes in ordered selected_context', async () => {
    const { input } = fakeInput()
    appendSelectionReference(input, selection('<one>&'), 'one', 'Selected context', 'say "why" & more')
    appendSelectionReference(input, selection('two'), 'two', 'Selected context')
    const ref = input.state.getSnapshot().occurrences[0]!.ref
    const serialized = await selectionReferenceCodec.serialize(ref, new AbortController().signal)
    expect(serialized).toContain('<selected_context version="aggregate-v1">')
    expect(serialized).toContain('parent_session_id="s&lt;&amp;&quot;"')
    expect(serialized).toContain('<text>&lt;one&gt;&amp;</text>')
    expect(serialized).toContain('<comment>say &quot;why&quot; &amp; more</comment>')
    expect(serialized.indexOf('&lt;one&gt;')).toBeLessThan(serialized.indexOf('<text>two</text>'))
  })

  it('throws on malformed refs or aborted serialization instead of falling back to plain text', async () => {
    expect(() => decodeSelectionAggregate('not json')).toThrow(/Invalid Workbench selection reference/)
    expect(() => decodeSelectionAggregate(JSON.stringify({
      version: 'aggregate-v1',
      items: [{ id: 'x', parentSessionId: 's', nodeKey: 'n', nodeKind: 'user', atSeq: 1.5, text: 'x', startOffset: 0, endOffset: 1 }],
    }))).toThrow(/Invalid Workbench selection reference/)
    await expect(selectionReferenceCodec.serialize('not json', new AbortController().signal)).rejects.toThrow()
    const controller = new AbortController()
    controller.abort()
    await expect(selectionReferenceCodec.serialize(JSON.stringify({ version: 'aggregate-v1', items: [{}] }), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('registers a no-candidate codec owner that cannot pollute the @ menu', async () => {
    const source = createSelectionReferenceSource()
    expect(source.codec).toBe(selectionReferenceCodec)
    expect(await source.candidates({ sessionId: 's' as never }, {
      query: '', position: 'inline', signal: new AbortController().signal,
    })).toEqual([])
    expect(source.onPick({
      candidate: { name: 'never' }, session: { sessionId: 's' as never },
      position: 'inline', via: 'menu', span: { start: 0, end: 0, draftRev: 0 },
    })).toBeUndefined()
  })
})

describe('side-chat selection reference', () => {
  const copy: SideChatCopy = {
    referenceBoundary: 'History <reference> & only; the current task begins after this boundary.',
    moreDetailsRequest: 'Explain it.',
  }

  it('inserts one versioned reference at an empty ordinary draft using draftRev CAS', () => {
    const { input } = fakeInput()
    const reference = structuredSelectionReference(selection('<picked>&'), copy)
    expect(insertSideChatReference(input, reference, 'Side selection')).toEqual({ ok: true })
    const snapshot = input.state.getSnapshot()
    expect(snapshot.occurrences).toHaveLength(1)
    const occurrence = snapshot.occurrences[0]!
    const decoded = decodeSideChatReference(occurrence.ref)
    expect(occurrence.source).toBe('dsh-workbench.side-chat-selection')
    expect(decoded).toMatchObject({
      version: 'side-chat-v1',
      kind: 'side-chat-selection',
      referenceBoundary: copy.referenceBoundary,
      parentSessionId: 's<&"',
      text: '<picked>&',
    })
  })

  it('serializes localized boundary before XML-escaped selected_context with frozen identity', async () => {
    const reference = structuredSelectionReference(selection('<picked>&'), copy)
    const serialized = await sideChatReferenceCodec.serialize(JSON.stringify(reference), new AbortController().signal)
    expect(serialized.indexOf('<side_chat_boundary>')).toBeLessThan(serialized.indexOf('<selected_context'))
    expect(serialized).toContain('History &lt;reference&gt; &amp; only')
    expect(serialized).toContain('version="side-chat-v1"')
    expect(serialized).toContain('parent_session_id="s&lt;&amp;&quot;"')
    expect(serialized).toContain('<selected_context')
    expect(serialized).toContain('&lt;picked&gt;&amp;')
  })

  it('rejects non-empty ordinary draft and stale CAS without a fallback mutation', () => {
    const nonEmpty = fakeInput('ordinary question')
    const nonEmptyInsert = vi.spyOn(nonEmpty.input, 'insertReference')
    expect(insertSideChatReference(
      nonEmpty.input,
      structuredSelectionReference(selection('picked'), copy),
      'Side selection',
    )).toEqual({ ok: false, reason: 'ordinary-draft-not-empty' })
    expect(nonEmptyInsert).not.toHaveBeenCalled()

    const stale = fakeInput()
    stale.input.rejectOnce()
    expect(insertSideChatReference(
      stale.input,
      structuredSelectionReference(selection('picked'), copy),
      'Side selection',
    )).toEqual({ ok: false, reason: 'stale-draft' })
    expect(stale.input.state.getSnapshot()).toMatchObject({ draft: '', occurrences: [] })
  })

  it('registers a no-candidate codec owner and rejects malformed or aborted refs', async () => {
    const source = createSideChatReferenceSource()
    expect(source.codec).toBe(sideChatReferenceCodec)
    expect(await source.candidates({ sessionId: 's' as never }, {
      query: '', position: 'inline', signal: new AbortController().signal,
    })).toEqual([])
    expect(source.onPick({
      candidate: { name: 'never' }, session: { sessionId: 's' as never },
      position: 'inline', via: 'menu', span: { start: 0, end: 0, draftRev: 0 },
    })).toBeUndefined()
    expect(() => decodeSideChatReference('not json')).toThrow(/Invalid Workbench side-chat reference/)
    const controller = new AbortController()
    controller.abort()
    await expect(sideChatReferenceCodec.serialize('not json', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
