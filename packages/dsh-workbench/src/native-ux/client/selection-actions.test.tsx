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
import { zh } from '../../client/dictionaries.js'

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
    ownerId: string; ranges: number; active: number; activeTexts: string[]; texts: string[]; objects: readonly Range[]
  }> = []
  const withdrawn: string[] = []
  return {
    published,
    withdrawn,
    registry: {
      publish: (ownerId: string, publication: { ranges: readonly Range[]; active: readonly Range[] }) => {
        published.push({
          ownerId,
          ranges: publication.ranges.length,
          active: publication.active.length,
          activeTexts: publication.active.map((range) => range.toString()),
          texts: publication.ranges.map((range) => range.toString()),
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
    // cleanup() 必须先跑：徽标图层 portal 在 document.body 上，先 innerHTML=''
    // 会把 React 还持有的 portal 节点抽走，随后的卸载就抛
    // NotFoundError。文件级的 afterEach(cleanup) 在这之后跑，重复调用是幂等的。
    cleanup()
    uninstallRangeRects()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('edits comments and removes ordered aggregate items through injected actions', () => {
    const updateComment = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    const removeItem = vi.fn(() => ({ ok: true as const, aggregate: twoItems }))
    renderDock(twoItems, { updateComment, removeItem })

    const comment = screen.getByLabelText('对引用 1 的评论：first')
    fireEvent.change(comment, { target: { value: 'important' } })
    fireEvent.blur(comment)
    expect(updateComment).toHaveBeenCalledWith('one', 'important')
    fireEvent.click(screen.getByRole('button', { name: '删除引用 2：second' }))
    expect(removeItem).toHaveBeenCalledWith('two')
  })

  it('moves the visible count into the section name and drops the title row', () => {
    renderDock(twoItems)
    const section = screen.getByLabelText('选区引用（2 条）')
    // 标题行、卡片外框、原文预览、竖条全部不再渲染。
    expect(section.textContent).not.toContain('(2)')
    expect(section.textContent).not.toContain('first')
    // 原文不再作为可见文本重复渲染，但视觉用户仍要有一条拿到它的途径：
    // 整行的 title（见 'keeps a pointer route…'）。可见 = 无，可达 = 有。
    expect(screen.getByTitle('first').getAttribute('data-dsh-selection-dock-row')).toBe('one')
    expect(section.style.border).toBe('')
    expect(section.style.background).toBe('')
  })

  it('numbers badges by aggregate array index, never by document position', () => {
    // 编号必须等于 quoteItemLabel(copy, index + 1) 发给模型的编号；按文档位置
    // 重排会让用户看到的编号与模型读到的错位。这里把两条引用的行在 DOM 里
    // 倒序放置，编号仍必须是 1、2。
    installRangeRects()
    // 视觉顺序与数组顺序**相反**：first 在下(300)、second 在上(200)。按文档/位置
    // 排序的实现会把编号排成 second=1、first=2，与 quoteItemLabel(copy, index+1)
    // 发给模型的编号错位。
    rangeRects.set('first', [{ top: 300, bottom: 316 }])
    rangeRects.set('second', [{ top: 200, bottom: 216 }])
    mountConversation('s', [{ nodeKey: 'n2', text: 'second' }, { nodeKey: 'n1', text: 'first' }])
    renderDock(twoItems)
    const overlay = document.querySelectorAll<HTMLElement>('[data-dsh-quote-badge-anchor]')
    expect(Array.from(overlay, (node) => node.dataset.dshQuoteBadgeAnchor)).toEqual(['one', 'two'])
    expect(Array.from(overlay, (node) => node.textContent)).toEqual(['1', '2'])
    // 编号 1 落在下面那一行（top 300），编号 2 落在上面那一行（top 200）。
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

  it('never publishes a quote whose row is gone, and says so without revoking the reference', () => {
    // 锚点找不到 → detached。色带与正文徽标消失，但引用本身不失效：
    // 发送时序列化的是捕获时冻结的 item.text，与 DOM 无关。
    const recorder = recordingRegistry()
    renderDock(twoItems, { highlights: recorder.registry })
    expect(recorder.published[recorder.published.length - 1]!.ranges).toBe(0)
    expect(document.querySelectorAll('[data-dsh-quote-badge-anchor]').length).toBe(0)
    // 引用区那一行还在，删除入口也还在（删除不能依赖锚点活着）。
    expect(screen.getByLabelText('对引用 1 的评论：first')).toBeTruthy()
    expect(screen.getByRole('button', { name: '删除引用 1：first' })).toBeTruthy()
    const state = document.getElementById('dsh-quote-state-one')!
    expect(state.textContent).toBe(zh['selection.anchor.detached'])
    expect(screen.getByLabelText('对引用 1 的评论：first').getAttribute('aria-describedby')).toBe('dsh-quote-state-one')
    // 状态说明绝不设 aria-live —— 滚动会让 anchored ⇄ offscreen 频繁翻转。
    expect(state.getAttribute('aria-live')).toBeNull()
    expect(document.querySelector('[data-dsh-quote-badge="detached"]')).toBeTruthy()
  })

  it('keeps the colour band but hides the overlay badge for a quote scrolled out of the band', () => {
    installRangeRects()
    // 可见带是 [100, 600)；这一条的末行整个在带子上方。
    rangeRects.set('first', [{ top: 20, bottom: 36 }])
    rangeRects.set('second', [{ top: 300, bottom: 316 }])
    mountConversation('s', [{ nodeKey: 'n1', text: 'first' }, { nodeKey: 'n2', text: 'second' }])
    const recorder = recordingRegistry()
    renderDock(twoItems, { highlights: recorder.registry })
    // 色带两条都发布了（滚过去自然看见），徽标只剩带内那一条。
    expect(recorder.published[recorder.published.length - 1]!.ranges).toBe(2)
    const anchors = Array.from(
      document.querySelectorAll<HTMLElement>('[data-dsh-quote-badge-anchor]'),
      (node) => node.dataset.dshQuoteBadgeAnchor,
    )
    expect(anchors).toEqual(['two'])
    expect(document.getElementById('dsh-quote-state-one')!.textContent).toBe(zh['selection.anchor.offscreen'])
    expect(document.getElementById('dsh-quote-state-two')!.textContent).toBe('')
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
    // item.parentSessionId 是 's'，这个坞是 'other' 的 —— 不许画进别的 Pane。
    expect(recorder.published[recorder.published.length - 1]!.ranges).toBe(0)
  })

  it('still refuses a foreign-session quote on a host with no pane markers at all', () => {
    // 没有 [data-session-pane] 时 captureConversationRange 的 paneSessionId 是
    // undefined，那一层判据（与 #validateActive 同写法）放行；此时唯一挡住
    // "画进别的会话"的就是图层自己的 parentSessionId 闸门。
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

  it('re-measures the badge on scroll without re-resolving the range', async () => {
    // 设计里最贵的一条约束：滚动**只**重算徽标矩形。重解析要走
    // eligibleTextNodes（每个文本节点一次 getComputedStyle），挂到滚动上会在
    // 流式输出时每帧做几千次样式重算。"同一个 Range 对象"是这件事唯一能从外面
    // 观测到的证据。
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

  it('re-resolves after the host swaps the quoted row text node', async () => {
    // 宿主重渲染会让持有的 Range 静默塌缩（isConnected 仍是 true）。图层必须
    // 从身份重解析出一条**新**的 Range，而不是继续画一条死的。
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
    // jsdom 没有 ResizeObserver（navigator.test.tsx:20 已有 stub 先例），所以
    // 这条路径必须自己造观察器才能测到。判据仍是 Range 的对象身份：尺寸变化
    // 必须换出一条**新**的（换行位置变了，旧 Range 的行矩形已经不对）。
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

  it('reports detached rather than a stale anchor on a host with no structural observer', async () => {
    // 降级宿主：既没有 [data-session-pane] 也没有 [data-conversation-scroll]，
    // 于是 focusedPaneScope 退回 document、观察器无处可挂（GA-031：绝不因此
    // 去挂 document.body）。这时缓存的 Range 可能已被宿主重渲染悄悄塌缩，而
    // 没有任何结构信号会来重解析 —— 测量帧必须自己认出这一点。
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
    // 只触发"测量"这一条路径（活跃项变化），不触发重解析。
    fireEvent.focus(screen.getByLabelText('对引用 1 的评论：first'))
    expect(recorder.published[recorder.published.length - 1]!.ranges).toBe(0)
    expect(document.getElementById('dsh-quote-state-one')!.textContent).toBe(zh['selection.anchor.detached'])
  })

  it('never observes document.body, even with no pane and no scrollport (GA-031)', () => {
    // navigator.tsx:102 那段注释把这条教训写死了：观察器绝不长期挂在 body。
    // 找不到会话根 / 滚动容器 / pane 时宁可不装观察器 —— 功能降级（靠 ref 变化
    // 与 resize 兜底），而不是换来一个全局观察器。
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

  it('emphasises the matching range while a comment box is focused', () => {
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    rangeRects.set('second', [{ top: 300, bottom: 316 }])
    mountConversation('s', [{ nodeKey: 'n1', text: 'first' }, { nodeKey: 'n2', text: 'second' }])
    const recorder = recordingRegistry()
    renderDock(twoItems, { highlights: recorder.registry })
    expect(recorder.published[recorder.published.length - 1]!.active).toBe(0)
    fireEvent.focus(screen.getByLabelText('对引用 2 的评论：second'))
    expect(recorder.published[recorder.published.length - 1]!.active).toBe(1)
    fireEvent.blur(screen.getByLabelText('对引用 2 的评论：second'))
    expect(recorder.published[recorder.published.length - 1]!.active).toBe(0)
  })

  it('hides the overlay layer from assistive tech and keeps its badges unfocusable', () => {
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    mountConversation('s', [{ nodeKey: 'n1', text: 'first' }])
    renderDock(aggregateOf([twoItems.items[0]!]))
    const layer = document.querySelector<HTMLElement>('[data-dsh-quote-overlay]')!
    expect(layer.getAttribute('aria-hidden')).toBe('true')
    expect(layer.getAttribute('role')).toBe('presentation')
    // aria-hidden 容器里放可聚焦控件 = 能 Tab 到但读不出来的黑洞。
    expect(layer.querySelectorAll('button, [tabindex]').length).toBe(0)
    // 0×0 的定位盒，绝不铺满屏幕拦截宿主的指针事件。
    expect(layer.style.width).toBe('0px')
    expect(layer.style.height).toBe('0px')
    expect(layer.style.zIndex).toBe('899')
  })

  it('keeps the icon-only remove control reachable and focus-ringed', () => {
    renderDock(aggregateOf([twoItems.items[0]!]))
    const remove = screen.getByRole('button', { name: '删除引用 1：first' })
    expect(remove.textContent).toBe('')
    expect(remove.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(remove.style.outlineOffset).toBe('2px')
    fireEvent.focusIn(remove)
    expect(remove.getAttribute('style')).toContain(`outline: 2px solid ${FOCUS_RING_COLOR}`)
  })

  it('gives the resting comment input a boundary-contrast-safe border, not the low-contrast divider token', () => {
    // border-l2（旧 token）合成到 bg-base 上浅色只有约 1.25:1，远低于 WCAG 1.4.11
    // 对 UI 组件边界要求的 3:1（见 selection-actions.tsx 里输入框 border 那段注释
    // 的计算过程）。静息态应是 label-tertiary（浅 3.71:1 / 深 8.54:1 起步），
    // 聚焦态才跳到 business-primary。
    renderDock(aggregateOf([twoItems.items[0]!]))
    const comment = screen.getByLabelText('对引用 1 的评论：first') as HTMLInputElement
    expect(comment.getAttribute('style')).toContain('var(--dsw-alias-label-tertiary, #81858c)')
    expect(comment.getAttribute('style')).not.toContain('var(--dsw-alias-border-l2')
    expect(comment.placeholder).toBe(zh['selection.comment.placeholder'])
    fireEvent.focus(comment)
    expect(comment.getAttribute('style')).toContain('var(--dsw-alias-state-business-primary, #4176e6)')
    fireEvent.blur(comment)
    expect(comment.getAttribute('style')).toContain('var(--dsw-alias-label-tertiary, #81858c)')
  })

  it('caps the dock height so a long quote list cannot push the composer off screen', () => {
    const many = aggregateOf(Array.from({ length: 8 }, (_, index) => ({
      id: `item-${index}`, parentSessionId: 's', nodeKey: `n${index}`, nodeKind: 'user',
      atSeq: index, text: `quote ${index}`, startOffset: 0, endOffset: 7,
    })))
    renderDock(many)
    const list = screen.getByLabelText('选区引用（8 条）').firstElementChild as HTMLElement
    expect(list.style.overflowY).toBe('auto')
    expect(list.style.maxHeight).toBe('136px')
  })

  it('keeps a pointer route to the quoted text even when no body badge is drawn', () => {
    // 重写后引用区只剩数字徽标 + 空评论框，而正文侧徽标在 offscreen / detached
    // 时**根本不渲染** —— 那两档里视觉用户没有任何途径知道第 N 条引用的是哪句
    // 话，屏读用户反而更全（摘要在评论框的可访问名里）。整行的 title 是补回来的
    // 那条途径：三种锚点状态下都在，且不把厚重的原文预览搬回来。
    renderDock(twoItems)
    expect(document.querySelectorAll('[data-dsh-quote-badge-anchor]').length).toBe(0)
    const row = document.querySelector<HTMLElement>('[data-dsh-selection-dock-row="one"]')!
    expect(row.title).toBe('first')
    expect(row.textContent).not.toContain('first')
    // 这个 div 没有 role、没有可访问名 —— title 不会给 AT 造出第二处复读。
    expect(row.getAttribute('role')).toBeNull()
    expect(row.getAttribute('aria-label')).toBeNull()
  })

  it('folds and clips the row title through the same excerpt rule as the accessible names', () => {
    renderDock(aggregateOf([{ ...twoItems.items[0]!, text: `line
${'a'.repeat(60)}` }]))
    const row = document.querySelector<HTMLElement>('[data-dsh-selection-dock-row="one"]')!
    expect(row.title).toBe(`line ${'a'.repeat(35)}…`)
    // 同一份摘要也进了评论框的可访问名 —— 两条途径给的是同一句话。
    expect(screen.getByLabelText(`对引用 1 的评论：${row.title}`)).toBeTruthy()
  })

  it('exposes "jump to the source" as a real button, not a mouse-only aria-hidden span', () => {
    // 旧写法是 `<span aria-hidden="true" onClick>`：不可聚焦、对 AT 隐藏、无 role,
    // 等于把「滚动到被引用段落」做成纯鼠标能力。
    renderDock(aggregateOf([twoItems.items[0]!]))
    const jump = screen.getByRole('button', { name: '跳到引用 1 的原文' })
    expect(jump.tagName).toBe('BUTTON')
    expect(jump.getAttribute('aria-hidden')).toBeNull()
    expect(jump.closest('[aria-hidden="true"]')).toBeNull()
    // 外观仍由同一个 QuoteBadge 画，按钮只加语义 / 命中区 / 焦点环。
    expect(jump.querySelector('[data-dsh-quote-badge]')).toBeTruthy()
    // 环画在徽标外面（徽标自己的描边就是 business-primary，内缩会糊成一团）。
    expect(jump.style.outlineOffset).toBe('2px')
    fireEvent.focusIn(jump)
    expect(jump.getAttribute('style')).toContain(`outline: 2px solid ${FOCUS_RING_COLOR}`)
    // 外侧 4px 的环要有容身之处：滚动容器（overflowY:auto 会在 padding box 上裁切）
    // 左右各留 4px。
    const list = screen.getByLabelText('选区引用（1 条）').firstElementChild as HTMLElement
    expect(list.style.padding).toBe('2px 4px')
  })

  it('gives the comment input the same focus ring the buttons use, not a 1.14:1 border swap', () => {
    // 旧写法 outline:none，聚焦的唯一信号是 border 从 label-tertiary 换成
    // business-primary —— 两色互比浅 1.14:1 / 深 1.25:1，远低于「焦点态相对未
    // 聚焦态 3:1」。换成同一套 FOCUS_RING 后，环相对未聚焦时的同一批像素（卡面）
    // 浅 4.23:1 / 深 5.24:1。
    renderDock(aggregateOf([twoItems.items[0]!]))
    const comment = screen.getByLabelText('对引用 1 的评论：first') as HTMLInputElement
    expect(comment.getAttribute('style')).toContain('outline: none')
    fireEvent.focus(comment)
    expect(comment.getAttribute('style')).toContain(`outline: 2px solid ${FOCUS_RING_COLOR}`)
    // 这里偏移取负：输入框高 32px 正好占满行，行距只有 2px，外侧环会压到相邻行
    // 并被滚动容器的上下缘裁掉；内缩后环整条落在 bg-base 的填充里（4.23 / 6.86）。
    expect(comment.style.outlineOffset).toBe('-2px')
    fireEvent.blur(comment)
    expect(comment.getAttribute('style')).toContain('outline: none')
  })

  it('lets the emphasis fall back to the focused row when the pointer leaves another row', () => {
    // hover 与 focus 曾经共用一个 activeItemId，而行的 onMouseLeave 是无条件清空：
    // 鼠标划过第 2 行再移开，会把第 1 行（键盘正聚焦）的强调一起抹掉。
    installRangeRects()
    rangeRects.set('first', [{ top: 200, bottom: 216 }])
    rangeRects.set('second', [{ top: 300, bottom: 316 }])
    mountConversation('s', [{ nodeKey: 'n1', text: 'first' }, { nodeKey: 'n2', text: 'second' }])
    const recorder = recordingRegistry()
    renderDock(twoItems, { highlights: recorder.registry })
    const active = () => recorder.published[recorder.published.length - 1]!.activeTexts
    fireEvent.focus(screen.getByLabelText('对引用 1 的评论：first'))
    expect(active()).toEqual(['first'])
    const rowTwo = document.querySelector<HTMLElement>('[data-dsh-selection-dock-row="two"]')!
    // 指针是即时的直接操作：停在哪一行哪一行亮。
    fireEvent.mouseEnter(rowTwo)
    expect(active()).toEqual(['second'])
    // 松开后回落到键盘聚焦的那一行 —— 旧实现在这里变成 []。
    fireEvent.mouseLeave(rowTwo)
    expect(active()).toEqual(['first'])
  })

  it('emphasises the row while its jump button holds keyboard focus', () => {
    installRangeRects()
    rangeRects.set('second', [{ top: 300, bottom: 316 }])
    mountConversation('s', [{ nodeKey: 'n1', text: 'first' }, { nodeKey: 'n2', text: 'second' }])
    const recorder = recordingRegistry()
    renderDock(twoItems, { highlights: recorder.registry })
    const jump = screen.getByRole('button', { name: '跳到引用 2 的原文' })
    fireEvent.focusIn(jump)
    expect(recorder.published[recorder.published.length - 1]!.activeTexts).toEqual(['second'])
    fireEvent.focusOut(jump)
    expect(recorder.published[recorder.published.length - 1]!.activeTexts).toEqual([])
  })

  it('shows the badge even for a single quote', () => {
    // 与 codec 的行为**故意不同**：createSelectionReferenceCodec 在 items.length === 1
    // 时不加「引用 1：」——那是给模型看的序列化取舍，不该外溢到 UI。徽标是引用区
    // 与正文的唯一连接，N=1 时也必须在。
    renderDock(aggregateOf([twoItems.items[0]!]))
    expect(screen.getByLabelText('选区引用（1 条）').textContent).toContain('1')
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
