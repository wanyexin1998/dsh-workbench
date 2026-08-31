// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createQuoteHighlightRegistry, cssHighlightPainter, lastLineRect, placeQuoteBadge,
  quoteBadgeWidth, quoteBandIsMeasured, quoteExcerpt, quoteMutationsMatter,
  resolveQuoteAnchor, supportsHighlightApi,
  QUOTE_BADGE_HEIGHT,
  type QuoteHighlightPainter,
} from './quote-highlight.js'
import { QUOTE_HIGHLIGHT_ACTIVE_NAME, QUOTE_HIGHLIGHT_NAME } from './conversation-dom.js'
import type { SelectionAggregateItem } from './selection-reference.js'

function selectionRow(sessionId: string | null, key: string, kind = 'user') {
  const pane = sessionId === null ? null : document.createElement('section')
  if (pane !== null && sessionId !== null) pane.dataset.sessionPane = sessionId
  const flow = document.createElement('div')
  flow.dataset.chatFlow = ''
  const row = document.createElement('article')
  row.dataset.chatAnchorKey = `anchor-${key}`
  row.dataset.chatFlowKey = key
  row.dataset.chatFlowKind = kind
  flow.appendChild(row)
  ;(pane ?? document.body).appendChild(flow)
  if (pane !== null) document.body.appendChild(pane)
  return { pane, flow, row }
}

function item(overrides: Partial<SelectionAggregateItem> = {}): SelectionAggregateItem {
  return {
    id: 'q1', parentSessionId: 'left', nodeKey: 'node-1', nodeKind: 'user', atSeq: 1,
    text: 'alpha', startOffset: 0, endOffset: 5, ...overrides,
  }
}

function fakePainter(): QuoteHighlightPainter & { calls: Array<[string, number, number]>; deletes: string[] } {
  const calls: Array<[string, number, number]> = []
  const deletes: string[] = []
  return {
    calls,
    deletes,
    set: (name, ranges, priority) => { calls.push([name, ranges.length, priority]) },
    delete: (name) => { deletes.push(name) },
  }
}

function rangeIn(row: HTMLElement): Range {
  const range = document.createRange()
  range.setStart(row.firstChild!, 0)
  range.setEnd(row.firstChild!, 1)
  return range
}

describe('resolveQuoteAnchor', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('rebuilds the range from identity and lets the existing judge re-verify it', () => {
    const { row } = selectionRow('left', 'node-1')
    row.append(document.createTextNode('alpha beta'))
    const anchor = resolveQuoteAnchor(item(), document)
    expect(anchor?.row).toBe(row)
    expect(anchor?.range.toString()).toBe('alpha')
  })

  it('refuses to re-attach to a different passage after the source text was edited', () => {
    // 偏移还在、文本已变 —— 宁可不画，绝不吸附到别的片段。
    const { row } = selectionRow('left', 'node-1')
    row.append(document.createTextNode('BRAVO beta'))
    expect(resolveQuoteAnchor(item(), document)).toBeNull()
  })

  it('inherits the capture-side rules it never re-implements (streaming rows)', () => {
    const { row } = selectionRow('left', 'node-1', 'assistant-step')
    row.dataset.streaming = 'true'
    row.append(document.createTextNode('alpha beta'))
    expect(resolveQuoteAnchor(item({ nodeKind: 'assistant-step' }), document)).toBeNull()
  })

  it('rejects a row that lives in another pane (ADR-0009)', () => {
    const { row } = selectionRow('right', 'node-1')
    row.append(document.createTextNode('alpha beta'))
    expect(resolveQuoteAnchor(item(), document)).toBeNull()
  })

  it('rejects a nodeKind mismatch even when the key and text still line up', () => {
    const { row } = selectionRow('left', 'node-1', 'steering')
    row.append(document.createTextNode('alpha beta'))
    expect(resolveQuoteAnchor(item({ nodeKind: 'user' }), document)).toBeNull()
  })

  it('returns null when the row is not rendered at all', () => {
    expect(resolveQuoteAnchor(item(), document)).toBeNull()
  })
})

describe('CSS Custom Highlight painter seam', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).CSS
    delete (globalThis as Record<string, unknown>).Highlight
  })

  it('degrades to null in an environment without the API (jsdom has no window.CSS)', () => {
    // 裸写 CSS.highlights 在 jsdom 里会抛 —— 探测必须先看 CSS 本身在不在。
    expect(supportsHighlightApi()).toBe(false)
    expect(cssHighlightPainter()).toBeNull()
  })

  it('drives CSS.highlights with one Highlight per registry entry, priority included', () => {
    const set = vi.fn()
    const remove = vi.fn()
    class FakeHighlight {
      priority = 0
      ranges: Range[]
      constructor(...ranges: Range[]) { this.ranges = ranges }
    }
    ;(globalThis as Record<string, unknown>).CSS = { highlights: { set, delete: remove } }
    ;(globalThis as Record<string, unknown>).Highlight = FakeHighlight
    expect(supportsHighlightApi()).toBe(true)
    const painter = cssHighlightPainter()!
    const row = document.createElement('div')
    row.append(document.createTextNode('abc'))
    painter.set('n', [rangeIn(row), rangeIn(row)], 1)
    expect(set).toHaveBeenCalledTimes(1)
    const highlight = set.mock.calls[0]![1] as FakeHighlight
    expect(highlight.ranges.length).toBe(2)
    expect(highlight.priority).toBe(1)
    painter.delete('n')
    expect(remove).toHaveBeenCalledWith('n')
    document.body.innerHTML = ''
  })
})

describe('createQuoteHighlightRegistry', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function ranges(count: number): Range[] {
    const row = document.createElement('div')
    row.append(document.createTextNode('abcdefgh'))
    document.body.appendChild(row)
    return Array.from({ length: count }, (_, index) => {
      const range = document.createRange()
      range.setStart(row.firstChild!, index)
      range.setEnd(row.firstChild!, index + 1)
      return range
    })
  }

  it('merges every owner into a single set() per entry name', () => {
    // CSS.highlights 是 document 级注册表，而 ::highlight(name) 没有通配选择器：
    // 两个 Pane 各自 set() 会互相覆盖且补不回来。必须单一所有者合并发布。
    const painter = fakePainter()
    const registry = createQuoteHighlightRegistry(painter)
    const [a, b, c] = ranges(3)
    registry.publish('left', { ranges: [a!, b!], active: [] })
    registry.publish('right', { ranges: [c!], active: [c!] })
    expect(registry.size).toBe(2)
    const base = painter.calls.filter(([name]) => name === QUOTE_HIGHLIGHT_NAME)
    expect(base[base.length - 1]).toEqual([QUOTE_HIGHLIGHT_NAME, 3, 0])
    const active = painter.calls.filter(([name]) => name === QUOTE_HIGHLIGHT_ACTIVE_NAME)
    expect(active[active.length - 1]).toEqual([QUOTE_HIGHLIGHT_ACTIVE_NAME, 1, 1])
  })

  it('deletes the entries instead of setting an empty highlight', () => {
    const painter = fakePainter()
    const registry = createQuoteHighlightRegistry(painter)
    const [a] = ranges(1)
    registry.publish('left', { ranges: [a!], active: [] })
    expect(painter.deletes).toContain(QUOTE_HIGHLIGHT_ACTIVE_NAME)
    registry.withdraw('left')
    expect(registry.size).toBe(0)
    expect(painter.deletes.filter((name) => name === QUOTE_HIGHLIGHT_NAME).length).toBe(1)
  })

  it('is inert without a painter (unsupported host) and never throws', () => {
    const registry = createQuoteHighlightRegistry(null)
    const [a] = ranges(1)
    expect(() => registry.publish('left', { ranges: [a!], active: [a!] })).not.toThrow()
    expect(() => registry.withdraw('left')).not.toThrow()
  })

  it('ignores a withdraw for an owner that never published', () => {
    const painter = fakePainter()
    const registry = createQuoteHighlightRegistry(painter)
    registry.withdraw('ghost')
    expect(painter.calls.length).toBe(0)
    expect(painter.deletes.length).toBe(0)
  })
})

describe('placeQuoteBadge', () => {
  const band = { top: 100, bottom: 600, right: 800 }
  const badge = { width: 16, height: QUOTE_BADGE_HEIGHT }

  it('parks the badge OUTSIDE the text column, never over the row it annotates', () => {
    // 宿主 .flowItem 没有右内边距 —— 行右缘就是正文列边界，钉在 rowRect.right
    // 之内一定压字。列外的留白（.scroll 的左右 padding，恒 ≥32px）才是安全的。
    const point = placeQuoteBadge({ top: 300, bottom: 320, right: 698 }, { right: 700 }, band, badge)
    expect(point).toEqual({ top: 302, left: 704 })
    expect(point!.left).toBeGreaterThanOrEqual(700)
  })

  it('does not cover the last characters of a full line when the quote ends mid-paragraph', () => {
    // 这是旧版最刺眼的那一格：末行排满到列边界（中文行末一定是真实字形，
    // 没有可借的空格），旧规则给出 700-4-16=680，正好压住最后一两个字。
    const point = placeQuoteBadge({ top: 300, bottom: 320, right: 700 }, { right: 700 }, band, badge)
    expect(point!.left).not.toBe(700 - 4 - 16)
    expect(point!.left).toBeGreaterThanOrEqual(700)
  })

  it('falls back to the quote’s own end when the column reaches the band edge', () => {
    // 外侧没有留白的宿主：遮挡不可避免，那就退到脚注本来的位置——引用末尾。
    const point = placeQuoteBadge({ top: 300, bottom: 320, right: 600 }, { right: 900 }, band, badge)
    expect(point).toEqual({ top: 302, left: 604 })
  })

  it('clamps the fallback inside the band (scrollbar gutter already deducted)', () => {
    const point = placeQuoteBadge({ top: 300, bottom: 320, right: 900 }, { right: 900 }, band, badge)
    expect(point?.left).toBe(800 - 4 - 16)
  })

  it('returns null for a line entirely outside the band instead of clamping it', () => {
    // 钳住的徽标是在撒谎 —— 它指着一个不在那儿的位置。
    expect(placeQuoteBadge({ top: 20, bottom: 40, right: 400 }, { right: 700 }, band, badge)).toBeNull()
    expect(placeQuoteBadge({ top: 700, bottom: 720, right: 400 }, { right: 700 }, band, badge)).toBeNull()
    expect(placeQuoteBadge({ top: 100, bottom: 100, right: 400 }, { right: 700 }, band, badge)).toBeNull()
  })

  it('clamps inside the band while the line is still partly visible', () => {
    const top = placeQuoteBadge({ top: 90, bottom: 110, right: 400 }, { right: 700 }, band, badge)
    expect(top?.top).toBe(100)
    const bottom = placeQuoteBadge({ top: 590, bottom: 610, right: 400 }, { right: 700 }, band, badge)
    expect(bottom?.top).toBe(600 - QUOTE_BADGE_HEIGHT)
  })

  it('returns null when the band has no measured height (geometry unknown)', () => {
    const nothing = { top: 0, bottom: 0, right: 0 }
    expect(placeQuoteBadge({ top: 0, bottom: 16, right: 0 }, { right: 0 }, nothing, badge)).toBeNull()
    expect(quoteBandIsMeasured(nothing)).toBe(false)
    expect(quoteBandIsMeasured(null)).toBe(false)
    expect(quoteBandIsMeasured(band)).toBe(true)
  })

  it('shifts sideways instead of stacking two badges byte-for-byte on top of each other', () => {
    // 两条引用的末行落在同一视觉行时，旧版给出完全相同的落点：一个徽标把另一个
    // 整个盖掉，看起来就是"少了一个编号"。
    const first = placeQuoteBadge({ top: 300, bottom: 320, right: 400 }, { right: 700 }, band, badge)!
    const taken = [{ ...first, width: badge.width, height: badge.height }]
    const second = placeQuoteBadge({ top: 300, bottom: 320, right: 690 }, { right: 700 }, band, badge, taken)!
    expect(second).not.toEqual(first)
    expect(second).toEqual({ top: 302, left: 704 + 16 + 4 })
  })

  it('stacks upward once the visual line has no horizontal room left', () => {
    const taken = [{ top: 302, left: 764, width: 16, height: 16 }]
    const point = placeQuoteBadge({ top: 300, bottom: 320, right: 700 }, { right: 760 }, band, badge, taken)
    expect(point).toEqual({ top: 302 - 18, left: 764 })
  })

  it('leaves a lone badge exactly where the rule put it (no gratuitous shifting)', () => {
    const taken = [{ top: 500, left: 704, width: 16, height: 16 }]
    const point = placeQuoteBadge({ top: 300, bottom: 320, right: 400 }, { right: 700 }, band, badge, taken)
    expect(point).toEqual({ top: 302, left: 704 })
  })
})

describe('lastLineRect', () => {
  afterEach(() => {
    delete (Range.prototype as unknown as { getClientRects?: unknown }).getClientRects
    document.body.innerHTML = ''
  })

  it('returns null where Range.getClientRects does not exist (jsdom)', () => {
    const row = document.createElement('div')
    row.append(document.createTextNode('abc'))
    document.body.appendChild(row)
    expect(lastLineRect(rangeIn(row))).toBeNull()
  })

  it('takes the LAST rect — footnote semantics: the number goes after the quote', () => {
    ;(Range.prototype as unknown as { getClientRects?: unknown }).getClientRects = () => [
      { top: 10, bottom: 26, right: 700 }, { top: 30, bottom: 46, right: 312 },
    ] as unknown as DOMRectList
    const row = document.createElement('div')
    row.append(document.createTextNode('abc'))
    document.body.appendChild(row)
    // right 是引用文字**真正的**末端（第 2 档落点要它），不是行容器的右缘。
    expect(lastLineRect(rangeIn(row))).toEqual({ top: 30, bottom: 46, right: 312 })
  })
})

describe('quoteMutationsMatter', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function record(overrides: Partial<MutationRecord>): MutationRecord {
    return {
      type: 'childList', target: document.body,
      addedNodes: [] as unknown as NodeList, removedNodes: [] as unknown as NodeList,
      ...overrides,
    } as MutationRecord
  }

  it('drops the streaming flood: characterData inside a row nobody quotes', () => {
    // 引用只能指向 settled 行，正在流式的那一行永远不是已锚定行 —— 每帧几千条
    // 记录在这里一条都进不去。
    const { row: quoted } = selectionRow('left', 'node-1')
    const { row: streaming } = selectionRow('left', 'node-2', 'assistant-step')
    const token = document.createTextNode('思')
    streaming.append(token)
    const records = Array.from({ length: 32 }, () => record({ type: 'characterData', target: token }))
    expect(quoteMutationsMatter(records, [quoted])).toBe(false)
  })

  it('lets through a text change inside the quoted row itself', () => {
    const { row } = selectionRow('left', 'node-1')
    const text = document.createTextNode('alpha')
    row.append(text)
    expect(quoteMutationsMatter([record({ type: 'characterData', target: text })], [row])).toBe(true)
  })

  it('lets through business rows appearing or disappearing, even with nothing anchored yet', () => {
    // detached 的条目全靠这条等到"行回来了"（虚拟化换入、历史重载、Pane 切换）。
    const { row } = selectionRow('left', 'node-1')
    expect(quoteMutationsMatter([record({ addedNodes: [row] as unknown as NodeList })], [])).toBe(true)
    expect(quoteMutationsMatter([record({ removedNodes: [row] as unknown as NodeList })], [])).toBe(true)
    const wrapper = document.createElement('div')
    wrapper.appendChild(row)
    expect(quoteMutationsMatter([record({ addedNodes: [wrapper] as unknown as NodeList })], [])).toBe(true)
  })

  it('drops nodes appended inside a streaming row (markdown re-render is not a row change)', () => {
    const { row: quoted } = selectionRow('left', 'node-1')
    const { row: streaming } = selectionRow('left', 'node-2', 'assistant-step')
    const paragraph = document.createElement('p')
    expect(quoteMutationsMatter(
      [record({ target: streaming, addedNodes: [paragraph] as unknown as NodeList })],
      [quoted],
    )).toBe(false)
  })

  it('says no for an empty batch', () => {
    expect(quoteMutationsMatter([], [])).toBe(false)
  })
})

describe('quoteBadgeWidth / quoteExcerpt', () => {
  it('keeps a one-digit badge circular and widens for two digits', () => {
    expect(quoteBadgeWidth('1')).toBe(16)
    expect(quoteBadgeWidth('12')).toBe(22)
  })

  it('flattens newlines and truncates the accessible-name excerpt', () => {
    expect(quoteExcerpt('alpha\nbeta')).toBe('alpha beta')
    expect(quoteExcerpt('x'.repeat(60))).toBe(`${'x'.repeat(40)}…`)
    expect(quoteExcerpt('  padded  ')).toBe('padded')
  })
})
