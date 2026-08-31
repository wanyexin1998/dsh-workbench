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
import {
  encodeSelectionAggregate, SELECTION_AGGREGATE_VERSION, SELECTION_REFERENCE_SOURCE,
  type SelectionAggregateV1,
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

  it('keeps the icon-only remove control and the truncated preview reachable', () => {
    const aggregate: SelectionAggregateV1 = {
      version: SELECTION_AGGREGATE_VERSION,
      items: [
        { id: 'one', parentSessionId: 's', nodeKey: 'n1', nodeKind: 'user', atSeq: 1, text: 'first', startOffset: 0, endOffset: 5 },
      ],
    }
    render(<SelectionDock
      sessionId="s"
      session={{ sessionId: 's' }}
      input={{
        draft: 'Selected context ', draftRev: 1,
        occurrences: [{ source: SELECTION_REFERENCE_SOURCE, ref: encodeSelectionAggregate(aggregate), offset: 0, length: 16 }],
      }}
      updateComment={vi.fn(() => ({ ok: true as const, aggregate }))}
      removeItem={vi.fn(() => ({ ok: true as const, aggregate }))}
      t={t}
    />)

    // 删除按钮改成图标后，可访问名只剩 aria-label —— 它必须留住。
    const remove = screen.getByRole('button', { name: 'selection.remove 1' })
    expect(remove.textContent).toBe('')
    expect(remove.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    // 面板里的焦点环与工具条同一个 token、同样画在按钮外侧（对 specific-tip 卡面 3.91:1）。
    expect(remove.style.outlineOffset).toBe('2px')
    fireEvent.focusIn(remove)
    expect(remove.getAttribute('style')).toContain(`outline: 2px solid ${FOCUS_RING_COLOR}`)
    // 预览被 ellipsis 截断，title 是唯一能读到全文的地方。
    expect(screen.getByTitle('first')).toBeTruthy()
  })

  it('gives the resting comment input a boundary-contrast-safe border, not the low-contrast divider token', () => {
    // border-l2（旧 token）合成到 bg-base 上浅色只有约 1.25:1，远低于 WCAG 1.4.11
    // 对 UI 组件边界要求的 3:1（见 selection-actions.tsx 里输入框 border 那段注释
    // 的计算过程）。静息态应换成 label-tertiary（浅 3.71:1 / 深 8.54:1 起步），
    // 聚焦态仍是本轮焦点环选的 business-primary，两者不应该混用。
    const aggregate: SelectionAggregateV1 = {
      version: SELECTION_AGGREGATE_VERSION,
      items: [
        { id: 'one', parentSessionId: 's', nodeKey: 'n1', nodeKind: 'user', atSeq: 1, text: 'first', startOffset: 0, endOffset: 5 },
      ],
    }
    render(<SelectionDock
      sessionId="s"
      session={{ sessionId: 's' }}
      input={{
        draft: 'Selected context ', draftRev: 1,
        occurrences: [{ source: SELECTION_REFERENCE_SOURCE, ref: encodeSelectionAggregate(aggregate), offset: 0, length: 16 }],
      }}
      updateComment={vi.fn(() => ({ ok: true as const, aggregate }))}
      removeItem={vi.fn(() => ({ ok: true as const, aggregate }))}
      t={t}
    />)
    const comment = screen.getByLabelText('selection.comment 1') as HTMLInputElement
    expect(comment.getAttribute('style')).toContain('var(--dsw-alias-label-tertiary, #81858c)')
    expect(comment.getAttribute('style')).not.toContain('var(--dsw-alias-border-l2')
    fireEvent.focus(comment)
    expect(comment.getAttribute('style')).toContain('var(--dsw-alias-state-business-primary, #4176e6)')
    fireEvent.blur(comment)
    expect(comment.getAttribute('style')).toContain('var(--dsw-alias-label-tertiary, #81858c)')
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
