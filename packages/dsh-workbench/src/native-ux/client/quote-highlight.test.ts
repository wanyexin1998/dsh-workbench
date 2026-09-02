// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createQuoteHighlightRegistry, cssHighlightPainter, lastLineRect, pinQuoteCard, placeQuoteBadge,
  placeQuoteCard, quoteBadgeWidth, quoteBandIsMeasured, quoteExcerpt, quoteMutationsMatter,
  resolveQuoteAnchor, supportsHighlightApi,
  QUOTE_BADGE_HEIGHT,
  type QuoteHighlightPainter,
} from './quote-highlight.js'
import {
  QUOTE_HIGHLIGHT_ACTIVE_NAME, QUOTE_HIGHLIGHT_NAME, QUOTE_HIGHLIGHT_TINT_NAME,
} from './conversation-dom.js'
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
    registry.publish('left', { ranges: [a!, b!], active: [], tinted: [] })
    registry.publish('right', { ranges: [c!], active: [c!], tinted: [c!] })
    expect(registry.size).toBe(2)
    const base = painter.calls.filter(([name]) => name === QUOTE_HIGHLIGHT_NAME)
    expect(base[base.length - 1]).toEqual([QUOTE_HIGHLIGHT_NAME, 3, 0])
    const active = painter.calls.filter(([name]) => name === QUOTE_HIGHLIGHT_ACTIVE_NAME)
    expect(active[active.length - 1]).toEqual([QUOTE_HIGHLIGHT_ACTIVE_NAME, 1, 1])
  })

  it('gives the tint its own entry name so the underline entries never carry a background', () => {
    // 底色只能发给不落在自绘背景里的子 Range。它与下划线设的是不相交的属性，
    // 所以是第三个**条目名**，不是把 background 加进前两条。
    const painter = fakePainter()
    const registry = createQuoteHighlightRegistry(painter)
    const [a, b] = ranges(2)
    registry.publish('left', { ranges: [a!, b!], active: [], tinted: [a!] })
    const tint = painter.calls.filter(([name]) => name === QUOTE_HIGHLIGHT_TINT_NAME)
    expect(tint[tint.length - 1]).toEqual([QUOTE_HIGHLIGHT_TINT_NAME, 1, 0])
    // 整条引用都坐在自绘背景上时（代码块里的引用），底色那一条整个撤掉，
    // 下划线照旧。
    registry.publish('left', { ranges: [a!, b!], active: [], tinted: [] })
    expect(painter.deletes).toContain(QUOTE_HIGHLIGHT_TINT_NAME)
    const base = painter.calls.filter(([name]) => name === QUOTE_HIGHLIGHT_NAME)
    expect(base[base.length - 1]).toEqual([QUOTE_HIGHLIGHT_NAME, 2, 0])
  })

  it('deletes the entries instead of setting an empty highlight', () => {
    const painter = fakePainter()
    const registry = createQuoteHighlightRegistry(painter)
    const [a] = ranges(1)
    registry.publish('left', { ranges: [a!], active: [], tinted: [] })
    expect(painter.deletes).toContain(QUOTE_HIGHLIGHT_ACTIVE_NAME)
    registry.withdraw('left')
    expect(registry.size).toBe(0)
    expect(painter.deletes.filter((name) => name === QUOTE_HIGHLIGHT_NAME).length).toBe(1)
  })

  it('is inert without a painter (unsupported host) and never throws', () => {
    const registry = createQuoteHighlightRegistry(null)
    const [a] = ranges(1)
    expect(() => registry.publish('left', { ranges: [a!], active: [a!], tinted: [] })).not.toThrow()
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
  const band = { top: 100, bottom: 600, left: 0, right: 800 }
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
    const nothing = { top: 0, bottom: 0, left: 0, right: 0 }
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

/**
 * 标签 / 卡片落点。与 `placeSelectionToolbar` 的测试同一形状（表驱动 + 不变量），
 * 但规则相反：那个首选**上方**并水平居中，这个首选**下方**并左对齐正文列。
 */
describe('placeQuoteCard', () => {
  const band = { top: 100, bottom: 600, left: 40, right: 800 }
  const card = { width: 320, height: 140 }

  it('opens downward from the quoted line, left-aligned to the text column', () => {
    // 截图里的卡片就是从被引用段落**向下**展开的。
    const place = placeQuoteCard({ top: 300, bottom: 320 }, { left: 120 }, card, band)
    expect(place).toEqual({ top: 326, left: 120, above: false })
  })

  it('flips above the line when the card cannot fit below it', () => {
    const place = placeQuoteCard({ top: 500, bottom: 520 }, { left: 120 }, card, band)
    expect(place.above).toBe(true)
    expect(place.top).toBe(354)
    expect(place.top + card.height).toBeLessThanOrEqual(500)
  })

  it('never lets the card box overlap the quoted line while the band has room', () => {
    // 「浮层不遮挡被引用的原文」这条不变量的唯一出处。
    const roomy = { top: 0, bottom: 1000, left: 0, right: 1000 }
    const lines = [
      { top: 0, bottom: 20 }, { top: 120, bottom: 160 }, { top: 480, bottom: 500 },
      { top: 700, bottom: 760 }, { top: 900, bottom: 920 }, { top: 960, bottom: 980 },
    ]
    const sizes = [{ width: 240, height: 80 }, { width: 320, height: 140 }, { width: 360, height: 200 }]
    for (const line of lines) {
      for (const size of sizes) {
        const place = placeQuoteCard(line, { left: 100 }, size, roomy)
        const clear = place.top + size.height <= line.top || place.top >= line.bottom
        expect({ line, size, top: place.top, clear }).toMatchObject({ clear: true })
      }
    }
  })

  it('keeps the card inside the band even when neither side has room (visibility wins)', () => {
    // 两条不变量在带子矮到装不下卡片时会冲突。这里与 placeSelectionToolbar 取
    // 同一优先级：宁可压住原文，也不能让正在打字的输入框整块滚出可见带。
    const shallow = { top: 100, bottom: 300, left: 40, right: 800 }
    const place = placeQuoteCard({ top: 150, bottom: 250 }, { left: 120 }, { width: 320, height: 250 }, shallow)
    expect(place.top).toBe(shallow.top)
    expect(place.top).toBeGreaterThanOrEqual(shallow.top)
  })

  it('clamps horizontally into the band instead of hanging off either edge', () => {
    // QuoteBand 原本只有 top/bottom/right —— 徽标永远靠右，用不上左缘；有宽度的
    // 盒子两侧都要钳，所以带子补了 left。
    expect(placeQuoteCard({ top: 300, bottom: 320 }, { left: 700 }, card, band).left).toBe(480)
    expect(placeQuoteCard({ top: 300, bottom: 320 }, { left: 10 }, card, band).left).toBe(40)
  })

  it('does not clamp against a band it could not measure', () => {
    // 高/宽为 0 的带子说的是"还没布局"，不是"没有空间"。门槛与
    // placeSelectionToolbar 的 `viewport > 0` 同形。
    const unmeasured = { top: 0, bottom: 0, left: 0, right: 0 }
    const place = placeQuoteCard({ top: 300, bottom: 320 }, { left: 120 }, card, unmeasured)
    expect(place).toEqual({ top: 326, left: 120, above: false })
  })
})

/**
 * 朝向定下来之后钉住那条边。评论框改成随行数长高之后，`placeQuoteCard` 那种
 * "top 是高度的函数"的算法会让用户一边打字、卡片一边爬，所以增高的余量必须由
 * `maxHeight` 吃掉，而不是由重定位吸收。
 */
describe('pinQuoteCard', () => {
  const band = { top: 100, bottom: 600, left: 40, right: 800 }
  const line = { top: 300, bottom: 320 }

  it('keeps the top fixed while the card grows downward', () => {
    // 杀法：把 below 分支的 top 换回 `Math.min(rawTop, band.bottom - height)`
    // —— 高度一过 274（600-326）这条断言就散架。
    const tops = [80, 200, 400, 900].map((height) => pinQuoteCard(line, height, band, false, 96).top)
    expect(tops).toEqual([326, 326, 326, 326])
  })

  it('keeps the bottom fixed while the card grows upward', () => {
    // 放在原文上方时被钉住的是**下缘**：卡片向上长（与 composer 同向）。
    // 高度取到该方向的余量（188）为止 —— 再高就超出带子，那由 maxHeight 拦住
    // （下一条测试）。
    for (const height of [80, 150, 188]) {
      expect(pinQuoteCard(line, height, band, true, 96).top + height).toBe(294)
    }
  })

  it('hands back exactly the room left in that direction, so the card cannot outgrow the band', () => {
    // 下方：600 - 6 - 326 = 268；上方：300 - 6 - 6 - 100 = 188。
    expect(pinQuoteCard(line, 96, band, false, 96).maxHeight).toBe(268)
    expect(pinQuoteCard(line, 96, band, true, 96).maxHeight).toBe(188)
  })

  it('never squeezes the card below its opening height (visibility wins, same as placeQuoteCard)', () => {
    // 带子矮到放不下一张开卡高度的卡片时，宁可让它探出带子 —— 与
    // placeQuoteCard 的"可见优先"同一条优先级。
    const shallow = { top: 100, bottom: 340, left: 40, right: 800 }
    expect(pinQuoteCard(line, 96, shallow, false, 96).maxHeight).toBe(96)
    // 带子量不出来（高 ≤ 0）时同样只给下限，门槛与 placeQuoteCard 的 measured 一致。
    const unmeasured = { top: 0, bottom: 0, left: 0, right: 0 }
    expect(pinQuoteCard(line, 96, unmeasured, false, 96)).toEqual({ top: 326, maxHeight: 96 })
  })

  it('keeps the pinned edge inside the band even after the quote scrolls out of it', () => {
    // 回归复现：`pinQuoteCard` 取代 `placeQuoteCard` 时把可见带钳制整条丢了——
    // `placeQuoteCard` 的 `top` 有 `Math.min(Math.max(rawTop, band.top), …)`，这里
    // 曾经只剩 `top: pinned`（below）/ `pinned - Math.min(height, maxHeight)`
    // （above），`pinned` 直接抄 `lastRect`、不看 `band`。卡片本身还刻意不看
    // `inBand`（"正在打字的浮层不许因为滚动而消失"），两者叠加：用户在卡片打开
    // 时滚动对话，卡片会跟着原文一路滚出可见带、直至滚出视口。
    // 杀法：删掉 below/above 分支里 `pinned = measured ? Math.min(Math.max(…` 那行
    // 钳制，换回 `const pinned = rawPinned`——下面四条断言全部变红（下方两条会
    // 报 504/100 之外的巨大或巨负坐标，上方两条同理）。
    const below = 600 - 96 // band.bottom - minHeight
    // 原文滚到可见带下方很远处：below 分支的上缘、above 分支的下缘都要被拉回带内。
    const farBelow = { top: 5000, bottom: 5020 }
    expect(pinQuoteCard(farBelow, 96, band, false, 96).top, '原文滚到带下方，below 分支的上缘').toBe(below)
    expect(pinQuoteCard(farBelow, 96, band, true, 96).top, '原文滚到带下方，above 分支钉住的下缘也要拉回来')
      .toBe(band.bottom - 96)
    // 原文滚到可见带上方很远处（甚至滚出视口上沿，坐标为负）。
    const farAbove = { top: -5000, bottom: -4980 }
    expect(pinQuoteCard(farAbove, 96, band, false, 96).top, '原文滚到带上方，below 分支的上缘').toBe(band.top)
    expect(pinQuoteCard(farAbove, 96, band, true, 96).top, '原文滚到带上方，above 分支').toBe(band.top)

    // 无论哪种情形，卡片实际占用的那一段都必须完全落在带内——"宁可压住引用
    // 原文，也不能让卡片整块滚出可见带"，与 placeQuoteCard 同一条优先级，只是
    // 钳的对象换成了被钉住的边。两个分支"占用区间"的算法不同，不能共用同一条
    // `top + maxHeight` 判据：
    //   below：`top` 是固定上缘，`maxHeight` 就是到 band.bottom 的余量，占用区间
    //          正是 `[top, top + maxHeight]`。
    //   above：`maxHeight` 量的是"到 band.top 的余量"，card 的下缘是 `pinned`
    //          （被钉住的那条边），不是 `top + maxHeight`——占用区间是
    //          `[top, pinned]`，而 `pinned` 本身已经钳进 `<= band.bottom`。
    for (const lastRect of [farBelow, farAbove]) {
      const below = pinQuoteCard(lastRect, 96, band, false, 96)
      expect(below.top, 'below 分支上缘滚出了带子').toBeGreaterThanOrEqual(band.top)
      expect(below.top + below.maxHeight, 'below 分支下缘滚出了带子').toBeLessThanOrEqual(band.bottom)

      const above = pinQuoteCard(lastRect, 96, band, true, 96)
      expect(above.top, 'above 分支上缘滚出了带子').toBeGreaterThanOrEqual(band.top)
      // above 分支被钉住的下缘 = top + min(height, maxHeight)；这里 height(96) 不
      // 超过 maxHeight，所以下缘就是 top + 96。
      expect(above.top + 96, 'above 分支下缘滚出了带子').toBeLessThanOrEqual(band.bottom)
    }
  })

  it('does not clamp the pinned edge when the band could not be measured', () => {
    // 带子量不出来（高 ≤ 0）说的是"还没布局"，不是"原文在带外"——与
    // placeQuoteCard 的 `measured` 门槛同形，这时不该钳。
    const unmeasured = { top: 0, bottom: 0, left: 0, right: 0 }
    const farBelow = { top: 5000, bottom: 5020 }
    // below：pinned = 5020 + GAP(6) = 5026，不钳。
    expect(pinQuoteCard(farBelow, 96, unmeasured, false, 96).top).toBe(5026)
    // above：pinned = 5000 - GAP(6) = 4994，不钳；top = pinned - min(96, maxHeight(96)) = 4898。
    expect(pinQuoteCard(farBelow, 96, unmeasured, true, 96).top).toBe(4898)
  })
})
