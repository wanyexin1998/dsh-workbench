// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  anchorRectsFromCache, createHumanAnchorCache, detectConversationDom,
  captureConversationRange, ensureQuoteHighlightStyles, findBusinessRow,
  locateConversationRoot, locateScrollport, quoteBand, resolveRowRange, tintableSubRanges,
} from './conversation-dom.js'
import { MAX_SELECTION_BYTES } from './selection-contract.js'

// MutationObserver delivery (one microtask) + the coalesced refresh (the next
// microtask) — a macrotask flush drains both turns.
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function anchor(key: string, kind: string): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-chat-anchor-key', key)
  el.setAttribute('data-chat-flow-kind', kind)
  return el
}

function makeScrollport() {
  const scrollport = document.createElement('div')
  scrollport.setAttribute('data-conversation-scroll', '')
  document.body.appendChild(scrollport)
  return scrollport
}

describe('createHumanAnchorCache (GA-032, Roadmap §9A.7)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('seeds with the anchors present at creation, user/steering only', () => {
    const scrollport = makeScrollport()
    const userA = anchor('a', 'user')
    const step = anchor('s1', 'assistant-step')
    const steeringB = anchor('b', 'steering')
    scrollport.append(userA, step, steeringB)
    const cache = createHumanAnchorCache(scrollport)
    try {
      const snapshot = cache.snapshot()
      expect(snapshot.map((a) => a.key)).toEqual(['a', 'b'])
      expect(snapshot[0]?.element).toBe(userA)
      expect(snapshot[1]?.element).toBe(steeringB)
    } finally {
      cache.dispose()
    }
  })

  it('refreshes coalesced when the structure changes (multiple mutations → one refresh)', async () => {
    const scrollport = makeScrollport()
    const original = anchor('a', 'user')
    scrollport.append(original)
    const cache = createHumanAnchorCache(scrollport)
    try {
      const added1 = anchor('b', 'user')
      const added2 = anchor('c', 'steering')
      const swapIn = anchor('a2', 'user')
      scrollport.append(added1, added2)
      scrollport.replaceChild(swapIn, original)
      // Two structural mutations within the same turn → coalesced into one
      // refresh; until the microtask flushes, the cache still holds the
      // pre-mutation snapshot.
      expect(cache.snapshot().map((a) => a.key)).toEqual(['a'])
      await flush()
      expect(cache.snapshot().map((a) => a.key)).toEqual(['a2', 'b', 'c'])
    } finally {
      cache.dispose()
    }
  })

  it('dispose stops structural refreshes', async () => {
    const scrollport = makeScrollport()
    const cache = createHumanAnchorCache(scrollport)
    cache.dispose()
    scrollport.append(anchor('late', 'user'))
    await flush()
    expect(cache.snapshot().map((a) => a.key)).toEqual([])
  })
})

describe('anchorRectsFromCache', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('maps cached elements to top-to-bottom rect entries, skipping detached ones', () => {
    const scrollport = makeScrollport()
    const userA = anchor('a', 'user')
    const userB = anchor('b', 'user')
    scrollport.append(userA, userB)
    const cache = createHumanAnchorCache(scrollport)
    try {
      userA.remove() // detached mid-session (e.g. virtualization)
      const rects = anchorRectsFromCache(cache.snapshot())
      expect(rects).toHaveLength(1)
      expect(rects[0]?.key).toBe('b')
      expect(typeof rects[0]?.top).toBe('number')
    } finally {
      cache.dispose()
    }
  })
})

describe('locateConversationRoot (GA-031 scope, sdk-facts.md)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('finds the ConversationRoot_root[data-phase] ancestor of the scrollport', () => {
    const root = document.createElement('div')
    root.className = 'ConversationRoot_root'
    root.setAttribute('data-phase', 'ready')
    const scrollport = makeScrollport()
    root.appendChild(scrollport)
    document.body.appendChild(root)
    expect(locateConversationRoot()).toBe(root)
  })

  it('returns null when the host has no root marker (caller falls back to body)', () => {
    makeScrollport()
    expect(locateConversationRoot()).toBeNull()
  })
})

describe('pane-scoped DOM lookup', () => {
  it('resolves each pane scrollport without falling back to the first document match', () => {
    const firstPane = document.createElement('section')
    const secondPane = document.createElement('section')
    const first = document.createElement('div')
    const second = document.createElement('div')
    first.dataset.conversationScroll = ''
    second.dataset.conversationScroll = ''
    firstPane.appendChild(first)
    secondPane.appendChild(second)
    document.body.append(firstPane, secondPane)

    expect(locateScrollport(firstPane)).toBe(first)
    expect(locateScrollport(secondPane)).toBe(second)
    firstPane.remove()
    secondPane.remove()
  })
})

describe('detectConversationDom (GA-030 probe, ADR-0001)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('reports the presence of each anchor independently', () => {
    expect(detectConversationDom()).toEqual({ scrollport: false, anchors: false, composer: false })
    const sp = document.createElement('div')
    sp.setAttribute('data-conversation-scroll', '')
    document.body.appendChild(sp)
    expect(detectConversationDom()).toEqual({ scrollport: true, anchors: false, composer: false })
    const row = document.createElement('div')
    row.setAttribute('data-chat-anchor-key', 'a')
    document.body.appendChild(row)
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    document.body.appendChild(seat)
    expect(detectConversationDom()).toEqual({ scrollport: true, anchors: true, composer: true })
  })
})

interface SelectionRow {
  pane: HTMLElement | null
  flow: HTMLElement
  row: HTMLElement
}

function selectionRow(sessionId: string | null, key: string, kind = 'user'): SelectionRow {
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

function rangeBetween(start: Text, startOffset: number, end: Text, endOffset: number): Range {
  const range = document.createRange()
  range.setStart(start, startOffset)
  range.setEnd(end, endOffset)
  return range
}

describe('captureConversationRange', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('captures normalized UTF-16 offsets inside one verified business row', () => {
    const { row } = selectionRow('left', 'node-1')
    const first = document.createTextNode('alpha ')
    const second = document.createTextNode('beta')
    row.append(first, second)
    const capture = captureConversationRange(rangeBetween(first, 2, second, 2), MAX_SELECTION_BYTES)
    expect(capture).toMatchObject({
      paneSessionId: 'left', nodeKey: 'node-1', nodeKind: 'user',
      text: 'pha be', startOffset: 2, endOffset: 8,
    })
  })

  it('fails closed for collapsed, cross-row, and cross-pane ranges', () => {
    const left = selectionRow('left', 'left-node')
    const right = selectionRow('right', 'right-node')
    const leftText = document.createTextNode('left')
    const rightText = document.createTextNode('right')
    left.row.append(leftText)
    right.row.append(rightText)

    expect(captureConversationRange(rangeBetween(leftText, 1, leftText, 1), MAX_SELECTION_BYTES)).toBeNull()
    expect(captureConversationRange(rangeBetween(leftText, 0, rightText, 5), MAX_SELECTION_BYTES)).toBeNull()
  })

  it('rejects ranges intersecting controls or editable content', () => {
    const { row } = selectionRow('left', 'node')
    const before = document.createTextNode('before')
    const button = document.createElement('button')
    button.textContent = 'control'
    const editable = document.createElement('span')
    editable.setAttribute('contenteditable', 'true')
    editable.textContent = 'editable'
    const after = document.createTextNode('after')
    row.append(before, button, editable, after)

    expect(captureConversationRange(rangeBetween(before, 0, after, 5), MAX_SELECTION_BYTES)).toBeNull()
    expect(captureConversationRange(rangeBetween(button.firstChild as Text, 0, button.firstChild as Text, 7), MAX_SELECTION_BYTES)).toBeNull()
    expect(captureConversationRange(rangeBetween(editable.firstChild as Text, 0, editable.firstChild as Text, 8), MAX_SELECTION_BYTES)).toBeNull()
  })

  it('rejects streaming and over-16-KiB selections', () => {
    const streaming = selectionRow('left', 'stream', 'assistant-step')
    streaming.row.dataset.streaming = 'true'
    const streamingText = document.createTextNode('partial')
    streaming.row.append(streamingText)
    expect(captureConversationRange(rangeBetween(streamingText, 0, streamingText, 7), MAX_SELECTION_BYTES)).toBeNull()

    const large = selectionRow('left', 'large')
    const largeText = document.createTextNode('界'.repeat(6000))
    large.row.append(largeText)
    expect(captureConversationRange(rangeBetween(largeText, 0, largeText, largeText.length), MAX_SELECTION_BYTES)).toBeNull()
  })
})

describe('findBusinessRow', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('matches data-chat-flow-key, not the anchor key findAnchor uses', () => {
    // selectionRow 故意让两个属性不同（anchor-<key> vs <key>）。引用身份里的
    // nodeKey 来自 data-chat-flow-key（captureConversationRange:140），混用
    // findAnchor 会解析到别的行 —— 这条测试就是那个混用的探测器。
    const { row } = selectionRow('left', 'node-1')
    row.append(document.createTextNode('alpha'))
    expect(findBusinessRow(document, 'node-1')).toBe(row)
    expect(findBusinessRow(document, 'anchor-node-1')).toBeNull()
  })

  it('is scoped: a row inside another pane is invisible from this pane', () => {
    const left = selectionRow('left', 'shared')
    const right = selectionRow('right', 'shared')
    left.row.append(document.createTextNode('l'))
    right.row.append(document.createTextNode('r'))
    expect(findBusinessRow(left.pane!, 'shared')).toBe(left.row)
    expect(findBusinessRow(right.pane!, 'shared')).toBe(right.row)
  })
})

describe('resolveRowRange (the inverse of captureConversationRange)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('round-trips every capture back to the same identity', () => {
    const { row } = selectionRow('left', 'node-1')
    // 多个文本节点 + 一个 CR/LF 节点：偏移坐标系里 \r\n 折成一个 \n，两套坐标
    // 会错位，往返必须把这一点也还原对。
    row.append(
      document.createTextNode('alpha '),
      document.createTextNode('be\r\nta'),
      document.createTextNode(' omega'),
    )
    const nodes = [row.childNodes[0] as Text, row.childNodes[1] as Text, row.childNodes[2] as Text]
    const probes: Array<[Text, number, Text, number]> = [
      [nodes[0]!, 0, nodes[0]!, 5],
      [nodes[0]!, 2, nodes[1]!, 2],
      [nodes[0]!, 6, nodes[1]!, 5],
      [nodes[1]!, 0, nodes[2]!, 6],
      [nodes[1]!, 4, nodes[2]!, 1],
      [nodes[0]!, 1, nodes[2]!, 6],
    ]
    for (const [startNode, startOffset, endNode, endOffset] of probes) {
      const captured = captureConversationRange(
        rangeBetween(startNode, startOffset, endNode, endOffset), MAX_SELECTION_BYTES,
      )
      expect(captured).not.toBeNull()
      const rebuilt = resolveRowRange(row, captured!.startOffset, captured!.endOffset)
      expect(rebuilt).not.toBeNull()
      const recaptured = captureConversationRange(rebuilt!, MAX_SELECTION_BYTES)
      expect({
        startOffset: recaptured?.startOffset,
        endOffset: recaptured?.endOffset,
        text: recaptured?.text,
        nodeKey: recaptured?.nodeKey,
      }).toEqual({
        startOffset: captured!.startOffset,
        endOffset: captured!.endOffset,
        text: captured!.text,
        nodeKey: captured!.nodeKey,
      })
    }
  })

  it('re-resolves after a re-render that silently collapsed the held Range', () => {
    // 这是"已入坞的引用绝不持有 Range"那条铁律的证据。宿主替换文本节点后：
    //   startContainer.isConnected === true   ← 边界按规范上移到父元素，父元素还连着
    //   collapsed === true / toString() === ''
    // 所以 isConnected 不是存活判据；重解析才是。jsdom 忠实复现了浏览器语义。
    const { row } = selectionRow('left', 'node-1')
    const original = document.createTextNode('alpha beta')
    row.append(original)
    const held = rangeBetween(original, 0, original, 5)
    const captured = captureConversationRange(held, MAX_SELECTION_BYTES)!
    expect(captured.text).toBe('alpha')

    row.replaceChild(document.createTextNode('alpha beta'), original)
    expect(held.startContainer.isConnected).toBe(true)
    expect(held.collapsed).toBe(true)
    expect(held.toString()).toBe('')
    expect(captureConversationRange(held, MAX_SELECTION_BYTES)).toBeNull()

    const rebuilt = resolveRowRange(row, captured.startOffset, captured.endOffset)!
    expect(rebuilt.toString()).toBe('alpha')
    expect(captureConversationRange(rebuilt, MAX_SELECTION_BYTES)?.text).toBe('alpha')
  })

  it('fails closed on inverted, negative, and out-of-range offsets', () => {
    const { row } = selectionRow('left', 'node-1')
    row.append(document.createTextNode('alpha'))
    expect(resolveRowRange(row, 2, 2)).toBeNull()
    expect(resolveRowRange(row, 3, 1)).toBeNull()
    expect(resolveRowRange(row, -1, 3)).toBeNull()
    expect(resolveRowRange(row, 0, 99)).toBeNull()
    expect(resolveRowRange(row, 1.5, 3)).toBeNull()
  })

  it('uses the same eligibility rules as the capture side (controls excluded)', () => {
    // eligibleTextNodes 跳过控件内的文本。如果 resolveRowRange 另起一套遍历，
    // 偏移就会整体漂移 —— 这里的期望值来自捕获端，两边必须同源。
    const { row } = selectionRow('left', 'node-1')
    const button = document.createElement('button')
    button.textContent = 'CONTROL'
    row.append(document.createTextNode('alpha '), button, document.createTextNode('beta'))
    const rebuilt = resolveRowRange(row, 6, 10)
    expect(rebuilt?.toString()).toBe('beta')
  })

  it('does not let a control WRAPPING the row swallow the whole row', () => {
    // 判据一直是「控件在**行内部**」（原写法 `row.contains(closest(...))`）。
    // 行外面的祖先控件——宿主把整条消息包进一个 [role="button"] 的历史列表就是
    // 这样——一个字都不该被排除，否则整行突然不可引用。
    const { flow, row } = selectionRow('left', 'node-1')
    const wrapper = document.createElement('div')
    wrapper.setAttribute('role', 'button')
    flow.replaceChild(wrapper, row)
    wrapper.appendChild(row)
    row.append(document.createTextNode('alpha beta'))
    expect(resolveRowRange(row, 6, 10)?.toString()).toBe('beta')
  })

  it('skips text hidden by an ancestor, so the offsets stay in the visible coordinate system', () => {
    // elementIsVisible 要一路走到 row。漏掉祖先那一层，GHOST 会被算进行文本，
    // 偏移整体右移，重解析出来的就是另一段字。
    // 藏的是**祖父**、直接父元素完全正常 —— 只看文本节点自己那一层的实现会
    // 一路放行，这条正是冲着那种实现写的。
    const { row } = selectionRow('left', 'node-1')
    const ghost = document.createElement('div')
    ghost.style.display = 'none'
    const inner = document.createElement('span')
    inner.textContent = 'GHOST'
    ghost.appendChild(inner)
    row.append(document.createTextNode('alpha '), ghost, document.createTextNode('beta'))
    expect(resolveRowRange(row, 6, 10)?.toString()).toBe('beta')
  })
})

describe('ensureQuoteHighlightStyles', () => {
  it('injects one scoped style tag carrying all three highlight rules and the placeholder rule', () => {
    ensureQuoteHighlightStyles()
    ensureQuoteHighlightStyles()
    const tags = document.head.querySelectorAll('[data-dsh-nux-styles="quote-highlight"]')
    expect(tags.length).toBe(1)
    const css = tags[0]!.textContent ?? ''
    expect(css).toContain('::highlight(dsh-nux-quote){')
    expect(css).toContain('::highlight(dsh-nux-quote-active){')
    // 下划线是可辨识载体（浅 4.23:1）。底色只有 1.18 / 1.78，是装饰。
    expect(css).toContain('text-decoration-color:var(--dsw-alias-state-business-primary,#4176e6)')
    // 底色只出现在**第三个**条目里。前两条一个字都不许碰 background —— 它们收的
    // 是全部 Range，铺上去就会盖掉代码块 / Diff 自带的背景（深色 shiki constant
    // 6.95:1 → 4.13:1、DiffBlock error 5.23:1 → 3.11:1，都掉破 4.5）。
    const [base, active, tint] = css.split('::highlight(').slice(1)
    expect(base).not.toContain('background-color')
    expect(active).not.toContain('background-color')
    expect(tint).toContain('dsh-nux-quote-tint')
    expect(tint).toContain('background-color:var(--dsw-alias-state-business-tertiary,#e4edfd)')
    // 底色不随 active 变，所以条目名是 3 个而不是 4 个。
    expect(css.split('::highlight(').length - 1).toBe(3)
    // emphasis 只加粗下划线，不换色。
    expect(css).toContain('text-decoration-thickness:3px')
    // placeholder 是真文字，要过 4.5:1 —— label-tertiary 浅色只有 3.71，不够。
    expect(css).toContain('[data-dsh-quote-comment]::placeholder{color:var(--dsw-alias-label-secondary,#61666b)')
    // 每个 token 都带 fallback：规则里不允许出现无兜底的 var()。
    expect(css.match(/var\(--[a-z0-9-]+\)/g)).toBeNull()
  })
})

/**
 * 底色分流。判据是**元素自己画不画背景**，不是一串 `pre, code, [data-read] …`
 * 抑制选择器——后者漏一个就回归，而且那是把宿主私有结构抄进样式表。
 */
describe('tintableSubRanges', () => {
  afterEach(() => { document.body.innerHTML = '' })

  function row(): HTMLElement {
    const el = document.createElement('article')
    el.dataset.chatAnchorKey = 'anchor-n1'
    el.dataset.chatFlowKey = 'n1'
    el.dataset.chatFlowKind = 'user'
    document.body.appendChild(el)
    return el
  }

  it('tints exactly the quoted slice of plain prose', () => {
    const el = row()
    const text = document.createTextNode('alpha beta gamma')
    el.appendChild(text)
    const range = document.createRange()
    range.setStart(text, 6)
    range.setEnd(text, 10)
    expect(tintableSubRanges(range, el).map((sub) => sub.toString())).toEqual(['beta'])
  })

  it('refuses to tint text sitting on a surface that paints its own background', () => {
    // 代码块 / ReadBlock / DiffBlock 的文字颜色是照那块底色调的。给它铺一层淡蓝，
    // shiki 的语法色就掉到一个谁也没审过的底色上（深色 constant 6.95:1 → 4.13:1）。
    const el = row()
    const code = document.createElement('code')
    code.style.backgroundColor = 'rgb(249, 250, 251)'
    const text = document.createTextNode('const x = 1')
    code.appendChild(text)
    el.appendChild(code)
    const range = document.createRange()
    range.selectNodeContents(text)
    expect(tintableSubRanges(range, el)).toEqual([])
  })

  it('splits one quote that crosses prose and a self-painted surface into two sub-ranges', () => {
    const el = row()
    const head = document.createTextNode('see ')
    const code = document.createElement('code')
    code.style.backgroundColor = 'rgb(249, 250, 251)'
    code.appendChild(document.createTextNode('flush()'))
    const tail = document.createTextNode(' below')
    el.append(head, code, tail)
    const range = document.createRange()
    range.setStart(head, 0)
    range.setEnd(tail, 6)
    // 引用本体（高亮的下划线）仍然是完整一条；只有底色被拆开。
    expect(range.toString()).toBe('see flush() below')
    expect(tintableSubRanges(range, el).map((sub) => sub.toString())).toEqual(['see ', ' below'])
  })

  it('counts a background-image (gradient) as self-painted too', () => {
    const el = row()
    const banner = document.createElement('span')
    banner.style.backgroundImage = 'linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))'
    const text = document.createTextNode('gradient')
    banner.appendChild(text)
    el.appendChild(banner)
    const range = document.createRange()
    range.selectNodeContents(text)
    expect(tintableSubRanges(range, el)).toEqual([])
  })

  it('treats a fully transparent background-color as no background at all', () => {
    // 宿主里绝大多数容器的计算值就是 `rgba(0, 0, 0, 0)`。把它当成"有底色"会让
    // 底色一次都铺不出来。
    const el = row()
    const wrapper = document.createElement('span')
    wrapper.style.backgroundColor = 'rgba(0, 0, 0, 0)'
    const text = document.createTextNode('still prose')
    wrapper.appendChild(text)
    el.appendChild(wrapper)
    const range = document.createRange()
    range.selectNodeContents(text)
    expect(tintableSubRanges(range, el).map((sub) => sub.toString())).toEqual(['still prose'])
  })

  it('counts a semi-transparent background as painted too', () => {
    // 宿主的高亮行 / 选中态用的就是 alpha 在 0 与 1 之间的底色。把它当"没底色"
    // 会让淡蓝直接合到那块半透明底上，颜色谁也没审过。
    const el = row()
    const marked = document.createElement('span')
    marked.style.backgroundColor = 'rgba(34, 197, 94, 0.1)'
    const text = document.createTextNode('added line')
    marked.appendChild(text)
    el.appendChild(marked)
    const range = document.createRange()
    range.selectNodeContents(text)
    expect(tintableSubRanges(range, el)).toEqual([])
  })

  it('leaves a DiffBlock alone: the card paints, the +/- lines only recolour text', () => {
    // DiffBlock 的真实结构（ui-primitives/src/DiffBlock.module.css）：只有外层
    // .block 画 markdown-code-block 底，.del/.add 仅换字色。所以判据必须一路
    // 走到那层外壳，只看叶子节点会把整块 diff 铺成淡蓝：深色 error 5.23:1 →
    // 3.11:1、success 7.55:1 → 4.49:1，两条都掉破 4.5。
    const el = row()
    const block = document.createElement('div')
    block.style.backgroundColor = 'rgb(27, 27, 28)'
    const del = document.createElement('div')
    del.style.color = 'rgb(242, 90, 90)'
    del.appendChild(document.createTextNode('- old line'))
    const add = document.createElement('div')
    add.style.color = 'rgb(34, 197, 94)'
    add.appendChild(document.createTextNode('+ new line'))
    block.append(del, add)
    el.appendChild(block)
    const range = document.createRange()
    range.setStart(del.firstChild!, 0)
    range.setEnd(add.firstChild!, 10)
    expect(range.toString()).toBe('- old line+ new line')
    expect(tintableSubRanges(range, el)).toEqual([])
  })

  it('walks all the way up to the row, so a painted ancestor also suppresses the tint', () => {
    const el = row()
    const block = document.createElement('div')
    block.style.backgroundColor = 'rgb(27, 27, 28)'
    const inner = document.createElement('span')
    const text = document.createTextNode('nested')
    inner.appendChild(text)
    block.appendChild(inner)
    el.appendChild(block)
    const range = document.createRange()
    range.selectNodeContents(text)
    expect(tintableSubRanges(range, el)).toEqual([])
  })
})

describe('quoteBand', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('reports the left edge too, and keeps the right edge clear of the scrollbar gutter', () => {
    // 徽标永远靠右，所以带子原本只说 top/bottom/right。胶囊和卡片是有宽度的
    // 盒子，水平钳制两侧都要用 —— 少了 left，窄 Pane 上卡片会挂到正文列左边
    // 的视口外面去。
    const scrollport = document.createElement('div')
    scrollport.setAttribute('data-conversation-scroll', '')
    document.body.appendChild(scrollport)
    scrollport.getBoundingClientRect = () => ({
      top: 100, bottom: 600, left: 40, right: 800, width: 760, height: 500, x: 40, y: 100,
      toJSON: () => ({}),
    }) as DOMRect
    Object.defineProperty(scrollport, 'offsetWidth', { configurable: true, value: 760 })
    Object.defineProperty(scrollport, 'clientWidth', { configurable: true, value: 745 })
    expect(quoteBand(scrollport)).toEqual({ top: 100, bottom: 600, left: 40, right: 785 })
  })
})
