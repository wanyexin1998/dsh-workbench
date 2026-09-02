// @vitest-environment jsdom
import * as React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUOTE_HIGHLIGHT_ACTIVE_NAME, QUOTE_HIGHLIGHT_NAME } from './conversation-dom.js'
import { createQuoteHighlightRegistry, type QuoteHighlightPainter } from './quote-highlight.js'
import { QuoteBadge, useQuoteAnchors, type QuoteAnchorSnapshot } from './quote-overlay.js'
import type { SelectionAggregateItem } from './selection-reference.js'

// 重解析次数是这一层唯一说得清的性能指标，所以直接数 resolveQuoteAnchor 的调用
// 次数（原样透传，不改行为）。
const counters = vi.hoisted(() => ({ resolve: 0 }))
vi.mock('./quote-highlight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./quote-highlight.js')>()
  return {
    ...actual,
    resolveQuoteAnchor: (...args: Parameters<typeof actual.resolveQuoteAnchor>) => {
      counters.resolve += 1
      return actual.resolveQuoteAnchor(...args)
    },
  }
})

/* ── 宿主替身 ──────────────────────────────────────────────────────────── */

interface Conversation {
  readonly scrollport: HTMLElement
  readonly quoted: HTMLElement
  readonly streaming: HTMLElement
  readonly token: Text
  readonly flow: HTMLElement
}

function businessRow(key: string, kind: string): HTMLElement {
  const row = document.createElement('article')
  row.dataset.chatAnchorKey = `anchor-${key}`
  row.dataset.chatFlowKey = key
  row.dataset.chatFlowKind = kind
  return row
}

/** `[data-session-pane] > .ConversationRoot_root[data-phase] > [data-conversation-scroll] > [data-chat-flow]`。 */
function buildConversation(): Conversation {
  const pane = document.createElement('section')
  pane.dataset.sessionPane = 'left'
  const root = document.createElement('div')
  root.className = 'ConversationRoot_root'
  root.dataset.phase = 'active'
  const scrollport = document.createElement('div')
  scrollport.setAttribute('data-conversation-scroll', '')
  const flow = document.createElement('div')
  flow.dataset.chatFlow = ''
  const quoted = businessRow('node-1', 'user')
  quoted.append(document.createTextNode('alpha beta'))
  const streaming = businessRow('node-2', 'assistant-step')
  streaming.dataset.streaming = 'true'
  const token = document.createTextNode('思')
  streaming.append(token)
  flow.append(quoted, streaming)
  scrollport.appendChild(flow)
  root.appendChild(scrollport)
  pane.appendChild(root)
  document.body.appendChild(pane)
  return { scrollport, quoted, streaming, token, flow }
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

/** 可见带 100..600，右缘 800（jsdom 的 offsetWidth/clientWidth 都是 0，滚动条槽为 0）。 */
function bandOf(scrollport: HTMLElement, right = 800): void {
  vi.spyOn(scrollport, 'getBoundingClientRect').mockReturnValue({
    top: 100, bottom: 600, left: 0, right, width: right, height: 500, x: 0, y: 100, toJSON: () => ({}),
  } as DOMRect)
}

function rowRight(row: HTMLElement, right: number): void {
  vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
    top: 300, bottom: 340, left: 0, right, width: right, height: 40, x: 0, y: 300, toJSON: () => ({}),
  } as DOMRect)
}

/** 所有 Range 都报同一条末行矩形 —— 制造"两条引用落在同一视觉行"。 */
function stubClientRects(rects: Array<{ top: number; bottom: number; right: number }>): void {
  ;(Range.prototype as unknown as { getClientRects?: unknown }).getClientRects =
    () => rects as unknown as DOMRectList
}

/* ── rAF 手动泵 ────────────────────────────────────────────────────────── */

const frames = new Map<number, FrameRequestCallback>()
let nextFrameId = 1

function installFramePump(): void {
  frames.clear()
  nextFrameId = 1
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrameId
    nextFrameId += 1
    frames.set(id, callback)
    return id
  }) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((id: number) => { frames.delete(id) }) as typeof window.cancelAnimationFrame
}

function runFrames(): void {
  const pending = Array.from(frames.values())
  frames.clear()
  act(() => { for (const callback of pending) callback(0) })
}

/** MutationObserver 的回调走微任务；先把它放出来，再泵一帧。 */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  runFrames()
}

/* ── 探针 ──────────────────────────────────────────────────────────────── */

let latest: QuoteAnchorSnapshot = { states: new Map(), badges: [], openAnchor: null }
let renders = 0

function Probe(props: {
  items: readonly SelectionAggregateItem[]
  revision: string
  registry: ReturnType<typeof createQuoteHighlightRegistry>
  openItemId?: string | null
}) {
  renders += 1
  latest = useQuoteAnchors({
    items: props.items, revision: props.revision, sessionId: 'left',
    activeItemId: null, openItemId: props.openItemId ?? null,
    ownerId: 'left', registry: props.registry,
  })
  return null
}

describe('useQuoteAnchors', () => {
  let dom: Conversation

  beforeEach(() => {
    ;(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    installFramePump()
    counters.resolve = 0
    renders = 0
    dom = buildConversation()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete (Range.prototype as unknown as { getClientRects?: unknown }).getClientRects
    document.body.innerHTML = ''
  })

  function mount(items: readonly SelectionAggregateItem[] = [item()], openItemId: string | null = null) {
    const painter = fakePainter()
    const registry = createQuoteHighlightRegistry(painter)
    const view = render(
      <Probe items={items} revision="r1" registry={registry} openItemId={openItemId} />,
    )
    runFrames()
    return { painter, registry, view }
  }

  it('re-parses nothing while a DIFFERENT row streams token by token', async () => {
    // 观察器挂在会话根上、characterData + subtree 全开：流式输出期间每帧都有记录
    // 进来。过滤掉之前这里是每帧一次全量重解析（每条引用一遍 eligibleTextNodes，
    // 每个文本节点一次 getComputedStyle），而且跑在 useLayoutEffect 里同步阻塞。
    mount()
    expect(counters.resolve).toBe(1)
    const afterMount = counters.resolve
    for (let frame = 0; frame < 60; frame += 1) {
      dom.token.data = `思考中${frame}`
      await settle()
    }
    expect(counters.resolve - afterMount).toBe(0)
  })

  it('does the parsing OFF the layout phase (it used to block layout synchronously)', () => {
    // 兄弟组件的 useLayoutEffect 在同一次 commit 的 layout 阶段跑；解析若还挂在
    // useLayoutEffect 上，它会**先于**这个探针跑完（Probe 排在前面），计数就已经
    // 是 1 了。挪到 useEffect 之后，layout 阶段结束时解析一次都还没发生。
    let resolveAtLayout = -1
    function LayoutProbe() {
      React.useLayoutEffect(() => { resolveAtLayout = counters.resolve })
      return null
    }
    const registry = createQuoteHighlightRegistry(fakePainter())
    render(
      <>
        <Probe items={[item()]} revision="r1" registry={registry} />
        <LayoutProbe />
      </>,
    )
    expect(resolveAtLayout).toBe(0)
    expect(counters.resolve).toBe(1)
  })

  it('still re-parses when a business row is added or removed', async () => {
    // 闸门不能把虚拟化换入换出、历史重载、Pane 切换一起挡掉 —— detached 的条目
    // 全靠这条等到"行回来了"。
    mount()
    const before = counters.resolve
    const extra = businessRow('node-3', 'user')
    extra.append(document.createTextNode('gamma'))
    dom.flow.appendChild(extra)
    await settle()
    expect(counters.resolve).toBe(before + 1)
    extra.remove()
    await settle()
    expect(counters.resolve).toBe(before + 2)
  })

  it('still re-parses when the quoted row itself is edited', async () => {
    mount()
    const before = counters.resolve
    ;(dom.quoted.firstChild as Text).data = 'ALPHA beta'
    await settle()
    expect(counters.resolve).toBe(before + 1)
    // 原文变了 —— 绝不吸附到别的片段。
    expect(latest.states.get('q1')).toBe('detached')
  })

  it('publishes once and then leaves the highlight alone across scroll frames', async () => {
    // 设计注释与 deviation 都写着"滚动只重算徽标矩形、高亮一动不动"，可 publish
    // 之前是无条件的：每帧一次 new Highlight(...) + CSS.highlights.set。
    bandOf(dom.scrollport)
    rowRight(dom.quoted, 700)
    stubClientRects([{ top: 300, bottom: 320, right: 690 }])
    const { painter } = mount()
    const sets = painter.calls.filter(([name]) => name === QUOTE_HIGHLIGHT_NAME).length
    expect(sets).toBe(1)
    const deletes = painter.deletes.length
    for (let frame = 0; frame < 30; frame += 1) {
      dom.scrollport.dispatchEvent(new Event('scroll'))
      await settle()
    }
    expect(painter.calls.filter(([name]) => name === QUOTE_HIGHLIGHT_NAME).length).toBe(sets)
    expect(painter.deletes.length).toBe(deletes)
    // 徽标仍然每帧重算 —— 被挡掉的只有高亮重建。
    expect(latest.badges.length).toBe(1)
  })

  it('carries the open quote’s geometry so the card can follow the scroll with no new observer', () => {
    // 标签 / 卡片的滚动跟随**必须**挂在这里已有的 viewTick 上。新增第二个
    // ResizeObserver / MutationObserver / scroll 监听会直接推翻上一轮"滚动只重量、
    // 不重解析"的成果，所以几何由测量帧顺手带出来（它本来就在量这两个矩形）。
    bandOf(dom.scrollport)
    rowRight(dom.quoted, 700)
    stubClientRects([{ top: 300, bottom: 320, right: 690 }])
    mount([item()], 'q1')
    expect(latest.openAnchor).toMatchObject({ itemId: 'q1', top: 300, bottom: 320, inBand: true })
    expect(latest.openAnchor!.band).toMatchObject({ top: 100, bottom: 600, left: 0, right: 800 })
  })

  it('makes an open card cost ZERO extra renders per scroll frame', async () => {
    // sameSnapshot 必须把 openAnchor 一起比。漏掉它 = 每个滚动帧都产出一个新
    // 快照对象 → 在 viewTick 那次重渲染之上再多一次 → 卡片自己的尺寸测量
    // useLayoutEffect 与它互相激发。判据取"开着卡片 vs 没开卡片，每帧的渲染
    // 次数相同"，因为 viewTick 本身每帧就要重渲染一次，绝对次数说明不了问题。
    bandOf(dom.scrollport)
    rowRight(dom.quoted, 700)
    stubClientRects([{ top: 300, bottom: 320, right: 690 }])

    const scrollTwenty = async () => {
      const before = renders
      for (let frame = 0; frame < 20; frame += 1) {
        dom.scrollport.dispatchEvent(new Event('scroll'))
        await settle()
      }
      return renders - before
    }

    mount([item()])
    const closed = await scrollTwenty()
    cleanup()
    mount([item()], 'q1')
    expect(latest.openAnchor).not.toBeNull()
    const open = await scrollTwenty()
    expect(open).toBe(closed)

    // 几何真的动了才重渲染。
    const before = renders
    stubClientRects([{ top: 200, bottom: 220, right: 690 }])
    dom.scrollport.dispatchEvent(new Event('scroll'))
    await settle()
    expect(renders).toBeGreaterThan(before)
    expect(latest.openAnchor).toMatchObject({ top: 200, bottom: 220 })
  })

  it('re-publishes as soon as the ranges really change', async () => {
    bandOf(dom.scrollport)
    stubClientRects([{ top: 300, bottom: 320, right: 690 }])
    const { painter } = mount()
    const before = painter.calls.filter(([name]) => name === QUOTE_HIGHLIGHT_NAME).length
    ;(dom.quoted.firstChild as Text).data = 'ALPHA beta'
    await settle()
    expect(painter.deletes).toContain(QUOTE_HIGHLIGHT_NAME)
    expect(painter.calls.filter(([name]) => name === QUOTE_HIGHLIGHT_NAME).length).toBe(before)
    expect(painter.deletes).toContain(QUOTE_HIGHLIGHT_ACTIVE_NAME)
  })

  it('publishes an empty draft exactly once and then stays quiet', async () => {
    // "我这份是空的"也要说出口——registry 合并多个 owner，沉默不等于空。
    // 但只说一次：之后每一帧都重复一遍就是 4 的另一种形态。
    const { painter, registry } = mount([])
    expect(registry.size).toBe(1)
    const writes = painter.calls.length + painter.deletes.length
    // 三个条目名（基础 / active / 底色）各撤一次。
    expect(writes).toBe(3)
    for (let frame = 0; frame < 10; frame += 1) {
      dom.scrollport.dispatchEvent(new Event('scroll'))
      await settle()
    }
    expect(painter.calls.length + painter.deletes.length).toBe(writes)
  })

  it('reports "unmeasured", not "offscreen", when the geometry cannot be read', () => {
    // jsdom 里 Range.getClientRects 不存在 —— 真实浏览器里的对应情形是滚动容器
    // 还没布局。屏读用户听到的必须不是「原文当前不在视野内」（那是假话）。
    bandOf(dom.scrollport)
    mount()
    expect(latest.states.get('q1')).toBe('unmeasured')
    expect(latest.badges.length).toBe(0)
  })

  it('reports "unmeasured" while the band itself has no measured height', () => {
    stubClientRects([{ top: 300, bottom: 320, right: 690 }])
    mount()
    expect(latest.states.get('q1')).toBe('unmeasured')
  })

  it('reports "offscreen" only when the line really scrolled out of the band', () => {
    bandOf(dom.scrollport)
    stubClientRects([{ top: 900, bottom: 920, right: 690 }])
    mount()
    expect(latest.states.get('q1')).toBe('offscreen')
  })

  it('places the badge outside the text column instead of over the row’s last characters', () => {
    bandOf(dom.scrollport)
    rowRight(dom.quoted, 700)
    stubClientRects([{ top: 300, bottom: 320, right: 700 }])
    mount()
    expect(latest.states.get('q1')).toBe('anchored')
    expect(latest.badges[0]!.left).toBeGreaterThanOrEqual(700)
  })

  it('keeps two badges on the same visual line from landing on the same pixel', () => {
    bandOf(dom.scrollport)
    rowRight(dom.quoted, 700)
    stubClientRects([{ top: 300, bottom: 320, right: 690 }])
    mount([
      item({ id: 'q1', text: 'alpha', startOffset: 0, endOffset: 5 }),
      item({ id: 'q2', text: 'beta', startOffset: 6, endOffset: 10 }),
    ])
    expect(latest.badges.length).toBe(2)
    const [first, second] = latest.badges
    expect(first!.top).toBe(second!.top)
    expect(first!.left).not.toBe(second!.left)
  })
})
/**
 * 徽标的外观契约。
 *
 * 这里断言的每一条都是无障碍算过的数，不是审美：同一个 `QuoteBadge` 这一轮进了
 * **四个**表面（正文层 bg-base、代码块 markdown-code-block、标签与引用列表行
 * 的 bg-layer-3），而徽标底 `deepseek-600 #4868b2` 对深色 bg-layer-3 #353638
 * 只有 **2.25:1**，撑不起 WCAG 1.4.11 要求的 3:1 非文本边界。
 * 描边（label-secondary，浅 #61666b / 深 #cfd3d6）才是那条边界（完整
 * 四表面 × 双主题 × 三态推导见 quote-overlay.tsx 里 QuoteBadge 上方的注释）：
 *   正文层 bg-base                浅 5.80 / 5.21 / 4.84   深 12.11 / 9.81 / 8.04
 *   代码块 markdown-code-block    浅 5.55 / 4.99 / 4.63   深 11.43 / 9.10 / 7.44
 *   标签/列表 bg-layer-3          浅 5.80 / 5.21 / 4.84   深  8.03 / 6.26 / 5.18
 * 最低 4.63:1（浅色代码块面 × pressed），四表面 × 两主题 × 三交互态全过。
 * 删掉它 = 深色下标签/列表里的徽标没有边界，所以它必须有一条测试守着。
 */
describe('QuoteBadge', () => {
  afterEach(cleanup)

  function badge(state: 'anchored' | 'detached', emphasis = false): HTMLElement {
    render(<QuoteBadge label="1" state={state} emphasis={emphasis} />)
    return document.querySelector<HTMLElement>('[data-dsh-quote-badge]')!
  }

  it('carries the 1.4.11 boundary as a solid stroke, not as the fill', () => {
    const style = badge('anchored').getAttribute('style') ?? ''
    expect(style).toContain('1px solid var(--dsw-alias-label-secondary, #61666b)')
    // 底仍然是实心蓝 + 白字（5.39:1，与表面无关——底不透明）。
    expect(style).toContain('var(--dsw-static-deepseek-600, #4868b2)')
    expect(style).toContain('var(--dsw-static-neutral-bluish-00, #fff)')
  })

  it('keeps the box identical across resting, emphasis and detached (zero layout shift)', () => {
    // 三态都必须是 1px 描边、同样的 min-width/height/padding。emphasis 只换
    // box-shadow 的颜色 —— 换成 border 变粗就是每次 hover 都推一次布局。
    const metrics = (el: HTMLElement) => {
      const style = el.getAttribute('style') ?? ''
      return [
        /border: 1px (solid|dashed)/.test(style),
        style.includes('min-width: 16px'), style.includes('height: 16px'),
        style.includes('padding: 0px 4px'), style.includes('box-sizing: border-box'),
      ]
    }
    const resting = metrics(badge('anchored'))
    cleanup()
    const strong = metrics(badge('anchored', true))
    cleanup()
    const gone = metrics(badge('detached'))
    expect(resting).toEqual([true, true, true, true, true])
    expect(strong).toEqual(resting)
    expect(gone).toEqual(resting)
  })

  it('draws emphasis as a TWO-layer ring, page colour first', () => {
    // 单层不行：`state-business-primary #4176e6` 的环直接画在徽标底 #4868b2 上
    // 只有 **1.27:1**，等于没画。内环取页面色把两者隔开，外环才有东西可比
    // （内环/徽标底 浅 5.39 深 3.39；外环/页面 浅 4.23 深 6.86）。
    const style = badge('anchored', true).getAttribute('style') ?? ''
    const inner = style.indexOf('2px var(--dsw-alias-bg-base, #fff)')
    const outer = style.indexOf('4px var(--dsw-alias-state-business-primary, #4176e6)')
    expect(inner).toBeGreaterThan(-1)
    expect(outer).toBeGreaterThan(inner)
  })

  it('writes the same two-layer structure transparent when resting', () => {
    // 静息态若写 `none`，emphasis 一开一关就是 4px 的布局跳动。
    const style = badge('anchored').getAttribute('style') ?? ''
    expect(style).toContain('0 0 0 2px transparent, 0 0 0 4px transparent')
  })

  it('marks a detached quote with the dashed, unfilled variant', () => {
    const style = badge('detached').getAttribute('style') ?? ''
    expect(style).toContain('1px dashed var(--dsw-alias-label-tertiary, #81858c)')
    expect(style).toContain('background: transparent')
    expect(style).not.toContain('#4868b2')
  })
})
