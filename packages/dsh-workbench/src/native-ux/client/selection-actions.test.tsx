// @vitest-environment jsdom
import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addSelectionToConversation, applySelectionActions, createSelectionItemId, FOCUS_RING_COLOR,
  placeSelectionToolbar, SelectionDock, SelectionToolbar,
  type SelectionApplyContext, type SelectionApplyServices,
} from './selection-actions.js'
import { SelectionController } from './selection-controller.js'
import type { ConversationSelection } from './selection-contract.js'
import type { QuoteHighlightRegistry } from './quote-highlight.js'
import {
  encodeSelectionAggregate, SELECTION_AGGREGATE_VERSION, SELECTION_REFERENCE_SOURCE,
  type SelectionAggregateV1, type SelectionMutationResult,
} from './selection-reference.js'
import type { SideChatActions, SideChatResult } from './side-chat-actions.js'
import { en, zh } from '../../client/dictionaries.js'

const t = (key: string, vars?: Record<string, string>) => key === 'selection.side.partial'
  ? `${key} ${vars?.childId ?? ''}`.trim()
  : key

/** 中文宿主的真实 t()：从 zh 字典取模板，vars 缺省时原样保留 `{占位符}`（与真实
 * locale.bind() 的语义一致——见 selection-reference.ts 里 quoteHeading()/quoteItemLabel()
 * 自己去 replace('{count}', …) 这件事，说明 t() 不传 vars 时不该替换)。 */
function zhTranslate(key: string, vars?: Record<string, string>): string {
  const template = (zh as Record<string, string>)[key] ?? key
  if (vars === undefined) return template
  return Object.entries(vars).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), template)
}

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

/** 永不落定的 side 动作：让工具条停在 pending 态，好观察 pending 提示与忙光标。 */
function neverSettles(): SideChatActions['moreDetails'] {
  return vi.fn(() => new Promise<SideChatResult>(() => {}))
}

/**
 * jsdom 不做布局，offsetWidth/offsetHeight 恒为 0，浮层量不到自己的尺寸。
 * 这里只给浮层本体喂一个真实尺寸，其余元素保持 0。
 */
function measureToolbar(size: { readonly width: number; readonly height: number }): () => void {
  const proto = HTMLElement.prototype
  const saved = (['offsetWidth', 'offsetHeight'] as const)
    .map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const)
  const define = (key: 'offsetWidth' | 'offsetHeight', value: number) => {
    Object.defineProperty(proto, key, {
      configurable: true,
      get(this: HTMLElement) { return this.hasAttribute('data-dsh-selection-toolbar') ? value : 0 },
    })
  }
  define('offsetWidth', size.width)
  define('offsetHeight', size.height)
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor !== undefined) Object.defineProperty(proto, key, descriptor)
    }
  }
}

function toolbarBox(height: number): { readonly top: number; readonly bottom: number } {
  const wrapper = document.querySelector('[data-dsh-selection-toolbar]') as HTMLElement | null
  if (wrapper === null) throw new Error('toolbar not rendered')
  const top = Number.parseFloat(wrapper.style.top)
  return { top, bottom: top + height }
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
    expect(screen.getByRole('group', { name: 'selection.toolbar.label' })).toBeTruthy()
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

  it('keeps the labelled group to controls only and renders the notice outside it', () => {
    render(<SelectionToolbar
      controller={controllerWith(selection())}
      onAdd={() => ({ ok: false, message: 'stale selection' })}
      sideChat={sideChat()}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'selection.add' }))
    const group = screen.getByRole('group', { name: 'selection.toolbar.label' })
    const status = screen.getByRole('status')
    expect(group.contains(status)).toBe(false)
    expect(Array.from(group.children).every((child) => (
      child.tagName === 'BUTTON' || child.getAttribute('aria-hidden') === 'true'
    ))).toBe(true)
  })

  it('shows a visible focus ring while a toolbar action holds keyboard focus', () => {
    render(<SelectionToolbar controller={controllerWith(selection())} onAdd={() => ({ ok: true })} t={t} />)
    const add = screen.getByRole('button', { name: 'selection.add' })
    expect(add.getAttribute('style')).not.toContain('outline: 2px')
    fireEvent.focusIn(add)
    expect(add.getAttribute('style')).toContain('outline: 2px solid')
    fireEvent.focusOut(add)
    expect(add.getAttribute('style')).not.toContain('outline: 2px')
  })

  it('draws the focus ring outside the fill, in the token the contrast audit passed', () => {
    render(<SelectionToolbar controller={controllerWith(selection())} onAdd={() => ({ ok: true })} t={t} />)
    const add = screen.getByRole('button', { name: 'selection.add' })
    // offset 必须为正：环压在填充上时，深色主按钮填充是近白的 #f9fafb，只有 2.04:1。
    expect(add.style.outlineOffset).toBe('2px')
    fireEvent.focusIn(add)
    // 钉住 token 本身 —— 只断言 'outline' 钉不住对比度，换回 label-tertiary 会重新塌掉。
    expect(add.getAttribute('style')).toContain(`outline: 2px solid ${FOCUS_RING_COLOR}`)
  })

  it('puts the busy cursor on the buttons themselves, not only in the container gaps', () => {
    render(<SelectionToolbar
      controller={controllerWith(selection())}
      onAdd={() => ({ ok: true })}
      sideChat={sideChat(neverSettles())}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'selection.moreDetails' }))
    // 子元素自带的 cursor 声明压过从容器继承，所以每个按钮都要自己写。
    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).style.cursor).toBe('wait')
    }
    const wrapper = document.querySelector('[data-dsh-selection-toolbar]') as HTMLElement
    expect(wrapper.style.cursor).toBe('wait')
  })

  it('keeps the pending notice clear of the quoted selection', () => {
    // runSide() 每次都先弹 pending 提示，不是错误路径专属：提示条一旦落在选区上，
    // 每次点「更多详情」都会盖住这条消息正在说的那段原文。
    const restore = measureToolbar({ width: 200, height: 64 })
    try {
      const captured = selection()
      render(<SelectionToolbar
        controller={controllerWith(captured)}
        onAdd={() => ({ ok: true })}
        sideChat={sideChat(neverSettles())}
        t={t}
      />)
      fireEvent.click(screen.getByRole('button', { name: 'selection.moreDetails' }))
      expect(screen.getByRole('status').textContent).toBe('selection.side.pending')
      expect(toolbarBox(64).bottom).toBeLessThanOrEqual(captured.rect.y)
      // 控件行贴着选区，提示条堆在它更上方。
      const group = screen.getByRole('group')
      const status = screen.getByRole('status')
      expect(Number(group.style.order)).toBeGreaterThan(Number(status.style.order))
    } finally {
      restore()
    }
  })

  it('flips the whole overlay below the selection when it cannot fit above', () => {
    const restore = measureToolbar({ width: 200, height: 120 })
    try {
      const captured = selection()
      render(<SelectionToolbar
        controller={controllerWith(captured)}
        onAdd={() => ({ ok: false, message: 'stale selection' })}
        t={t}
      />)
      fireEvent.click(screen.getByRole('button', { name: 'selection.add' }))
      expect(toolbarBox(120).top).toBeGreaterThanOrEqual(captured.rect.y + captured.rect.height)
    } finally {
      restore()
    }
  })

  it('renders nothing without a valid selection', () => {
    render(<SelectionToolbar controller={controllerWith(null)} onAdd={() => ({ ok: true })} t={t} />)
    expect(screen.queryByRole('group')).toBeNull()
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
    expect(screen.getByRole('group')).toBeTruthy()
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
    expect(screen.getByRole('group')).toBeTruthy()
  })

  it('rewrites every border/padding longhand on each alert<->status round trip, leaving no shorthand residue', async () => {
    // 复现路径与复核者一致：点「更多详情」→ 被拒绝（alert）→ 再点一次（pending 是
    // status）→ 再次被拒绝（alert）。alert/status 两种提示条共用同一个 DOM 节点
    // （同一棵树里 notice !== null 的那个 <div>，只是 role/文案变了），如果哪个
    // longhand 只在某一种状态的 style 对象里出现，就会在状态切回时被 React 清空、
    // 掉回浏览器初始值——这条测试逐帧断言四条边框和四个内边距，钉住不残留。
    const stale = (): SideChatResult => ({
      kind: 'stale-selection', action: 'more-details',
      status: { code: 'selection-stale', level: 'error', action: 'more-details' },
    })
    let resolveFirst: ((result: SideChatResult) => void) | undefined
    let resolveSecond: ((result: SideChatResult) => void) | undefined
    const moreDetails = vi.fn<SideChatActions['moreDetails']>()
      .mockImplementationOnce(() => new Promise<SideChatResult>((done) => { resolveFirst = done }))
      .mockImplementationOnce(() => new Promise<SideChatResult>((done) => { resolveSecond = done }))
    render(<SelectionToolbar
      controller={controllerWith(selection())}
      onAdd={() => ({ ok: true })}
      sideChat={sideChat(moreDetails)}
      t={t}
    />)
    const button = screen.getByRole('button', { name: 'selection.moreDetails' })

    const assertStatus = () => {
      const el = screen.getByRole('status') as HTMLElement
      expect(el.style.borderTopWidth).toBe('1px')
      expect(el.style.borderTopColor).toBe('var(--dsw-alias-border-inverted, transparent)')
      expect(el.style.borderLeftWidth).toBe('1px')
      expect(el.style.borderLeftColor).toBe('var(--dsw-alias-border-inverted, transparent)')
      expect(el.style.paddingTop).toBe('4px')
      expect(el.style.paddingLeft).toBe('8px')
    }
    const assertAlert = () => {
      const el = screen.getByRole('alert') as HTMLElement
      expect(el.style.borderTopWidth).toBe('1px')
      expect(el.style.borderTopColor).toBe('var(--dsw-alias-border-inverted, transparent)')
      expect(el.style.borderLeftWidth).toBe('3px')
      expect(el.style.borderLeftColor).toBe('var(--dsw-alias-state-error-primary, #ec1313)')
      expect(el.style.paddingTop).toBe('4px')
      expect(el.style.paddingLeft).toBe('6px')
    }

    fireEvent.click(button) // pending -> status
    assertStatus()
    await act(async () => { resolveFirst?.(stale()) }) // -> alert
    assertAlert()

    fireEvent.click(button) // pending again, same DOM node -> status
    assertStatus()
    await act(async () => { resolveSecond?.(stale()) }) // -> alert again
    assertAlert()
  })
})

describe('placeSelectionToolbar', () => {
  const rects = [
    { x: 100, y: 80, width: 20, height: 10 },
    { x: 0, y: 0, width: 400, height: 24 }, // 选区顶到视口上沿
    { x: 900, y: 12, width: 200, height: 40 }, // 上方只剩一点空间
    { x: 500, y: 700, width: 10, height: 300 }, // 很高的选区
    { x: 40, y: -30, width: 60, height: 80 }, // 上半截滚出视口
  ]
  const sizes = [
    { width: 0, height: 38 }, // 首帧还没量到尺寸
    { width: 200, height: 38 }, // 只有控件行
    { width: 320, height: 96 }, // 控件行 + 提示条
  ]

  // height: 0 = 视口高度未知，等同旧签名里根本没有这个参数——这两条测试只钉
  // 「上/下翻转」和「左右钳制」两件事，不掺垂直钳制，所以显式关掉它。
  const noVerticalClamp = { width: 1024, height: 0 }

  it('never lets the overlay box overlap the selection rect', () => {
    for (const rect of rects) {
      for (const size of sizes) {
        const place = placeSelectionToolbar(rect, size, noVerticalClamp)
        const clear = place.top + size.height <= rect.y || place.top >= rect.y + rect.height
        expect({ rect, size, top: place.top, clear }).toMatchObject({ clear: true })
      }
    }
  })

  it('clamps the overlay inside the viewport while it still fits', () => {
    for (const rect of rects) {
      for (const size of sizes.filter((item) => item.width > 0)) {
        const { left } = placeSelectionToolbar(rect, size, noVerticalClamp)
        const box = { rect, size, start: left - size.width / 2, end: left + size.width / 2 }
        expect({ ...box, inside: box.start >= 8 && box.end <= 1024 - 8 })
          .toMatchObject({ inside: true })
      }
    }
  })

  function anyPixelVisible(top: number, height: number, viewportHeight: number): boolean {
    return top < viewportHeight && top + height > 0
  }

  it('keeps the overlay at least partially visible even when the selection leaves no room above or below', () => {
    const viewport = { width: 1024, height: 900 }
    // 复核者用真实高度复现:选区顶部滚出视口上沿、底部也超出视口下沿
    // （y:-200 到 y:1200，比 900 的视口还高），上方塞不下会翻到下方，但下翻的
    // 落点只由 rect 算、不看视口高度，于是整块（top=1208..1246）跑到 900px
    // 视口外——用户根本看不到工具条。这里用两组尺寸复现同一个 rect（首帧未量到
    // 宽度 / 只有控件行两种 size，对应复核者观察到的两组结果），修复后必须
    // anyPixelVisible === true。
    const overflowing = { x: 0, y: -200, width: 800, height: 1400 }
    for (const size of [sizes[0]!, sizes[1]!]) {
      const place = placeSelectionToolbar(overflowing, size, viewport)
      const visible = anyPixelVisible(place.top, size.height, viewport.height)
      expect({ size, top: place.top, visible }).toMatchObject({ visible: true })
    }
  })

  it('still clears the selection when both above and below fit inside the viewport', () => {
    // 视口够大、选区不极端时，可见性钳制不应该重新引入遮挡——这条测试和上面
    // 那条一起画出优先级的边界：只有「选区把视口塞满」这种冲突场景才该退让。
    const viewport = { width: 1024, height: 900 }
    for (const rect of rects) {
      for (const size of sizes) {
        const place = placeSelectionToolbar(rect, size, viewport)
        const clear = place.top + size.height <= rect.y || place.top >= rect.y + rect.height
        expect({ rect, size, top: place.top, clear }).toMatchObject({ clear: true })
      }
    }
  })
})

/* ── 引用区 / 就地高亮 ─────────────────────────────────────────────────────
   这一组测试用真实 t()（zhTranslate），因为新的可访问名带插值：三个长得一样的
   评论框只有插值后才互相区分，用 key-only 的 t() 会撞名，测不出身份。 */

/** jsdom 里 `Range.getClientRects` 根本不存在（覆盖层矩形方案在这一点上并无
 * 可测性优势），所以要自己装一个：按 range 的文本回放预设矩形，好让不同引用
 * 落在可见带内 / 外。 */
const rangeRects = new Map<string, Array<{ top: number; bottom: number }>>()

function installRangeRects() {
  ;(Range.prototype as unknown as { getClientRects?: unknown }).getClientRects = function (this: Range) {
    return (rangeRects.get(this.toString()) ?? []) as unknown as DOMRectList
  }
}

function uninstallRangeRects() {
  rangeRects.clear()
  delete (Range.prototype as unknown as { getClientRects?: unknown }).getClientRects
}

function domRect(top: number, bottom: number, right: number): DOMRect {
  return { top, bottom, right, left: 0, x: 0, y: top, width: right, height: bottom - top, toJSON: () => ({}) } as DOMRect
}

/** 一套最小但完整的宿主对话 DOM：pane → scrollport → flow → business rows。
 * 行的 anchorKey 与 flowKey **故意不同**（`anchor-x` vs `x`），因为引用身份用的
 * 是 flowKey —— 混用 findAnchor 会解析到别的行，这里保证测试能看见那个差别。 */
function mountConversation(
  sessionId: string,
  rows: ReadonlyArray<{ nodeKey: string; text: string; kind?: string }>,
  options: { readonly paneMarker?: boolean } = {},
) {
  const pane = document.createElement('section')
  if (options.paneMarker !== false) pane.dataset.sessionPane = sessionId
  const scrollport = document.createElement('div')
  scrollport.setAttribute('data-conversation-scroll', '')
  const flow = document.createElement('div')
  flow.dataset.chatFlow = ''
  const elements = new Map<string, HTMLElement>()
  for (const row of rows) {
    const el = document.createElement('article')
    el.dataset.chatAnchorKey = `anchor-${row.nodeKey}`
    el.dataset.chatFlowKey = row.nodeKey
    el.dataset.chatFlowKind = row.kind ?? 'user'
    el.appendChild(document.createTextNode(row.text))
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(domRect(0, 40, 700))
    flow.appendChild(el)
    elements.set(row.nodeKey, el)
  }
  scrollport.appendChild(flow)
  pane.appendChild(scrollport)
  document.body.appendChild(pane)
  // 可见带 = [100, 600)，右缘 800（jsdom 里 offsetWidth/clientWidth 都是 0，滚动条槽为 0）。
  vi.spyOn(scrollport, 'getBoundingClientRect').mockReturnValue(domRect(100, 600, 800))
  return { pane, scrollport, flow, elements }
}

function aggregateOf(items: SelectionAggregateV1['items']): SelectionAggregateV1 {
  return { version: SELECTION_AGGREGATE_VERSION, items }
}

function snapshotOf(aggregate: SelectionAggregateV1) {
  return {
    draft: 'Selected context ', draftRev: 1,
    occurrences: [{ source: SELECTION_REFERENCE_SOURCE, ref: encodeSelectionAggregate(aggregate), offset: 0, length: 16 }],
  }
}

/** 记录每次 publish 的 registry 假体：断言"发布了哪几条 Range"不需要浏览器。 */
function recordingRegistry() {
  const published: Array<{
    ownerId: string; ranges: number; active: number; tinted: number
    activeTexts: string[]; texts: string[]; tintedTexts: string[]; objects: readonly Range[]
  }> = []
  const withdrawn: string[] = []
  return {
    published,
    withdrawn,
    registry: {
      publish: (
        ownerId: string,
        publication: { ranges: readonly Range[]; active: readonly Range[]; tinted: readonly Range[] },
      ) => {
        published.push({
          ownerId,
          ranges: publication.ranges.length,
          active: publication.active.length,
          tinted: publication.tinted.length,
          activeTexts: publication.active.map((range) => range.toString()),
          texts: publication.ranges.map((range) => range.toString()),
          tintedTexts: publication.tinted.map((range) => range.toString()),
          objects: publication.ranges,
        })
      },
      withdraw: (ownerId: string) => { withdrawn.push(ownerId) },
      get size() { return 1 },
    } satisfies QuoteHighlightRegistry,
  }
}

function renderDock(
  aggregate: SelectionAggregateV1,
  overrides: {
    sessionId?: string
    updateComment?: (itemId: string, comment: string) => SelectionMutationResult
    removeItem?: (itemId: string) => SelectionMutationResult
    highlights?: QuoteHighlightRegistry
  } = {},
) {
  const sessionId = overrides.sessionId ?? 's'
  return render(<SelectionDock
    sessionId={sessionId}
    session={{ sessionId }}
    input={snapshotOf(aggregate)}
    updateComment={overrides.updateComment ?? vi.fn(() => ({ ok: true as const, aggregate }))}
    removeItem={overrides.removeItem ?? vi.fn(() => ({ ok: true as const, aggregate }))}
    highlights={overrides.highlights}
    t={zhTranslate}
  />)
}

const twoItems = aggregateOf([
  { id: 'one', parentSessionId: 's', nodeKey: 'n1', nodeKind: 'user', atSeq: 1, text: 'first', startOffset: 0, endOffset: 5 },
  { id: 'two', parentSessionId: 's', nodeKey: 'n2', nodeKind: 'user', atSeq: 2, text: 'second', startOffset: 0, endOffset: 6 },
])

describe('SelectionDock', () => {
  afterEach(() => {
    // cleanup() 必须先跑：徽标 / 胶囊 / 卡片图层都 portal 在 document.body 上，
    // 先 innerHTML='' 会把 React 还持有的 portal 节点抽走，随后的卸载就抛
    // NotFoundError。文件级的 afterEach(cleanup) 在这之后跑，重复调用是幂等的。
    cleanup()
    uninstallRangeRects()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  /** 打开第 n 条引用的卡片：走 chip → 引用列表 → 该行「编辑」。这条路径在**任何**
   * 锚点状态下都存在，所以状态机测试全部走它，不依赖正文徽标画没画出来。 */
  function openChipList() {
    fireEvent.click(screen.getByRole('button', { name: /^查看 \d+ 条引用$/ }))
  }

  /** 「编辑」按钮的可访问名现在是 aria-labelledby 拼出来的三段（动作 + 摘要 +
   * 评论），所以按前缀匹配。全名由专门那条测试逐字断言。 */
  function editRow(ordinal: string): HTMLElement {
    return screen.getByRole('button', { name: new RegExp(`^编辑第 ${ordinal} 条引用的评论 `) })
  }

  function openCard(ordinal: string) {
    openChipList()
    fireEvent.click(editRow(ordinal))
  }

  function card(): HTMLElement {
    return screen.getByRole('dialog')
  }

  function commentBox(name: string): HTMLTextAreaElement {
    return screen.getByLabelText(name) as HTMLTextAreaElement
  }

  it('replaces the row list with one chip that carries the count', () => {
    renderDock(twoItems)
    const chip = screen.getByRole('button', { name: '查看 2 条引用' })
    expect(chip.textContent).toBe(zh['selection.chip.label'].replace('{count}', '2'))
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    // 行列表没了：composer 上方不再有任何评论输入框。
    expect(document.querySelector('[data-dsh-selection-dock-row]')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    // 原文也不再作为可见文本重复渲染。
    expect(screen.getByLabelText('选区引用（2 条）').textContent).not.toContain('first')
  })

  it('lists every quote behind the chip, whatever the anchor state is', () => {
    // 列表的数据源是 aggregate（草稿里的 JSON），不是 DOM —— 这是"原文滚出视口
    // 之后仍能够到它"的**唯一保证路径**。这里两条引用都是 detached（没挂宿主
    // DOM），正文侧一个徽标都没有，列表照样两行。
    renderDock(twoItems)
    expect(document.querySelectorAll('[data-dsh-quote-badge-anchor]').length).toBe(0)
    openChipList()
    const rows = document.querySelectorAll('[data-dsh-quote-list-row]')
    expect(rows.length).toBe(2)
    expect(editRow('1')).toBeTruthy()
    // 删除入口不依赖锚点活着。
    expect(screen.getByRole('button', { name: '删除引用 2：second' })).toBeTruthy()
    // 摘要 + 评论摘要在行里可见；没有评论时说"未添加评论"，不留空。
    expect(rows[0]!.textContent).toContain('first')
    expect(rows[0]!.textContent).toContain(zh['selection.comment.empty'])
    // 四态说明走 aria-describedby，绝不设 aria-live。
    const state = document.getElementById('dsh-quote-state-one')!
    expect(state.textContent).toBe(zh['selection.anchor.detached'])
    expect(state.getAttribute('aria-live')).toBeNull()
  })

  /* ── 草稿不能丢：三条核心状态机测试 ─────────────────────────────────── */

  it('NEVER writes the draft when the user presses Cancel, and rolls back to the last saved value', () => {
    // 杀法：把卡片级 focusout 判据换回 textarea 自己的 onBlur —— 鼠标按在「取消」
    // 上会**先**让 textarea blur，于是"先提交再回退"，两次写 aggregate；第二次
    // 撞上 CAS stale-draft 时不想要的文字就永久留在了草稿里。
    const updateComment = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    renderDock(twoItems, { updateComment })
    openCard('1')
    const box = commentBox('对引用 1 的评论：first')
    fireEvent.change(box, { target: { value: '不该被保存' } })
    const cancel = screen.getByRole('button', { name: '取消编辑第 1 条引用的评论' })
    // 真实的事件顺序：指针按下 → textarea 失焦（relatedTarget 是取消按钮）→ click。
    fireEvent.pointerDown(cancel)
    fireEvent.focusOut(box, { relatedTarget: cancel })
    fireEvent.click(cancel)
    expect(updateComment).not.toHaveBeenCalled()
    // 卡片收起成胶囊；重新展开时回到上次保存值（空串），不是那段被丢弃的文字。
    expect(screen.queryByRole('dialog')).toBeNull()
    openCard('1')
    expect(commentBox('对引用 1 的评论：first').value).toBe('')
  })

  it('saves the draft when focus leaves the whole card (Tab out), exactly once', () => {
    const updateComment = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    renderDock(twoItems, { updateComment })
    openCard('1')
    const box = commentBox('对引用 1 的评论：first')
    fireEvent.change(box, { target: { value: '要保存的评论' } })
    // Tab 出整张卡片：relatedTarget 是卡片外的元素。
    const chip = screen.getByRole('button', { name: '查看 2 条引用' })
    fireEvent.focusOut(box, { relatedTarget: chip })
    expect(updateComment).toHaveBeenCalledTimes(1)
    expect(updateComment).toHaveBeenCalledWith('one', '要保存的评论')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does nothing when relatedTarget is null (window blur), and saves on an outside pointerdown instead', () => {
    // relatedTarget === null 一律不动作：窗口失焦、点到不可聚焦的空白都会给 null。
    // 真正的"点了外面"由独立的 capture 阶段 pointerdown 负责 —— 它同样走保存。
    const updateComment = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    renderDock(twoItems, { updateComment })
    openCard('1')
    const box = commentBox('对引用 1 的评论：first')
    fireEvent.change(box, { target: { value: '窗口失焦时还在打的字' } })
    fireEvent.focusOut(box, { relatedTarget: null })
    expect(updateComment).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(updateComment).toHaveBeenCalledTimes(1)
    expect(updateComment).toHaveBeenCalledWith('one', '窗口失焦时还在打的字')
  })

  it('keeps the card open WITH the text when the aggregate write loses the CAS race', () => {
    // updateSelectionComment 会返回 {ok:false, reason:'stale-draft'}。旧代码只
    // notify 一声就算完，用户打的字随着输入框一起消失。卡片必须留在原地、留住
    // 文字，并把错误显示在自己身上。
    const updateComment = vi.fn(() => ({ ok: false as const, reason: 'stale-draft' as const }))
    renderDock(twoItems, { updateComment })
    openCard('1')
    const box = commentBox('对引用 1 的评论：first')
    fireEvent.change(box, { target: { value: '珍贵的草稿' } })
    fireEvent.pointerDown(document.body)
    expect(updateComment).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeNull()
    expect(commentBox('对引用 1 的评论：first').value).toBe('珍贵的草稿')
    expect(screen.getByRole('alert').textContent).toBe(zh['selection.error.draftChanged'])
  })

  it('treats Esc as save-and-collapse, and stops it from reaching the host', () => {
    const updateComment = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    const hostEscape = vi.fn()
    document.addEventListener('keydown', hostEscape)
    try {
      renderDock(twoItems, { updateComment })
      openCard('1')
      const box = commentBox('对引用 1 的评论：first')
      fireEvent.change(box, { target: { value: 'esc 不该销毁我打的字' } })
      fireEvent.keyDown(box, { key: 'Escape' })
      expect(updateComment).toHaveBeenCalledWith('one', 'esc 不该销毁我打的字')
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(hostEscape).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', hostEscape)
    }
  })

  it('commits a pending draft on unmount instead of dropping it', () => {
    const updateComment = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    const view = renderDock(twoItems, { updateComment })
    openCard('1')
    fireEvent.change(commentBox('对引用 1 的评论：first'), { target: { value: '关 Pane 前打的字' } })
    view.unmount()
    expect(updateComment).toHaveBeenCalledWith('one', '关 Pane 前打的字')
  })

  it('keeps Enter as a newline and reserves the chord for saving', () => {
    const updateComment = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    renderDock(twoItems, { updateComment })
    openCard('1')
    const box = commentBox('对引用 1 的评论：first')
    fireEvent.change(box, { target: { value: '第一行' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(updateComment).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    expect(updateComment).toHaveBeenCalledWith('one', '第一行')
  })

  it('weakens Save only while there is genuinely nothing to store, and keeps it tabbable', () => {
    const updateComment = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    renderDock(twoItems, { updateComment })
    openCard('1')
    const save = screen.getByRole('button', { name: '保存第 1 条引用的评论' })
    // aria-disabled 而不是 disabled：保持可 Tab 到，屏读能听到禁用的原因。
    expect(save.getAttribute('aria-disabled')).toBe('true')
    expect((save as HTMLButtonElement).disabled).toBe(false)
    expect(document.getElementById(save.getAttribute('aria-describedby')!)!.textContent)
      .toBe(zh['selection.comment.saveEmpty'])
    expect(save.style.cursor).toBe('not-allowed')
    fireEvent.click(save)
    expect(updateComment).not.toHaveBeenCalled()
    fireEvent.change(commentBox('对引用 1 的评论：first'), { target: { value: '有内容了' } })
    const enabled = screen.getByRole('button', { name: '保存第 1 条引用的评论' })
    expect(enabled.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(enabled)
    expect(updateComment).toHaveBeenCalledWith('one', '有内容了')
  })

  it('keeps Save usable when the user clears a comment they had already stored', () => {
    // 「草稿为空 = 禁用」若写成无条件判据，用户就再也没有显式入口去删掉一条
    // 已保存的评论。
    const withComment = aggregateOf([{ ...twoItems.items[0]!, comment: '旧评论' }])
    const updateComment = vi.fn(() => ({ ok: true as const, aggregate: withComment }))
    renderDock(withComment, { updateComment })
    openCard('1')
    const box = commentBox('对引用 1 的评论：first')
    expect(box.value).toBe('旧评论')
    fireEvent.change(box, { target: { value: '' } })
    const save = screen.getByRole('button', { name: '保存第 1 条引用的评论' })
    expect(save.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(save)
    expect(updateComment).toHaveBeenCalledWith('one', '')
  })

  it('saves the previous card exactly once when the user switches quotes', () => {
    // 「切换到另一条」这条路径上，保存**只能**由卡片自己的 capture 阶段
    // pointerdown 负责，openCard 不许再补一次。
    //
    // 杀法：在 openCard 里加回那段兜底
    //   `if (ui.kind === 'card' && ui.itemId !== itemId && ui.draft !== ui.baseline)
    //      updateComment(ui.itemId, ui.draft)`
    // —— 它不可达（pointerdown 已经把 ui 变成 capsule 了），可一旦可达就会写第二
    // 次：setUi 换掉 itemId → 卡片 key 变化 → 旧卡片卸载 → 卸载清理里 settled 仍
    // 是 false、draft !== baseline 仍成立 → 第二次 commit，且那个闭包成功后会
    // setUi({kind:'capsule', itemId:'one'})，把刚打开的第 2 张卡片打回第 1 条的胶囊。
    // 所以这条测试同时钉住"只写一次"和"落在第 2 条上"。
    const updateComment = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    renderDock(twoItems, { updateComment })
    openCard('1')
    fireEvent.change(commentBox('对引用 1 的评论：first'), { target: { value: '第一条的评论' } })

    // 真实事件顺序：chip 上的 pointerdown（卡片外，capture 先跑）→ click 开列表
    // → 点第 2 行的「编辑」。
    const chip = screen.getByRole('button', { name: '查看 2 条引用' })
    fireEvent.pointerDown(chip)
    expect(updateComment).toHaveBeenCalledTimes(1)
    expect(updateComment).toHaveBeenCalledWith('one', '第一条的评论')

    fireEvent.click(chip)
    fireEvent.click(editRow('2'))

    // 第 1 条一共只被写了一次；打开的确实是第 2 条，且带的是它自己的空基线。
    expect(updateComment).toHaveBeenCalledTimes(1)
    const second = commentBox('对引用 2 的评论：second')
    expect(second.value).toBe('')
    expect(card().getAttribute('aria-label')).toBe('第 2 条引用的评论：second')
  })

  /* ── 可达性闭包 ─────────────────────────────────────────────────────── */

  it('reaches a detached quote through the chip when the body draws no badge at all', () => {
    // 行没了 → 正文侧无徽标 → chip 列表仍有该行 → 激活后卡片打开（锚在 chip
    // 上方）、焦点在 textarea。detached 时不 reveal（没有可滚的行），「跳到原文」
    // 也随之禁用。
    renderDock(twoItems)
    expect(document.querySelectorAll('[data-dsh-quote-badge-anchor]').length).toBe(0)
    openCard('1')
    const dialog = card()
    expect(dialog.getAttribute('aria-label')).toBe('第 1 条引用的评论：first')
    expect(document.activeElement).toBe(commentBox('对引用 1 的评论：first'))
    expect(screen.getByRole('button', { name: '跳到引用 1 的原文' }).getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(commentBox('对引用 1 的评论：first').getAttribute('aria-describedby')!)!.textContent)
      .toBe(zh['selection.anchor.detached'])
  })

  it('scrolls an off-screen quote back into view when its list row is activated', async () => {
    installRangeRects()
    // 可见带是 [100, 600)；这一条的末行整个在带子上方。
    rangeRects.set('first', [{ top: 20, bottom: 36 }])
    const { elements } = mountConversation('s', [{ nodeKey: 'n1', text: 'first' }])
    const scrollIntoView = vi.fn()
    elements.get('n1')!.scrollIntoView = scrollIntoView
    renderDock(aggregateOf([twoItems.items[0]!]))
    // 正文侧不画徽标（末行滚出了可见带），但 chip 列表照样有这一行。
    expect(document.querySelectorAll('[data-dsh-quote-badge-anchor]').length).toBe(0)
    openChipList()
    expect(document.getElementById('dsh-quote-state-one')!.textContent).toBe(zh['selection.anchor.offscreen'])
    fireEvent.click(editRow('1'))
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(document.activeElement).toBe(commentBox('对引用 1 的评论：first'))
  })

  it('returns focus to the chip when the list is dismissed with Esc', () => {
    renderDock(twoItems)
    openChipList()
    expect(document.activeElement).toBe(editRow('1'))
    fireEvent.keyDown(screen.getByRole('group', { name: zh['selection.list.label'] }), { key: 'Escape' })
    expect(screen.queryByRole('group', { name: zh['selection.list.label'] })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '查看 2 条引用' }))
  })

  it('removes a quote from the list without needing a live anchor', () => {
    const removeItem = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    renderDock(twoItems, { removeItem })
    openChipList()
    const x = screen.getByRole('button', { name: '删除引用 2：second' })
    // 第一次只是上膛（见 useArmedDelete），第二次才真删。
    fireEvent.click(x)
    expect(removeItem).not.toHaveBeenCalled()
    fireEvent.click(x)
    expect(removeItem).toHaveBeenCalledWith('two')
    expect(document.querySelector('[data-dsh-quote-announce]')!.textContent)
      .toBe('已删除引用 2')
  })

  /* ── 性能护栏（守住上一轮的成果） ──────────────────────────────────── */

  it('does not re-resolve a single range while the user types into the card', async () => {
    // 卡片 portal 在 document.body：打字产生的 characterData 结构上不可能落进
    // 任何已锚定行，`quoteMutationsMatter` 那道闸门连一个 tick 都不会排。
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    mountConversation('s', [{ nodeKey: 'n1', text: 'first' }])
    const recorder = recordingRegistry()
    renderDock(aggregateOf([twoItems.items[0]!]), { highlights: recorder.registry })
    openCard('1')
    const before = recorder.published[recorder.published.length - 1]!.objects[0]!
    const box = commentBox('对引用 1 的评论：first')
    for (let index = 0; index < 30; index += 1) {
      fireEvent.change(box, { target: { value: 'x'.repeat(index + 1) } })
    }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
    // 同一个 Range 对象 = 一次重解析都没发生。
    expect(recorder.published[recorder.published.length - 1]!.objects[0]).toBe(before)
    expect(commentBox('对引用 1 的评论：first').value).toBe('x'.repeat(30))
  })

  it('publishes all three highlight entries once and leaves them alone across scroll frames', async () => {
    // 底色分流把 publication 从 2 个数组变成 3 个。子 Range 必须在**解析期**一次
    // 造好并存进 ResolvedQuote —— 在测量帧里现造的话对象身份每帧都变，滚动时
    // 又回到每帧一次 new Highlight()。
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    const { scrollport } = mountConversation('s', [{ nodeKey: 'n1', text: 'first' }])
    const recorder = recordingRegistry()
    renderDock(aggregateOf([twoItems.items[0]!]), { highlights: recorder.registry })
    const first = recorder.published[recorder.published.length - 1]!
    expect(first.ranges).toBe(1)
    expect(first.tinted).toBe(1)
    const publishes = recorder.published.length
    for (let frame = 0; frame < 30; frame += 1) {
      await act(async () => {
        scrollport.dispatchEvent(new Event('scroll'))
        await new Promise((resolve) => setTimeout(resolve, 2))
      })
    }
    expect(recorder.published.length).toBe(publishes)
  })

  it('re-measures the badge on scroll without re-resolving the range', async () => {
    // 设计里最贵的一条约束：滚动**只**重算徽标矩形。"同一个 Range 对象"是这件事
    // 唯一能从外面观测到的证据。
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    const { scrollport } = mountConversation('s', [{ nodeKey: 'n1', text: 'first' }])
    const recorder = recordingRegistry()
    renderDock(aggregateOf([twoItems.items[0]!]), { highlights: recorder.registry })
    const before = recorder.published[recorder.published.length - 1]!.objects[0]!
    expect(document.querySelector<HTMLElement>('[data-dsh-quote-badge-anchor]')!.style.top).toBe('200px')

    rangeRects.set('first', [{ top: 100, bottom: 116 }])
    await act(async () => {
      scrollport.dispatchEvent(new Event('scroll'))
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    const after = recorder.published[recorder.published.length - 1]!
    expect(document.querySelector<HTMLElement>('[data-dsh-quote-badge-anchor]')!.style.top).toBe('100px')
    expect(after.objects[0]).toBe(before)
  })

  /* ── 既有不变量（图层身份、pane 闸门、观察器纪律） ───────────────── */

  it('numbers badges by aggregate array index, never by document position', () => {
    installRangeRects()
    rangeRects.set('first', [{ top: 300, bottom: 316 }])
    rangeRects.set('second', [{ top: 200, bottom: 216 }])
    mountConversation('s', [{ nodeKey: 'n2', text: 'second' }, { nodeKey: 'n1', text: 'first' }])
    renderDock(twoItems)
    const overlay = document.querySelectorAll<HTMLElement>('[data-dsh-quote-badge-anchor]')
    expect(Array.from(overlay, (node) => node.dataset.dshQuoteBadgeAnchor)).toEqual(['one', 'two'])
    expect(Array.from(overlay, (node) => node.textContent)).toEqual(['1', '2'])
    expect(Array.from(overlay, (node) => node.style.top)).toEqual(['300px', '200px'])
  })

  it('publishes one range per resolved quote and withdraws them on unmount', () => {
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    rangeRects.set('second', [{ top: 300, bottom: 316 }])
    mountConversation('s', [{ nodeKey: 'n1', text: 'first' }, { nodeKey: 'n2', text: 'second' }])
    const recorder = recordingRegistry()
    const view = renderDock(twoItems, { highlights: recorder.registry })
    const last = recorder.published[recorder.published.length - 1]!
    expect(last.ranges).toBe(2)
    expect(last.texts).toEqual(['first', 'second'])
    expect(last.active).toBe(0)
    view.unmount()
    expect(recorder.withdrawn).toContain(last.ownerId)
  })

  it('never publishes a quote whose row is gone, without revoking the reference', () => {
    const recorder = recordingRegistry()
    renderDock(twoItems, { highlights: recorder.registry })
    expect(recorder.published[recorder.published.length - 1]!.ranges).toBe(0)
    expect(document.querySelectorAll('[data-dsh-quote-badge-anchor]').length).toBe(0)
    // 引用本身不失效：chip 仍报 2 条，列表里两行都能编辑能删除。
    expect(screen.getByRole('button', { name: '查看 2 条引用' })).toBeTruthy()
    openChipList()
    expect(screen.getByRole('button', { name: '删除引用 1：first' })).toBeTruthy()
    expect(document.querySelector('[data-dsh-quote-badge="detached"]')).toBeTruthy()
  })

  it('keeps the colour band but hides the overlay badge for a quote scrolled out of the band', () => {
    installRangeRects()
    rangeRects.set('first', [{ top: 20, bottom: 36 }])
    rangeRects.set('second', [{ top: 300, bottom: 316 }])
    mountConversation('s', [{ nodeKey: 'n1', text: 'first' }, { nodeKey: 'n2', text: 'second' }])
    const recorder = recordingRegistry()
    renderDock(twoItems, { highlights: recorder.registry })
    expect(recorder.published[recorder.published.length - 1]!.ranges).toBe(2)
    const anchors = Array.from(
      document.querySelectorAll<HTMLElement>('[data-dsh-quote-badge-anchor]'),
      (node) => node.dataset.dshQuoteBadgeAnchor,
    )
    expect(anchors).toEqual(['two'])
  })

  it('refuses to anchor a quote that belongs to another pane', () => {
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    mountConversation('other', [{ nodeKey: 'n1', text: 'first' }])
    const recorder = recordingRegistry()
    render(<SelectionDock
      sessionId="other"
      session={{ sessionId: 'other' }}
      input={snapshotOf(aggregateOf([twoItems.items[0]!]))}
      updateComment={vi.fn(() => ({ ok: true as const, aggregate: twoItems }))}
      removeItem={vi.fn(() => ({ ok: true as const, aggregate: twoItems }))}
      highlights={recorder.registry}
      t={zhTranslate}
    />)
    expect(recorder.published[recorder.published.length - 1]!.ranges).toBe(0)
  })

  it('still refuses a foreign-session quote on a host with no pane markers at all', () => {
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    mountConversation('other', [{ nodeKey: 'n1', text: 'first' }], { paneMarker: false })
    const recorder = recordingRegistry()
    render(<SelectionDock
      sessionId="other"
      session={{ sessionId: 'other' }}
      input={snapshotOf(aggregateOf([twoItems.items[0]!]))}
      updateComment={vi.fn(() => ({ ok: true as const, aggregate: twoItems }))}
      removeItem={vi.fn(() => ({ ok: true as const, aggregate: twoItems }))}
      highlights={recorder.registry}
      t={zhTranslate}
    />)
    expect(recorder.published[recorder.published.length - 1]!.ranges).toBe(0)
    expect(document.querySelectorAll('[data-dsh-quote-badge-anchor]').length).toBe(0)
  })

  it('re-resolves after the host swaps the quoted row text node', async () => {
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    const { elements } = mountConversation('s', [{ nodeKey: 'n1', text: 'first' }])
    const recorder = recordingRegistry()
    renderDock(aggregateOf([twoItems.items[0]!]), { highlights: recorder.registry })
    const before = recorder.published[recorder.published.length - 1]!.objects[0]!
    expect(before.collapsed).toBe(false)

    const row = elements.get('n1')!
    await act(async () => {
      row.replaceChild(document.createTextNode('first'), row.firstChild!)
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    expect(before.startContainer.isConnected).toBe(true)
    expect(before.collapsed).toBe(true)
    const after = recorder.published[recorder.published.length - 1]!
    expect(after.ranges).toBe(1)
    expect(after.objects[0]).not.toBe(before)
    expect(after.objects[0]!.toString()).toBe('first')
  })

  it('re-resolves on a size change (wrapping moves) but not on a plain scroll', async () => {
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    const observers: Array<() => void> = []
    class StubResizeObserver {
      constructor(callback: () => void) { observers.push(callback) }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const previous = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver
    try {
      mountConversation('s', [{ nodeKey: 'n1', text: 'first' }])
      const recorder = recordingRegistry()
      renderDock(aggregateOf([twoItems.items[0]!]), { highlights: recorder.registry })
      const before = recorder.published[recorder.published.length - 1]!.objects[0]!
      await act(async () => {
        for (const notify of observers) notify()
        await new Promise((resolve) => setTimeout(resolve, 40))
      })
      expect(recorder.published[recorder.published.length - 1]!.objects[0]).not.toBe(before)
    } finally {
      if (previous === undefined) delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
      else (globalThis as { ResizeObserver?: unknown }).ResizeObserver = previous
    }
  })

  it('reports detached rather than a stale anchor on a host with no structural observer', () => {
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    const flow = document.createElement('div')
    flow.dataset.chatFlow = ''
    const row = document.createElement('article')
    row.dataset.chatAnchorKey = 'anchor-n1'
    row.dataset.chatFlowKey = 'n1'
    row.dataset.chatFlowKind = 'user'
    row.appendChild(document.createTextNode('first'))
    flow.appendChild(row)
    document.body.appendChild(flow)

    const recorder = recordingRegistry()
    renderDock(aggregateOf([twoItems.items[0]!]), { highlights: recorder.registry })
    expect(recorder.published[recorder.published.length - 1]!.ranges).toBe(1)

    row.replaceChild(document.createTextNode('first'), row.firstChild!)
    // 只触发"测量"这一条路径（打开项变化），不触发重解析 —— 这个宿主上没有
    // 任何结构信号会来重解析，测量帧必须自己认出塌缩的 Range。
    openCard('1')
    expect(recorder.published[recorder.published.length - 1]!.ranges).toBe(0)
    expect(document.getElementById('dsh-quote-card-state-one')!.textContent)
      .toBe(zh['selection.anchor.detached'])
    // 原文没了 —— 「跳到原文」随之禁用，但引用本身照旧有效、照旧能编辑。
    expect(screen.getByRole('button', { name: '跳到引用 1 的原文' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('never observes document.body, even with no pane and no scrollport (GA-031)', () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe')
    const flow = document.createElement('div')
    flow.dataset.chatFlow = ''
    const row = document.createElement('article')
    row.dataset.chatAnchorKey = 'anchor-n1'
    row.dataset.chatFlowKey = 'n1'
    row.dataset.chatFlowKind = 'user'
    row.appendChild(document.createTextNode('first'))
    flow.appendChild(row)
    document.body.appendChild(flow)
    renderDock(aggregateOf([twoItems.items[0]!]))
    expect(observe.mock.calls.some(([target]) => target === document.body)).toBe(false)
  })

  it('emphasises the matching range while its body badge is hovered', () => {
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    rangeRects.set('second', [{ top: 300, bottom: 316 }])
    mountConversation('s', [{ nodeKey: 'n1', text: 'first' }, { nodeKey: 'n2', text: 'second' }])
    const recorder = recordingRegistry()
    renderDock(twoItems, { highlights: recorder.registry })
    const active = () => recorder.published[recorder.published.length - 1]!.activeTexts
    expect(active()).toEqual([])
    const badge = document.querySelector<HTMLElement>('[data-dsh-quote-badge-anchor="two"]')!
    fireEvent.mouseEnter(badge)
    expect(active()).toEqual(['second'])
    fireEvent.mouseLeave(badge)
    expect(active()).toEqual([])
  })

  /* ── 视觉 / 无障碍规格 ──────────────────────────────────────────────── */

  it('draws the body badge as a solid blue pill with white digits, ringed twice when emphasised', () => {
    // 旧外观是「淡底 + 深蓝字 + 单层蓝环」。参考图要的是实心蓝白字，而单层
    // #4176e6 环画在 #4868b2 徽标底上只有 1.26:1，等于没画 —— 必须双层。
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    mountConversation('s', [{ nodeKey: 'n1', text: 'first' }])
    const recorder = recordingRegistry()
    renderDock(aggregateOf([twoItems.items[0]!]), { highlights: recorder.registry })
    const anchor = document.querySelector<HTMLElement>('[data-dsh-quote-badge-anchor="one"]')!
    const badge = anchor.querySelector<HTMLElement>('[data-dsh-quote-badge]')!
    expect(badge.getAttribute('style')).toContain('background: var(--dsw-static-deepseek-600, #4868b2)')
    expect(badge.getAttribute('style')).toContain('color: var(--dsw-static-neutral-bluish-00, #fff)')
    // 静息态写同样结构但两层都透明 —— 盒子尺寸恒定，切换零布局位移。
    expect(badge.style.boxShadow).toBe('0 0 0 2px transparent, 0 0 0 4px transparent')
    fireEvent.mouseEnter(anchor)
    const hot = document.querySelector<HTMLElement>('[data-dsh-quote-badge-anchor="one"] [data-dsh-quote-badge]')!
    expect(hot.style.boxShadow)
      .toBe('0 0 0 2px var(--dsw-alias-bg-base, #fff), 0 0 0 4px var(--dsw-alias-state-business-primary, #4176e6)')
  })

  it('leaves the host conversation byte-identical across a whole quote lifecycle', async () => {
    // 本轮最硬的一条约束：**绝不 patch 宿主 DOM** —— 不写属性、不改内容、不插入
    // 或移动节点、不动 class/style。高亮只把 Range 交给浏览器（registry），徽标 /
    // 胶囊 / 卡片全是 portal 在 document.body 上的自有图层。
    //
    // 杀法：往 anchor.row 上写任何一个属性（`row.setAttribute('data-x','1')`）、
    // 或把徽标 append 进宿主行里，这条断言立刻红。
    // 这一条走的是 **anchored** 路径（不触发 reveal）；reveal 那条单独由下一条
    // 测试盯着。
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    const { pane, scrollport } = mountConversation('s', [{ nodeKey: 'n1', text: 'first' }])
    const before = pane.outerHTML

    const updateComment = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    renderDock(aggregateOf([twoItems.items[0]!]), { updateComment })
    expect(pane.outerHTML, '渲染引用图层就改了宿主').toBe(before)

    // 悬停徽标（emphasis）→ 打开卡片 → 打字 → 保存 → 滚动若干帧。
    fireEvent.mouseEnter(document.querySelector<HTMLElement>('[data-dsh-quote-badge-anchor="one"]')!)
    fireEvent.click(document.querySelector<HTMLElement>('[data-dsh-quote-badge-anchor="one"]')!)
    openCard('1')
    fireEvent.change(commentBox('对引用 1 的评论：first'), { target: { value: '一条评论' } })
    fireEvent.pointerDown(document.body)
    for (let frame = 0; frame < 3; frame += 1) {
      await act(async () => {
        scrollport.dispatchEvent(new Event('scroll'))
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
    }
    expect(updateComment).toHaveBeenCalledWith('one', '一条评论')
    expect(pane.outerHTML, '一整轮引用生命周期之后宿主被改了').toBe(before)
  })

  it('scrolls a quote back into view without writing a single host attribute', async () => {
    // reveal 是本特性里**唯一**碰得到宿主锚点的调用：`revealNode` 默认会往锚点写
    // `data-dsh-nux-reveal` 做高亮。我们自己的色带已经是视觉反馈，所以传
    // `highlight: false`。
    //
    // 杀法：把 reveal() 的 `{ highlight: false }` 改回 `true` —— 宿主行上就会多出
    // 一个 `data-dsh-nux-reveal` 属性，这条断言红。
    installRangeRects()
    rangeRects.set('first', [{ top: 20, bottom: 36 }])
    const { pane, elements } = mountConversation('s', [{ nodeKey: 'n1', text: 'first' }])
    elements.get('n1')!.scrollIntoView = vi.fn()
    const before = pane.outerHTML

    renderDock(aggregateOf([twoItems.items[0]!]))
    openChipList()
    fireEvent.click(editRow('1'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    // reveal 真的跑过了（滚回视野），而宿主一个属性都没多。
    expect(elements.get('n1')!.scrollIntoView).toHaveBeenCalled()
    expect(pane.outerHTML, 'reveal 往宿主写了属性').toBe(before)
  })

  it('keeps every portal layer clear of assistive tech except the card itself', () => {
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    mountConversation('s', [{ nodeKey: 'n1', text: 'first' }])
    renderDock(aggregateOf([twoItems.items[0]!]))
    const badges = document.querySelector<HTMLElement>('[data-dsh-quote-overlay]')!
    expect(badges.getAttribute('aria-hidden')).toBe('true')
    expect(badges.getAttribute('role')).toBe('presentation')
    // aria-hidden 容器里放可聚焦控件 = 能 Tab 到但读不出来的黑洞。
    expect(badges.querySelectorAll('button, [tabindex]').length).toBe(0)
    // 0×0 的定位盒，绝不铺满屏幕拦截宿主的指针事件；徽标降到 897（卡片之下）。
    expect(badges.style.width).toBe('0px')
    expect(badges.style.height).toBe('0px')
    expect(badges.style.zIndex).toBe('897')

    // 胶囊层同理：纯指针预览，一个可聚焦控件都没有。
    fireEvent.click(document.querySelector<HTMLElement>('[data-dsh-quote-badge-anchor="one"]')!)
    const dialog = card()
    expect(dialog.closest('[aria-hidden="true"]')).toBeNull()
    expect(dialog.getAttribute('aria-modal')).toBe('false')
    expect(dialog.style.zIndex).toBe('899')
  })

  it('lays the card out in DOM order matching the screenshot, with the trash on the left', () => {
    renderDock(twoItems)
    openCard('1')
    const names = Array.from(card().querySelectorAll('textarea, button'), (node) => (
      node.tagName === 'TEXTAREA' ? 'textarea' : node.getAttribute('aria-label')
    ))
    expect(names).toEqual([
      'textarea',
      '删除引用 1：first',
      '跳到引用 1 的原文',
      '取消编辑第 1 条引用的评论',
      '保存第 1 条引用的评论',
    ])
  })

  it('announces discrete results, and keeps the anchor states out of the live region', () => {
    const updateComment = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    renderDock(twoItems, { updateComment })
    const live = document.querySelector<HTMLElement>('[data-dsh-quote-announce]')!
    expect(live.getAttribute('role')).toBe('status')
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).toBe('')
    openCard('1')
    fireEvent.change(commentBox('对引用 1 的评论：first'), { target: { value: '存下来' } })
    fireEvent.click(screen.getByRole('button', { name: '保存第 1 条引用的评论' }))
    expect(live.textContent).toBe('已保存第 1 条引用的评论')
    // 锚点四态绝不进 live region：滚动会让 anchored ⇄ offscreen 高频翻转。
    openChipList()
    expect(document.getElementById('dsh-quote-state-one')!.getAttribute('aria-live')).toBeNull()
  })

  it('re-announces a live-region result even when the text is byte-identical to the last one', () => {
    // React 的 setState 对基础类型走 Object.is 比较：新值跟当前值逐字节相同时
    // 直接跳过这次更新，连 live region 的文本节点都不会被碰一下。连续两次保存
    // 同一条引用（编辑→保存→再编辑→再保存，很常见的操作序列）播报文字逐字节
    // 相同——第二次对屏读用户是彻底的静音，而不是"没有变化"：用户确实又保存
    // 了一次，只是这次凑巧读出来的文案和上一次一样。删除侧的"连续删除总落在
    // 同一序号上"、新增侧的"已添加引用 N，共 M 条"凑巧重复，都是同一个根因。
    // 杀法：把 announce() 换回直接 setAnnouncement(text)。
    const updateComment = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    renderDock(twoItems, { updateComment })
    const live = document.querySelector<HTMLElement>('[data-dsh-quote-announce]')!

    openCard('1')
    fireEvent.change(commentBox('对引用 1 的评论：first'), { target: { value: '第一版评论' } })
    fireEvent.click(screen.getByRole('button', { name: '保存第 1 条引用的评论' }))
    const first = live.textContent
    expect(first).toBe('已保存第 1 条引用的评论')

    // 测试替身不真的把新评论写回 items（updateComment 只是个 spy），所以重新
    // 打开第 1 条时 baseline 仍是空串——再存一次同样是"值变了 → 调
    // updateComment → 成功 → 播报"，两次播报的文案逐字节相同，且中间没有任何
    // 别的播报打断，是最干净的"连续两次相同播报"复现。
    openCard('1')
    fireEvent.change(commentBox('对引用 1 的评论：first'), { target: { value: '第二版评论' } })
    fireEvent.click(screen.getByRole('button', { name: '保存第 1 条引用的评论' }))
    const second = live.textContent

    expect(second, '连续两次相同播报之间 DOM 必须有真实变更，否则屏读不会念第二次').not.toBe(first)
    // 内容本身（去掉强制变更用的零宽字符）仍然是同一句话，不是被写坏了。
    expect(second!.replace(/​/g, '')).toBe('已保存第 1 条引用的评论')
  })

  it('floats a capsule beside a freshly added quote without stealing focus', () => {
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    rangeRects.set('second', [{ top: 300, bottom: 316 }])
    mountConversation('s', [{ nodeKey: 'n1', text: 'first' }, { nodeKey: 'n2', text: 'second' }])
    const view = renderDock(aggregateOf([twoItems.items[0]!]))
    expect(document.querySelector('[data-dsh-quote-capsule]')).toBeNull()
    view.rerender(<SelectionDock
      sessionId="s"
      session={{ sessionId: 's' }}
      input={snapshotOf(twoItems)}
      updateComment={vi.fn(() => ({ ok: true as const, aggregate: twoItems }))}
      removeItem={vi.fn(() => ({ ok: true as const, aggregate: twoItems }))}
      t={zhTranslate}
    />)
    const capsule = document.querySelector<HTMLElement>('[data-dsh-quote-capsule]')!
    expect(capsule.dataset.dshQuoteCapsule).toBe('2')
    expect(capsule.textContent).toContain(zh['selection.comment.placeholder'])
    // 不抢焦点：焦点留在 composer（这里是 body），卡片也没有展开。
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(document.body)
    expect(document.querySelector('[data-dsh-quote-announce]')!.textContent).toBe('已添加引用 2，共 2 条')
    // 胶囊层不吃焦点：aria-hidden 容器里放可聚焦控件 = 能 Tab 到但读不出来。
    const layer = document.querySelector<HTMLElement>('[data-dsh-quote-capsule-layer]')!
    expect(layer.getAttribute('aria-hidden')).toBe('true')
    expect(layer.getAttribute('role')).toBe('presentation')
    expect(layer.querySelectorAll('button, a, input, textarea, [tabindex]').length).toBe(0)
    expect(layer.style.zIndex).toBe('898')
    // 点胶囊直接展开卡片。
    fireEvent.click(capsule)
    expect(card().getAttribute('aria-label')).toBe('第 2 条引用的评论：second')
  })

  it('gives the card textarea the same focus ring the rest of the feature uses', () => {
    renderDock(twoItems)
    openCard('1')
    const box = commentBox('对引用 1 的评论：first')
    expect(box.tagName).toBe('TEXTAREA')
    // placeholder 走已注入的 [data-dsh-quote-comment]::placeholder 规则，
    // textarea 直接继承那条属性选择器，不需要新注入。
    expect(box.getAttribute('data-dsh-quote-comment')).not.toBeNull()
    expect(box.placeholder).toBe(zh['selection.comment.placeholder'])
    fireEvent.focus(box)
    expect(box.getAttribute('style')).toContain(`outline: 2px solid ${FOCUS_RING_COLOR}`)
    expect(box.style.outlineOffset).toBe('-2px')
    fireEvent.blur(box)
    expect(box.getAttribute('style')).toContain('outline: none')
    // 静息描边用 label-tertiary（浅 3.71 / 深 8.54），不是 1.25:1 的 border-l2。
    expect(box.getAttribute('style')).toContain('var(--dsw-alias-label-tertiary, #81858c)')
    expect(box.getAttribute('style')).not.toContain('var(--dsw-alias-border-l2')
  })

  it('separates the floating surfaces with a border that survives dark mode', () => {
    // SURFACE_FLOATING 的 border-inverted 深色合成后是 #414244，对页面 #151517
    // 只有 1.81:1。这三层压在正文上，边界一弱正文就糊进浮层。
    renderDock(twoItems)
    openCard('1')
    const dialog = card()
    expect(dialog.getAttribute('style')).toContain('border: 1px solid var(--dsw-alias-label-tertiary, #81858c)')
    expect(dialog.getAttribute('style')).toContain('background: var(--dsw-alias-bg-layer-3, #fff)')
    // 浅色下所有 bg-* 层都是纯白 —— 阴影和描边必须同时在。
    expect(dialog.style.boxShadow).not.toBe('')
  })

  /* ── 本轮修复 ───────────────────────────────────────────────────────── */

  /** 不经 renderDock：这一组要自己控制「草稿里连 occurrence 都还没有」这个起点。 */
  function dockProps(aggregate: SelectionAggregateV1, overrides: {
    updateComment?: (itemId: string, comment: string) => SelectionMutationResult
    removeItem?: (itemId: string) => SelectionMutationResult
  } = {}) {
    return {
      sessionId: 's',
      session: { sessionId: 's' },
      updateComment: overrides.updateComment ?? vi.fn(() => ({ ok: true as const, aggregate })),
      removeItem: overrides.removeItem ?? vi.fn(() => ({ ok: true as const, aggregate })),
      t: zhTranslate,
    }
  }

  const EMPTY_INPUT = { draft: '', draftRev: 1, occurrences: [] }

  it('floats a capsule and announces for the FIRST quote, not only from the second on', () => {
    // 杀法：把哨兵写回 `seen.current = ids.length === 0 ? null : new Set(ids)` +
    // `if (previous === null) return` —— 「0 条」与「首次渲染」编码成同一个值，
    // 0→1 这个真实的新增被整个吞掉：第一条引用没有胶囊（本轮 UI 的主入口）、
    // 也没有播报。
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    mountConversation('s', [{ nodeKey: 'n1', text: 'first' }])
    const one = aggregateOf([twoItems.items[0]!])
    const props = dockProps(one)
    // 起点：草稿里一条引用都没有，坞整个不渲染。
    const view = render(<SelectionDock {...props} input={EMPTY_INPUT} />)
    expect(document.querySelector('[data-dsh-quote-capsule]')).toBeNull()

    view.rerender(<SelectionDock {...props} input={snapshotOf(one)} />)
    const capsule = document.querySelector<HTMLElement>('[data-dsh-quote-capsule]')
    expect(capsule, '第一条引用没有浮出胶囊').not.toBeNull()
    expect(capsule!.dataset.dshQuoteCapsule).toBe('1')
    expect(document.querySelector('[data-dsh-quote-announce]')!.textContent)
      .toBe('已添加引用 1，共 1 条')
  })

  it('writes the saved comment on the capsule and only falls back to the placeholder without one', () => {
    // 本轮特性的核心目的就是「把批注标在被引段落旁边」。旧写法把 placeholder
    // 写死传进来，保存完评论后段落旁那枚胶囊仍写着「添加可选评论...」——
    // 杀法：把 comment 换回 `placeholder={t('selection.comment.placeholder')}`。
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    mountConversation('s', [{ nodeKey: 'n1', text: 'first' }])
    const note = '这段的推理跳步了，第二段和第三段之间缺一个前提'
    const commented = aggregateOf([{ ...twoItems.items[0]!, comment: note }])
    const props = dockProps(commented)
    const view = render(<SelectionDock {...props} input={EMPTY_INPUT} />)
    view.rerender(<SelectionDock {...props} input={snapshotOf(commented)} />)

    const text = document.querySelector<HTMLElement>('[data-dsh-quote-capsule-text]')!
    expect(text.dataset.dshQuoteCapsuleText).toBe('comment')
    expect(text.textContent).toBe(note)
    // 截断交给 ellipsis，完整值挂 title。
    expect(text.getAttribute('title')).toBe(note)
    expect(text.style.textOverflow).toBe('ellipsis')
    // 已保存内容用更实的前景色：label-primary 浅 18.90:1 / 深 11.57:1。
    expect(text.getAttribute('style')).toContain('var(--dsw-alias-label-primary, #0f1115)')

    cleanup()
    const bare = aggregateOf([twoItems.items[0]!])
    const bareProps = dockProps(bare)
    const second = render(<SelectionDock {...bareProps} input={EMPTY_INPUT} />)
    second.rerender(<SelectionDock {...bareProps} input={snapshotOf(bare)} />)
    const empty = document.querySelector<HTMLElement>('[data-dsh-quote-capsule-text]')!
    expect(empty.dataset.dshQuoteCapsuleText).toBe('placeholder')
    expect(empty.textContent).toBe(zh['selection.comment.placeholder'])
    expect(empty.getAttribute('title')).toBeNull()
    // 占位符弱一档，但仍过 4.5:1：label-secondary 浅 5.80:1 / 深 8.03:1。
    expect(empty.getAttribute('style')).toContain('var(--dsw-alias-label-secondary, #61666b)')
  })

  it('lets a hover on a different quote take the pinned capsule with it, instead of leaving it stuck', async () => {
    // 与任意一条引用交互过（哪怕只是打开卡片又取消）之后，ui 会钉在 'capsule'
    // 上——旧代码只有 removeQuote 成功那一条路径会把它写回 'none'，于是这枚钉子
    // 只进不出：openItemId = ui.kind === 'none' ? peekItemId : ui.itemId 里
    // `ui.kind` 恒不是 'none'，peekItemId 被彻底挡在公式外面。表现是：之后悬停
    // 别的引用的徽标，hoveredItemId 照常更新（正文高亮跟着走），但胶囊纹丝不动，
    // 仍停在被钉住的那条上。
    // 杀法：把 schedulePeek 里"悬停到另一条时松开钉子"那段删掉（或者把
    // `setUi({kind:'none'})` 换成什么都不做）——悬停第 2 条徽标时胶囊仍停在
    // 第 1 条上，下面这条断言就会红。
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    rangeRects.set('second', [{ top: 300, bottom: 316 }])
    mountConversation('s', [{ nodeKey: 'n1', text: 'first' }, { nodeKey: 'n2', text: 'second' }])
    renderDock(twoItems)

    // 打开并取消第 1 条的卡片：ui 从 'card' 收起到 'capsule'，钉在条目 1 上
    // （commitCard 的保存成功路径走的是同一个 collapse()，效果等价）。
    openCard('1')
    fireEvent.click(screen.getByRole('button', { name: '取消编辑第 1 条引用的评论' }))
    const capsule = () => document.querySelector<HTMLElement>('[data-dsh-quote-capsule]')!
    expect(capsule(), '取消后正文旁应该留着第 1 条的胶囊').not.toBeNull()
    expect(capsule().dataset.dshQuoteCapsule, '取消后胶囊应该钉在条目 1 上').toBe('1')

    // 悬停第 2 条的正文徽标，等悬停预览的开启延迟（PEEK_OPEN_MS）跑完。
    await act(async () => {
      fireEvent.mouseEnter(document.querySelector<HTMLElement>('[data-dsh-quote-badge-anchor="two"]')!)
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    expect(capsule(), '悬停到另一条引用后胶囊应该换成新的这一条').not.toBeNull()
    expect(capsule().dataset.dshQuoteCapsule, '悬停到另一条引用后胶囊没有跟过去').toBe('2')
  })

  it('lets the chip close the list it opened, and keeps aria-expanded honest', () => {
    // 杀法：删掉 QuoteList capture 监听里那句 `anchor.current?.contains(target)`
    // —— 点 chip 时先 setListOpen(false)，紧接着 chip 的 click 读到 open=false
    // 又取反开回来，列表永远关不掉、aria-expanded 一直在说谎。
    renderDock(twoItems)
    const chip = screen.getByRole('button', { name: '查看 2 条引用' })
    fireEvent.pointerDown(chip)
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelectorAll('[data-dsh-quote-list-row]').length).toBe(2)

    // 真实的事件顺序：pointerdown（capture 阶段先跑）→ click。
    fireEvent.pointerDown(chip)
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelectorAll('[data-dsh-quote-list-row]').length).toBe(0)
  })

  it('hands focus back to the chip on Save / Cancel / Esc instead of dropping it on <body>', () => {
    // 卡片 portal 在 document.body，收起就是卸载 —— 三条显式路径都得还焦点。
    const updateComment = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    renderDock(twoItems, { updateComment })
    const chip = screen.getByRole('button', { name: '查看 2 条引用' })

    openCard('1')
    fireEvent.change(commentBox('对引用 1 的评论：first'), { target: { value: '存一下' } })
    fireEvent.click(screen.getByRole('button', { name: '保存第 1 条引用的评论' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement, '保存后焦点掉了').toBe(chip)

    openCard('1')
    fireEvent.click(screen.getByRole('button', { name: '取消编辑第 1 条引用的评论' }))
    expect(document.activeElement, '取消后焦点掉了').toBe(chip)

    openCard('1')
    const box = commentBox('对引用 1 的评论：first')
    fireEvent.change(box, { target: { value: 'esc 也要还焦点' } })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(document.activeElement, 'Esc 后焦点掉了').toBe(chip)

    // 焦点归还本身会触发一次 focusout —— 落定之后不许借它再提交一遍。
    expect(updateComment).toHaveBeenCalledTimes(2)
  })

  it('keeps the card, the draft and the focus when the delete loses the CAS race', () => {
    // 杀法：把 removeQuote 换回「先 setUi({kind:'none'}) 再 if (!result.ok) return」，
    // 并把卡片上的垃圾桶换回 finish(onRemove) —— 卡片卸载 → 卸载清理的「尽力
    // 提交」被提前置位的 settled 挡掉 → 条目没删掉、用户的字也没了，焦点落 <body>。
    const removeItem = vi.fn(() => ({ ok: false as const, reason: 'stale-draft' as const }))
    const updateComment = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    const view = renderDock(twoItems, { removeItem, updateComment })
    openCard('1')
    fireEvent.change(commentBox('对引用 1 的评论：first'), { target: { value: '刚打的字' } })
    const trash = screen.getByRole('button', { name: '删除引用 1：first' })
    fireEvent.click(trash)
    fireEvent.click(trash)
    expect(removeItem).toHaveBeenCalledWith('one')

    // 卡片留在原地、文字留住、错误画在卡片上（与提交失败同款处理）。
    expect(screen.queryByRole('dialog')).not.toBeNull()
    expect(commentBox('对引用 1 的评论：first').value).toBe('刚打的字')
    expect(screen.getByRole('alert').textContent).toBe(zh['selection.error.draftChanged'])
    // 焦点没掉进 <body>：承载它的元素还在卡片里。
    expect(card().contains(document.activeElement)).toBe(true)
    // 第一次按下已经如实播报过"再按一次以删除"；删除本身失败（CAS 竞争），
    // 所以没有后续的"已删除引用 1"，但 armed 那句不是"没播报"。
    expect(document.querySelector('[data-dsh-quote-announce]')!.textContent).toBe('再按一次以删除引用 1')
    // 而且卸载时那段字**仍然**会被尽力提交。
    view.unmount()
    expect(updateComment).toHaveBeenCalledWith('one', '刚打的字')
  })

  it('tells the user to press again before it deletes anything, instead of just toggling aria-pressed', () => {
    // 删除走 CAS 改写草稿，不进浏览器的文本 undo 栈；而真正的「撤销」在这里做不
    // 出来（重新插入引用要一个活的 DOM 选区，detached 条目给不出）。所以二次确认。
    // 杀法：让 useArmedDelete.press 直接 onConfirm() —— 第一次点就删。
    const removeItem = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    renderDock(twoItems, { removeItem })
    openCard('1')
    const trash = screen.getByRole('button', { name: '删除引用 1：first' })
    const live = document.querySelector<HTMLElement>('[data-dsh-quote-announce]')!
    // 静息态与今天逐字节相同：没有任何常驻装饰，可访问名就是普通的删除说明。
    expect(trash.getAttribute('aria-pressed')).toBeNull()
    expect(trash.getAttribute('aria-label')).toBe('删除引用 1：first')

    fireEvent.click(trash)
    expect(removeItem).not.toHaveBeenCalled()
    // aria-pressed（「已按下」）套在一个破坏性的一次性动作上是在撒谎——它在
    // 「删除引用 1」这句上最自然的解读恰恰是「已经删掉了」，与事实相反，所以
    // 彻底不渲染它；第一次按下改用可访问名 + live region 明说「还没删，
    // 再按一次才删」。
    expect(trash.getAttribute('aria-pressed')).toBeNull()
    expect(trash.getAttribute('aria-label')).toBe('再按一次以删除引用 1')
    expect(live.textContent).toBe('再按一次以删除引用 1')
    expect(trash.getAttribute('style')).toContain('inset 0 0 0 1px')

    // 移开指针就解除，armed 不跨交互残留，可访问名退回静息文案。
    fireEvent.mouseLeave(trash)
    expect(trash.getAttribute('aria-label')).toBe('删除引用 1：first')
    fireEvent.click(trash)
    expect(removeItem).not.toHaveBeenCalled()
    expect(trash.getAttribute('aria-label')).toBe('再按一次以删除引用 1')

    fireEvent.click(trash)
    expect(removeItem).toHaveBeenCalledWith('one')
    expect(live.textContent).toBe('已删除引用 1')
  })

  it('arms the list row’s X the same way, on the fill its red ring survives in dark mode', () => {
    // 列表行的 X 与卡片上的垃圾桶共用同一条闸门；armed 的填充**必须**是 danger
    // 那块，不能是中性的 interactive-bg-active —— 后者深色合成 #515254，红色内描边
    // #f25a5a 画上去只有 2.37:1，低于 1.4.11 对非文本指示器的 3:1（danger 填充
    // #513b3d 上是 3.11:1）。杀法：把 armed 那一支换回 interactive-bg-active，
    // 或让 onClick 直接调 onRemove。
    const removeItem = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    renderDock(twoItems, { removeItem })
    openChipList()
    const x = screen.getAllByRole('button', { name: '删除引用 1：first' })[0]!
    expect(x.getAttribute('aria-pressed')).toBeNull()

    fireEvent.click(x)
    expect(removeItem).not.toHaveBeenCalled()
    // 与卡片上的垃圾桶同一条决定：不用 aria-pressed，第一次按下换成
    // 「再按一次以删除」的可访问名。
    expect(x.getAttribute('aria-pressed')).toBeNull()
    expect(x.getAttribute('aria-label')).toBe('再按一次以删除引用 1')
    const armedStyle = x.getAttribute('style')!
    expect(armedStyle).toContain('inset 0 0 0 1px')
    expect(armedStyle).toContain('--dsw-alias-interactive-bg-hover-danger')
    expect(armedStyle).not.toContain('--dsw-alias-interactive-bg-active')

    fireEvent.click(x)
    expect(removeItem).toHaveBeenCalledWith('one')
  })

  it('puts the excerpt and the comment into the list button’s accessible name', () => {
    // aria-label 会**覆盖**按钮内容，所以旧写法让可见的摘要与评论预览对屏读完全
    // 不可见 —— 而这份列表正是"原文没了之后唯一的入口"，屏读用户恰恰在这里最需
    // 要分辨哪条是哪条。杀法：换回 aria-label={t('selection.list.edit', { n })}。
    const commented = aggregateOf([
      { ...twoItems.items[0]!, comment: '这条我不同意' },
      twoItems.items[1]!,
    ])
    renderDock(commented)
    openChipList()
    expect(screen.getByRole('button', { name: '编辑第 1 条引用的评论 first 这条我不同意' })).toBeTruthy()
    expect(screen.getByRole('button', {
      name: `编辑第 2 条引用的评论 second ${zh['selection.comment.empty']}`,
    })).toBeTruthy()
    expect(editRow('1').getAttribute('aria-label')).toBeNull()
  })

  it('truncates a long comment in the edit button’s accessible name instead of reading it in full', () => {
    // 摘要那半（quoteExcerpt）会截断，评论那半直接渲染原文——视觉上靠
    // text-overflow 裁掉，但 aria-labelledby 读的是 DOM 里的真实文本节点，
    // 从没被裁短过。一条长评论会让屏读用户听完一整段才轮到下一个按钮。
    // 杀法：把 quoteExcerpt(comment) 换回裸的 comment。
    const longComment = '这条评论真的很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长，用来验证可访问名会不会把整段话都读出来。'
    expect(longComment.length).toBeGreaterThan(40)
    const truncated = '这条评论真的很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长…'
    const commented = aggregateOf([{ ...twoItems.items[0]!, comment: longComment }])
    renderDock(commented)
    openChipList()
    expect(screen.queryByRole('button', {
      name: `编辑第 1 条引用的评论 first ${longComment}`,
    }), '可访问名把未截断的整条评论读了出来').toBeNull()
    expect(screen.getByRole('button', {
      name: `编辑第 1 条引用的评论 first ${truncated}`,
    })).toBeTruthy()
    // 可见文本节点本身也是截断后的那份：视觉与可访问名现在说的是同一句话。
    expect(document.getElementById('dsh-quote-comment-one')!.textContent).toBe(truncated)
  })

  it('namespaces the card describedby ids by item so two Panes cannot cross-read', () => {
    // SelectionDock 是按 session 注册的：双 Pane 下两个实例同时存在，序号生成的
    // id 逐字节相同，aria-describedby 会解析到文档里靠前的那一个 —— 读成另一个
    // Pane 的状态。杀法：把 id 换回 `dsh-quote-card-state-${ordinal}`。
    //
    // 两张卡片**怎么才能真的同时在场**：打开右边那张时它的 textarea 会抢焦点，
    // 左边那张随即收到 focusout（relatedTarget 落在卡片外）→ 走「失焦即保存」→
    // 存成功就收起。所以平时同一时刻只有一张。唯一留住左边那张的是**保存失败**
    // （CAS 竞争）：本文件既有的不变量是"提交失败不收起、不清 draft"。于是两套
    // id 同时躺在文档里，这条测试就驱动这条唯一可达的路径。
    const left = aggregateOf([{ ...twoItems.items[0]!, id: 'left-1', parentSessionId: 'sa' }])
    const right = aggregateOf([{ ...twoItems.items[1]!, id: 'right-1', parentSessionId: 'sb' }])
    const leftUpdate = vi.fn(() => ({ ok: false as const, reason: 'stale-draft' as const }))
    render(
      <>
        <SelectionDock
          sessionId="sa"
          session={{ sessionId: 'sa' }}
          input={snapshotOf(left)}
          updateComment={leftUpdate}
          removeItem={vi.fn(() => ({ ok: true as const, aggregate: left }))}
          t={zhTranslate}
        />
        <SelectionDock
          sessionId="sb"
          session={{ sessionId: 'sb' }}
          input={snapshotOf(right)}
          updateComment={vi.fn(() => ({ ok: true as const, aggregate: right }))}
          removeItem={vi.fn(() => ({ ok: true as const, aggregate: right }))}
          t={zhTranslate}
        />
      </>,
    )
    const chips = screen.getAllByRole('button', { name: '查看 1 条引用' })
    expect(chips.length).toBe(2)
    fireEvent.click(chips[0]!)
    fireEvent.click(chips[1]!)
    const edits = screen.getAllByRole('button', { name: /^编辑第 1 条引用的评论 / })
    expect(edits.length).toBe(2)
    fireEvent.click(edits[0]!)
    // 先打点字：draft === baseline 时 commitCard 早退，根本不调 updateComment，
    // 左边那张照样收起，两张卡片就凑不齐。
    fireEvent.change(commentBox('对引用 1 的评论：first'), { target: { value: '左边写了一半' } })
    fireEvent.click(edits[1]!)
    expect(leftUpdate).toHaveBeenCalledWith('left-1', '左边写了一半')

    const dialogs = screen.getAllByRole('dialog')
    expect(dialogs.length).toBe(2)
    const ids = dialogs.map((node) => node.querySelector('textarea')!.getAttribute('aria-describedby')!)
    expect(new Set(ids).size, '两个 Pane 的 aria-describedby 目标 id 撞了').toBe(2)
    for (const id of ids) {
      expect(document.querySelectorAll(`[id="${id}"]`).length, id).toBe(1)
    }
  })

  it('does not let the unmount commit drag the fresh capsule back to the old quote', () => {
    // 卸载路径上 commit.current 是上一帧的 commitCard 闭包，而这时 ui 已经被
    // 「新增引用自动浮胶囊」的 effect 换成了第 2 条的胶囊。杀法：把 commitCard
    // 里的 collapse() 换回无条件 setUi({kind:'capsule', itemId, anchor})。
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    rangeRects.set('second', [{ top: 300, bottom: 316 }])
    mountConversation('s', [{ nodeKey: 'n1', text: 'first' }, { nodeKey: 'n2', text: 'second' }])
    const one = aggregateOf([twoItems.items[0]!])
    const updateComment = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    const props = dockProps(twoItems, { updateComment })
    const view = render(<SelectionDock {...props} input={snapshotOf(one)} />)
    openCard('1')
    fireEvent.change(commentBox('对引用 1 的评论：first'), { target: { value: '第一条的评论' } })

    view.rerender(<SelectionDock {...props} input={snapshotOf(twoItems)} />)
    // 字没丢（尽力提交照跑）……
    expect(updateComment).toHaveBeenCalledWith('one', '第一条的评论')
    // ……但胶囊必须留在刚到货的第 2 条上。
    const capsule = document.querySelector<HTMLElement>('[data-dsh-quote-capsule]')!
    expect(capsule.dataset.dshQuoteCapsule, '胶囊被打回了旧条目').toBe('2')
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

describe('applySelectionActions localizes the add-to-conversation projection', () => {
  interface CapturedSource {
    readonly name: string
    readonly codec: { serialize(ref: string, signal: AbortSignal): Promise<string> }
  }

  /** 只喂 applySelectionActions 注册期间真正会碰到的最小面：不涉及点击/fork。 */
  function fakeApplyServices(): { services: SelectionApplyServices; registered: CapturedSource[] } {
    const registered: CapturedSource[] = []
    const services = {
      sessions: {},
      conversation: {},
      inputTriggers: {
        registerSource: (src: CapturedSource) => { registered.push(src); return () => {} },
        sessionOf: () => ({}),
      },
      slots: {
        inject: (_name: string, setup: () => unknown) => setup(),
        register: () => () => {},
      },
      harness: {},
    } as unknown as SelectionApplyServices
    return { services, registered }
  }

  it('threads the host t() into the selection-reference codec instead of always falling back to English', async () => {
    // 复核者的证据：唯一的注册处调用 createSelectionReferenceSource() 不传参，
    // codec 永远用 SELECTION_QUOTE_COPY.en——中文宿主也会把 "Quoting from
    // above:" 发给模型。这里用真实的 applySelectionActions() 走一遍注册路径
    // （而不是直接测 createSelectionReferenceCodec，那条已经在
    // selection-reference.test.ts 里测过，问题只出在这里没把 t() 接进去），
    // 抓住实际注册的 source，序列化一份聚合引用，断言产物是中文。
    const ctx: SelectionApplyContext = { effect: (setup) => setup() }
    const { services, registered } = fakeApplyServices()
    const controller = applySelectionActions(ctx, services, zhTranslate, 'dsh-workbench')
    try {
      const source = registered.find((item) => item.name === SELECTION_REFERENCE_SOURCE)
      expect(source).toBeDefined()

      const aggregate: SelectionAggregateV1 = {
        version: SELECTION_AGGREGATE_VERSION,
        items: [{
          id: 'one', parentSessionId: 's', nodeKey: 'n', nodeKind: 'user',
          atSeq: 1, text: '选中的文字', startOffset: 0, endOffset: 5,
        }],
      }
      const serialized = await source!.codec.serialize(
        encodeSelectionAggregate(aggregate), new AbortController().signal,
      )
      expect(serialized).toContain(zh['selection.quote.heading'])
      expect(serialized).not.toContain('Quoting from above:')
    } finally {
      controller.dispose()
    }
  })

  it('installs the quote-highlight stylesheet through ctx.effect', () => {
    // `::highlight()` 规则没有内联等价物 —— 注册期必须把样式表装上，否则色带
    // 一条都画不出来（jsdom 测不了绘制，但能测"规则到底有没有进 document"）。
    const ctx: SelectionApplyContext = { effect: (setup) => setup() }
    const { services } = fakeApplyServices()
    const controller = applySelectionActions(ctx, services, zhTranslate, 'dsh-workbench')
    try {
      const tags = document.head.querySelectorAll('[data-dsh-nux-styles="quote-highlight"]')
      expect(tags.length).toBe(1)
      expect(tags[0]!.textContent).toContain('::highlight(dsh-nux-quote)')
    } finally {
      controller.dispose()
    }
  })

  it('still falls back to the English default when no copy is threaded through (documents the pre-fix behavior)', async () => {
    // 对照组：直接调用未传 copy 的 createSelectionReferenceSource()（旧调用
    // 方式），证明"不传参就是英文"这件事本身没变——变的是 applySelectionActions
    // 现在会传参了。这样即使有人以后又在别处裸调用这个工厂函数，这条测试也
    // 不会假装那是本次要修的 bug。
    const { createSelectionReferenceSource } = await import('./selection-reference.js')
    const aggregate: SelectionAggregateV1 = {
      version: SELECTION_AGGREGATE_VERSION,
      items: [{ id: 'one', parentSessionId: 's', nodeKey: 'n', nodeKind: 'user', atSeq: 1, text: 'x', startOffset: 0, endOffset: 1 }],
    }
    const serialized = await createSelectionReferenceSource().codec!.serialize(
      encodeSelectionAggregate(aggregate), new AbortController().signal,
    )
    expect(serialized).toContain('Quoting from above:')
  })
})

/**
 * `dictionaries.ts` 的 `en satisfies Record<WorkbenchLocaleKey, string>` 已经在
 * **编译期**保证了 key 集合相等（多一个也会被 excess-property 检查拦下）。它管
 * 不到的是插值占位符：中文写 `{count}`、英文写 `{n}` 是能编译通过的，运行时那句
 * 话就会留着一个没被替换的花括号。这条测试补的正是那个缺口。
 */
describe('引用浮层文案（zh/en）', () => {
  const added = [
    'selection.chip.label', 'selection.chip.aria', 'selection.list.label', 'selection.list.edit',
    'selection.card.aria', 'selection.comment.empty',
    'selection.comment.save', 'selection.comment.saveAria', 'selection.comment.cancel',
    'selection.comment.cancelAria', 'selection.comment.saveEmpty',
    'selection.announce.added', 'selection.announce.saved', 'selection.announce.removed',
  ] as const

  it('ships every new key in both dictionaries with matching placeholders', () => {
    const placeholders = (text: string) => (text.match(/\{[a-zA-Z]+\}/g) ?? []).sort()
    for (const key of added) {
      const zhText = (zh as Record<string, string>)[key]
      const enText = (en as Record<string, string>)[key]
      expect(typeof zhText, `zh['${key}']`).toBe('string')
      expect(typeof enText, `en['${key}']`).toBe('string')
      expect(zhText!.length, `zh['${key}']`).toBeGreaterThan(0)
      expect(enText!.length, `en['${key}']`).toBeGreaterThan(0)
      expect(placeholders(enText!), `placeholders of '${key}'`).toEqual(placeholders(zhText!))
    }
  })

  it('keeps the two dictionaries exactly the same size', () => {
    expect(Object.keys(en).length).toBe(Object.keys(zh).length)
  })
})
