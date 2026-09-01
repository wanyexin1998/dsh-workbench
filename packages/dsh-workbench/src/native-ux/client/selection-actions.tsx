import * as React from 'react'
import { createPortal } from 'react-dom'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { revealNode } from '../core/navigation-adapter.js'
import {
  ensureQuoteHighlightStyles, findBusinessRow, focusedPaneScope, locateComposerInput,
  locateScrollport, type QuoteBand,
} from './conversation-dom.js'
import type { HarnessServices } from './harness-adapter.js'
import {
  placeQuoteCard, quoteExcerpt, type QuoteAnchorState, type QuoteHighlightRegistry,
} from './quote-highlight.js'
import { QuoteBadge, QuoteBadgeLayer, useQuoteAnchors } from './quote-overlay.js'
import { SelectionController, type SelectionSessions } from './selection-controller.js'
import type { ConversationSelection } from './selection-contract.js'
import {
  appendSelectionReference, createSelectionReferenceSource, createSideChatReferenceSource,
  insertSideChatReference, readSelectionAggregate, removeSelectionItem,
  updateSelectionComment, type SelectionAggregateItem, type SelectionInput,
  type SelectionInputSnapshot, type SelectionMutationResult,
} from './selection-reference.js'
import {
  createSideChatActions,
  type SelectionQuoteCopy,
  type SideChatActions,
  type SideChatResult,
} from './side-chat-actions.js'

type Translate = (key: string, vars?: Record<string, string>) => string

interface SelectionSlots {
  inject(name: string, setup: () => unknown): unknown
  register(
    options: {
      name: string
      id: string
      label?: () => string
      locale?: string
      order?: number
      inject?: (sessionId: string) => Record<string, unknown>
    },
    component: unknown,
  ): () => void
}

export interface SelectionApplyContext {
  effect(setup: () => () => void, label?: string): unknown
}

export interface SelectionApplyServices {
  readonly sessions: SelectionSessions
  readonly conversation: IConversation
  readonly inputTriggers: InputTriggerServiceContract
  readonly slots: SelectionSlots
  readonly harness: HarnessServices
}

export interface SelectionActionResult {
  readonly ok: boolean
  readonly message?: string
}

function inputFor(services: SelectionApplyServices, sessionId: string): SelectionInput | null {
  const scope = services.sessions.scope?.(sessionId)
  if (scope === undefined) return null
  try {
    const input = services.conversation.input.for(scope as never)
    const eventScope = scope as {
      bail(subject: unknown, event: 'slash/input-consume-token', request: {
        guard: { kind: 'span'; span: { start: number; end: number; draftRev: number } }
      }): unknown
    }
    return {
      state: input.state as unknown as SelectionInput['state'],
      insertReference: (reference, span) => input.insertReference(reference, span),
      consumeSpan: (span) => eventScope.bail(eventScope, 'slash/input-consume-token', {
        guard: { kind: 'span', span },
      }) === true,
      notify: (level, text) => input.notify(level, text),
    }
  } catch {
    return null
  }
}

export function createSelectionItemId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return `selection-${cryptoApi.randomUUID()}`
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
    return `selection-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }
  return `selection-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function failureMessage(result: Extract<SelectionMutationResult, { readonly ok: false }>, t: Translate): string {
  return result.reason === 'stale-draft' ? t('selection.error.draftChanged') : t('selection.error.reference')
}

export function addSelectionToConversation(
  controller: SelectionController,
  services: SelectionApplyServices,
  selection: ConversationSelection,
  itemId: string,
  t: Translate,
): SelectionActionResult {
  const current = controller.revalidate(selection)
  if (current === null) return { ok: false, message: t('selection.error.stale') }
  const input = inputFor(services, current.parentSessionId)
  if (input === null) return { ok: false, message: t('selection.error.composer') }
  const result = appendSelectionReference(input, current, itemId, t('selection.reference.label'))
  if (!result.ok) {
    const message = failureMessage(result, t)
    input.notify?.('error', message)
    return { ok: false, message }
  }
  controller.focusSourceComposer()
  controller.clear()
  return { ok: true }
}

/* ── 视觉基元 ───────────────────────────────────────────────────────────────
   宿主浅色主题下 bg-base / layer-1..3 全是纯白，阴影 token 又不跟随深色主题；
   宿主的解法是「浅色靠阴影、深色靠 border-inverted 描边」两者同时写。
   lv3 里那条 `0 0 1px` 贴边环正是把纯白浮层从纯白正文里拉开的东西（lv2 没有）。 */
const SHADOW_LV3 = 'var(--dsw-shadow-lv3, 0 0 1px 0 rgba(0,0,0,.2), 0 0 4px 0 rgba(0,0,0,.02), 0 12px 32px 0 rgba(0,0,0,.08))'

/**
 * 焦点环颜色。旧写法是 label-tertiary + outlineOffset:-2，等于把环压在按钮填充上：
 * 深色主按钮填充是近白的 #f9fafb，环（深色 #adb2b8）只有 2.04:1、hover 态 1.83:1；
 * 浅色 hover 填充 #43454a 上也只有 2.59:1 —— 都低于 WCAG 1.4.11 焦点指示器的 3:1。
 *
 * 改法有两处：环画到按钮**外侧**（见 FOCUS_RING_OFFSET），相邻色就从按钮填充变成
 * 浮层表面色；同时换成 business-primary —— 它也是本文件备注输入框的聚焦描边色，
 * 整块 UI 的聚焦语言一致。改后实测（含 hover 态，因为环已不碰填充，值与填充无关）：
 *   工具条 bg-layer-3      浅 #4176e6/#fff     4.23:1   深 #679efe/#353638  4.55:1
 *   引用面板 specific-tip  浅 #4176e6/#f5f6f7  3.91:1   深 #679efe/#353638  4.55:1
 * 环的外沿正好压在工具条 1px 的 border-inverted 上，深色下那一侧最保守取 3.79:1，
 * 仍在 3:1 之上。
 */
export const FOCUS_RING_COLOR = 'var(--dsw-alias-state-business-primary, #4176e6)'
const FOCUS_RING = `2px solid ${FOCUS_RING_COLOR}`
/**
 * 正值 = 环画在按钮外面。2px 缝隙 + 2px 环宽 = 4px，正好落在工具条 / 引用面板行
 * 留给按钮的 4px 空隙里，所以环的内外两侧相邻色都是表面色，与按钮填充无关。
 */
const FOCUS_RING_OFFSET = 2

/** SURFACE_FLOATING 的边框色单独拎出来，好在提示条里按 longhand 复用同一个 token（见下）。 */
const FLOATING_BORDER_COLOR = 'var(--dsw-alias-border-inverted, transparent)'

const SURFACE_FLOATING: React.CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-3, #fff)',
  border: `1px solid ${FLOATING_BORDER_COLOR}`,
  boxShadow: SHADOW_LV3,
}

interface InteractiveHandlers {
  readonly onMouseEnter: () => void
  readonly onMouseLeave: () => void
  readonly onMouseDown: (event: React.MouseEvent) => void
  readonly onMouseUp: () => void
  readonly onFocus: (event: React.FocusEvent<HTMLElement>) => void
  readonly onBlur: () => void
}

/**
 * 纯内联样式没有 :hover / :active / :focus-visible，只能用 React state 顶上。
 * 工具条按钮和引用面板的删除按钮共用这一个 hook。
 * `keepSelection` 用于工具条：按下时不能让浏览器清掉 DOM 选区，否则 controller 立刻失效。
 *
 * 焦点环用「这次聚焦不是本元素上的指针按下带来的」判定，而不是 `:focus-visible` ——
 * 对按钮来说两者等价，但它在所有引擎（含 jsdom）里行为一致、可断言。
 */
function useInteractive(keepSelection = false): {
  readonly hovered: boolean
  readonly active: boolean
  readonly focusRing: boolean
  readonly handlers: InteractiveHandlers
} {
  const [hovered, setHovered] = React.useState(false)
  const [active, setActive] = React.useState(false)
  const [focusRing, setFocusRing] = React.useState(false)
  // mousedown → focus → mouseup：聚焦发生在指针按下和抬起之间，所以这个标记够用。
  const pointerDown = React.useRef(false)
  const handlers = React.useMemo<InteractiveHandlers>(() => ({
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => { pointerDown.current = false; setHovered(false); setActive(false) },
    onMouseDown: (event) => {
      if (keepSelection) event.preventDefault()
      pointerDown.current = true
      setActive(true)
    },
    onMouseUp: () => { pointerDown.current = false; setActive(false) },
    onFocus: () => setFocusRing(!pointerDown.current),
    onBlur: () => { setFocusRing(false); setActive(false) },
  }), [keepSelection])
  return { hovered, active, focusRing, handlers }
}

/** 28/14 胶囊，对齐宿主 `.noteSave` / `.noteCancel`。 */
const TOOLBAR_BUTTON_BASE: React.CSSProperties = {
  boxSizing: 'border-box', height: 28, padding: '0 10px', border: 0, borderRadius: 14,
  fontFamily: 'inherit', fontSize: 13, lineHeight: '28px', fontWeight: 500,
  whiteSpace: 'nowrap', outlineOffset: FOCUS_RING_OFFSET,
}

interface ToolbarButtonProps {
  /** primary = 留在当前会话、可撤销；secondary = fork 会话、不可撤销。按后果分，不按能力分。 */
  readonly tone: 'primary' | 'secondary'
  /** 整条工具条在忙：三个按钮一起禁用，并各自把光标声明成 wait。 */
  readonly busy: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}

function ToolbarButton({ tone, busy, onClick, children }: ToolbarButtonProps) {
  const { hovered, active, focusRing, handlers } = useInteractive(true)
  const hot = !busy && (hovered || active)
  // 次按钮静息用 label-secondary 而非宿主 ghost 的 label-tertiary:
  // tertiary 在浅色白浮层上只有 3.71:1，够图标（3:1）不够文字（4.5:1）。
  const background = tone === 'primary'
    ? (hot ? 'var(--dsw-alias-button-primary-hover, #43454a)' : 'var(--dsw-alias-button-primary-fill, #0f1115)')
    : !busy && active
      ? 'var(--dsw-alias-interactive-bg-active, rgba(38,49,72,.1))'
      : hot
        ? 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06))'
        : 'transparent'
  const color = tone === 'primary'
    ? 'var(--dsw-alias-label-primary-foreground, #fff)'
    : hot
      ? 'var(--dsw-alias-label-primary, #0f1115)'
      : 'var(--dsw-alias-label-secondary, #61666b)'
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      {...handlers}
      style={{
        ...TOOLBAR_BUTTON_BASE,
        background,
        color,
        opacity: busy ? 0.4 : 1,
        // 子元素的 cursor 声明压过从容器继承，所以 wait 必须写在按钮自己身上——
        // 只写在 wrapper 上的话，鼠标停在按钮上仍是箭头，wait 只在 4px 缝隙里出现。
        cursor: busy ? 'wait' : 'pointer',
        outline: focusRing ? FOCUS_RING : 'none',
      }}
    >
      {children}
    </button>
  )
}

interface SelectionToolbarProps {
  readonly controller: SelectionController
  readonly onAdd: (selection: ConversationSelection) => SelectionActionResult
  readonly sideChat?: SideChatActions
  readonly t: Translate
}

interface ToolbarNotice {
  readonly message: string
  readonly role: 'status' | 'alert'
}

function sideResultNotice(result: Exclude<SideChatResult, { kind: 'opened' }>, t: Translate): ToolbarNotice {
  if (result.kind === 'cancelled') {
    return { message: t('selection.side.cancelled'), role: 'status' }
  }
  if (result.kind === 'stale-selection') {
    return { message: t('selection.error.stale'), role: 'alert' }
  }
  if (result.kind === 'source-not-visible') {
    return { message: t('selection.side.error.sourceNotVisible'), role: 'alert' }
  }
  if (result.kind === 'partial') {
    return {
      message: t('selection.side.partial', { childId: result.childId }),
      role: 'alert',
    }
  }
  if (result.kind === 'unavailable') {
    return { message: t('selection.side.error.unavailable'), role: 'alert' }
  }
  return { message: t('selection.side.error.failed'), role: 'alert' }
}

/** 控件行高 38px = 4 padding + 28 控件 + 4 padding + 2 border。量到真高之前的兜底值。 */
const TOOLBAR_ROW_HEIGHT = 38
/** 浮层与选区之间、以及与视口左右边缘之间的最小间隙。 */
const TOOLBAR_GAP = 8

export interface SelectionToolbarPlacement {
  readonly top: number
  readonly left: number
  /** true = 上方塞不下，整块翻到选区下方。 */
  readonly below: boolean
}

/**
 * 把浮层**整块**放到选区外面：优先上方，上方不够高就翻到下方。
 *
 * 这是「工具条和提示条都不遮挡被引用的原文」这条不变量的唯一出处。提示条是
 * wrapper 网格里的一行、计入 size.height，所以只要 wrapper 的盒子和选区矩形不相交，
 * 提示条就压不到选区上；旧写法固定 `rect.y - 46`（只够控件行），提示条一出现
 * 就落在选区正上方 2px 处并向下压满整行选区——而 runSide() 每次都会先弹一条
 * pending 提示，等于每次点「更多详情 / 在侧边聊天中提问」都盖住刚选中的文字。
 *
 * 上一轮加了「翻到下方」，但丢了原来的垂直钳制（`main` 上是
 * `top = Math.max(8, rect.y - 42)`），而且下翻的目标位置只由 `rect` 算出，从没
 * 考虑过视口高度：选区比视口还高（顶部滚出视口上沿）时，above 和「下翻后的
 * top」会一起跑到视口外——工具条整块不可见，等于这轮修的「不遮挡选区」换来了
 * 更坏的「用户根本看不见浮层」。
 *
 * 所以这里把视口高度也钳进来，和左右钳制同一形状。两条不变量在选区几乎占满
 * 视口时会冲突（可见 vs 不遮挡选区），这里优先保证**可见**：宁可浮层盖住选区，
 * 也不能让它整块滚出屏幕——用户看不到按钮比按钮贴着选区更糟，前者是「功能
 * 消失」，后者最多是「遮挡」。`viewport.height <= 0` 时（尺寸未知，例如 SSR）
 * 不钳制，含义与左右钳制的 `viewport > 0` 门槛一致。
 */
export function placeSelectionToolbar(
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): SelectionToolbarPlacement {
  const above = rect.y - TOOLBAR_GAP - size.height
  const below = above < TOOLBAR_GAP
  const rawTop = below ? rect.y + rect.height + TOOLBAR_GAP : above
  const top = viewport.height > 0
    ? Math.min(
      Math.max(rawTop, TOOLBAR_GAP),
      Math.max(TOOLBAR_GAP, viewport.height - TOOLBAR_GAP - size.height),
    )
    : rawTop
  // 居中对准选区，但靠近视口左右边缘时夹回来，否则浮层会被裁掉。
  const half = size.width / 2
  const anchored = rect.x + rect.width / 2
  const left = half > 0 && viewport.width > 0
    ? Math.min(
      Math.max(anchored, TOOLBAR_GAP + half),
      Math.max(TOOLBAR_GAP + half, viewport.width - TOOLBAR_GAP - half),
    )
    : anchored
  return { top, left, below }
}

export function SelectionToolbar({ controller, onAdd, sideChat, t }: SelectionToolbarProps) {
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [notice, setNotice] = React.useState<ToolbarNotice | null>(null)
  const [pending, setPending] = React.useState(false)
  const pendingRef = React.useRef(false)
  const wrapper = React.useRef<HTMLDivElement | null>(null)
  const [wrapperSize, setWrapperSize] = React.useState({ width: 0, height: 0 })
  const selection = state.selection
  React.useEffect(() => setNotice(null), [selection])
  // 量实际尺寸：宽度用来把浮层夹回视口内，高度用来把整块放到选区外面。
  // 提示条出现/消失会改变高度 —— useLayoutEffect 在 paint 前跑完，所以修正后的
  // 位置不会闪一帧。尺寸没变时返回同一个对象，React 直接 bail out，不会循环。
  React.useLayoutEffect(() => {
    const node = wrapper.current
    if (node === null) return
    setWrapperSize((current) => (
      current.width === node.offsetWidth && current.height === node.offsetHeight
        ? current
        : { width: node.offsetWidth, height: node.offsetHeight }
    ))
  })
  if (selection === null) return null
  const sideAvailable = sideChat?.available === true
  const runSide = (action: 'more-details' | 'ask-in-side-chat') => {
    if (sideChat === undefined || pendingRef.current) return
    const captured = selection
    pendingRef.current = true
    setPending(true)
    setNotice({ message: t('selection.side.pending'), role: 'status' })
    const request = action === 'more-details'
      ? sideChat.moreDetails(captured)
      : sideChat.askInSideChat(captured)
    void request.then((result) => {
      if (controller.getSnapshot().selection !== captured) return
      if (result.kind === 'opened') {
        controller.clear()
        return
      }
      setNotice(sideResultNotice(result, t))
    }, () => {
      if (controller.getSnapshot().selection === captured) {
        setNotice({ message: t('selection.side.error.failed'), role: 'alert' })
      }
    }).finally(() => {
      pendingRef.current = false
      setPending(false)
    })
  }
  const place = placeSelectionToolbar(
    selection.rect,
    { width: wrapperSize.width, height: wrapperSize.height > 0 ? wrapperSize.height : TOOLBAR_ROW_HEIGHT },
    typeof window === 'undefined'
      ? { width: 0, height: 0 }
      : { width: window.innerWidth, height: window.innerHeight },
  )
  return (
    <div
      data-dsh-selection-toolbar
      ref={wrapper}
      style={{
        // 位移走 transform 而不是 left：`position:fixed` + `left` 会把可用宽度算成
        // 「视口宽 - left」，贴右边缘时按钮行会被压成多行。left:0 时可用宽度是整个视口，
        // 元素仍按内容 shrink-to-fit。
        position: 'fixed', left: 0, top: place.top,
        transform: `translateX(calc(${place.left}px - 50%))`,
        // 宿主的层级（实测 rc.2 产物）：
        //   100/101  菜单列表、气泡、卡片、横幅（普通内容之上的就地浮层）
        //   1000     模态遮罩 Dialog.root、设置遮罩、图片灯箱 backdrop、拖放遮罩 mask
        //   1100     Toast、Menu portal、OnboardingOverlay、MessageFeedback notePanel
        // 选区工具条是就地的上下文操作：要盖住普通内容和就地浮层，但模态/灯箱/拖放
        // 遮罩一旦出现就该压住它，Toast 和菜单也该在它之上。所以取 100 档之上、
        // 1000 档之下。旧值 1100 与宿主最高层并列，谁在上只看 DOM 顺序，还把工具条
        // 顶到了灯箱和拖放遮罩前面。
        zIndex: 900,
        display: 'grid', gap: 6, justifyItems: 'center',
        maxWidth: 'calc(100vw - 16px)',
        // 缝隙（4px padding）也归工具条，所以容器保留 wait；按钮各自再声明一次，
        // 否则子元素自带的 cursor 会压过继承。
        cursor: pending ? 'wait' : undefined,
      }}
    >
      {/* role=group 而非 toolbar: WAI-ARIA 的 toolbar 模式要求方向键 + roving tabindex，
          这里三个按钮是顺序 Tab，group 才是诚实的角色（group 无键盘要求）。 */}
      <div
        role="group"
        aria-label={t('selection.toolbar.label')}
        aria-busy={pending || undefined}
        style={{
          ...SURFACE_FLOATING,
          // 控件行永远贴着选区那一侧：浮层在上方时排在提示条**下面**，翻到下方时排在上面。
          order: place.below ? 0 : 1,
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center',
          gap: 4, padding: 4, borderRadius: 12,
        }}
      >
        <ToolbarButton
          tone="primary"
          busy={pending}
          onClick={() => {
            const result = onAdd(selection)
            if (!result.ok) {
              setNotice({ message: result.message ?? t('selection.error.reference'), role: 'status' })
            }
          }}
        >
          {t('selection.add')}
        </ToolbarButton>
        {sideAvailable && (
          <>
            <div
              aria-hidden
              style={{
                width: 1, alignSelf: 'stretch', margin: '4px 2px',
                background: 'var(--dsw-alias-border-l2, rgba(0,0,0,.1))',
              }}
            />
            <ToolbarButton tone="secondary" busy={pending} onClick={() => runSide('more-details')}>
              {t('selection.moreDetails')}
            </ToolbarButton>
            <ToolbarButton tone="secondary" busy={pending} onClick={() => runSide('ask-in-side-chat')}>
              {t('selection.askInSideChat')}
            </ToolbarButton>
          </>
        )}
      </div>
      {notice !== null && (
        <div
          role={notice.role}
          style={{
            background: SURFACE_FLOATING.background,
            boxShadow: SURFACE_FLOATING.boxShadow,
            // 提示条是 wrapper 网格里的一行，计入高度参与 placeSelectionToolbar 的定位，
            // 所以它跟着整块留在选区外；这里只决定它排在控件行的哪一侧。
            order: place.below ? 1 : 0,
            boxSizing: 'border-box', maxWidth: 320, borderRadius: 8,
            fontSize: 12, lineHeight: '18px',
            // 12px 正文要过 4.5:1。红字 state-error-primary 画在 bg-layer-3 上浅色
            // 4.50:1 刚好压线、深色只有 3.68:1，不达标；所以错误语义交给左侧那道红竖条
            // （非文本，3:1 即可：浅 4.50:1 / 深 3.68:1），文字换成够高对比的中性色：
            //   alert  label-primary    浅 18.90:1  深 11.57:1
            //   status label-secondary  浅  5.80:1  深  8.03:1
            color: notice.role === 'alert'
              ? 'var(--dsw-alias-label-primary, #0f1115)'
              : 'var(--dsw-alias-label-secondary, #61666b)',
            // 边框/内边距不再走 `border` / `padding` 简写 + 单独覆盖
            // borderLeft*/paddingLeft 的写法。这个 div 在 alert ⇄ status 之间是同一个
            // 复用 DOM 节点（同一个树位置，只是 role/文案变了），旧写法里 alert 独有的
            // borderLeftWidth/borderLeftColor/paddingLeft 只在 alert 帧的 style 对象里
            // 出现；React 对 style 是逐 key diff，切回 status 时这三个 key 从「有值」
            // 变成「不在新对象里」，React 会把它们清成 ''——但 `border`/`padding`
            // 简写早在赋值那一刻就展开成了具体的 12 个 longhand，不是持续跟踪的引用，
            // 清空 longhand 不会让简写重新生效，于是 border-left-width 掉回浏览器
            // 初始值 medium、padding-left 掉回 0，而不是简写原本给的 1px / 8px。
            // 修法：四条边框和四个内边距在两种状态下都显式给出数值——不再有任何一帧
            // 会缺席某个 borderLeft*/paddingLeft，React 每次都写入具体值，不会走到
            // "清空回退初始值"这条路径。上/右/下三边和上/右/下内边距两种状态完全一致，
            // 只有左边框宽度/颜色、左内边距随 alert/status 变化。
            borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: FLOATING_BORDER_COLOR,
            borderRightWidth: 1, borderRightStyle: 'solid', borderRightColor: FLOATING_BORDER_COLOR,
            borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: FLOATING_BORDER_COLOR,
            borderLeftWidth: notice.role === 'alert' ? 3 : 1,
            borderLeftStyle: 'solid',
            borderLeftColor: notice.role === 'alert'
              ? 'var(--dsw-alias-state-error-primary, #ec1313)'
              : FLOATING_BORDER_COLOR,
            paddingTop: 4, paddingRight: 8, paddingBottom: 4,
            paddingLeft: notice.role === 'alert' ? 6 : 8,
          }}
        >
          {notice.message}
        </div>
      )}
    </div>
  )
}

/**
 * 只读给屏读的状态说明。视觉上完全不占位，但内容必须是真文本节点 ——
 * `aria-describedby` 指向的元素若被 `display:none` 隐藏就读不出来了。
 */
const VISUALLY_HIDDEN: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, margin: -1, padding: 0,
  overflow: 'hidden', clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)',
  whiteSpace: 'nowrap', border: 0,
}

const NO_ITEMS: readonly SelectionAggregateItem[] = []

/* ── 引用浮层 ───────────────────────────────────────────────────────────────
   composer 上方不再是行列表，只留一枚 chip（`💬 N 条引用`）。引用本体的编辑
   发生在**被引用段落旁边**：折叠态是一枚圆角胶囊，展开态是一张卡片。

   z 轴（自下而上）：897 徽标 / 898 胶囊 / 899 卡片与引用列表 / 900 划词工具条。
   徽标从 899 降到 897 是因为 16px 的蓝点绝不该画在卡片上面；工具条留在 900 是
   因为它是用户当下正在操作的瞬时面（层级考据见上面 SelectionToolbar 的 zIndex
   注释）。三层新浮层都用 0×0 的 `position:fixed` 容器（照 QuoteBadgeLayer 的
   写法），绝不铺满屏幕拦截宿主的指针事件。 */

const Z_QUOTE_CAPSULE = 898
const Z_QUOTE_CARD = 899

const CAPSULE_HEIGHT = 32
const CAPSULE_MAX_WIDTH = 280
const CARD_MIN_WIDTH = 240
const CARD_MAX_WIDTH = 360
/** 量到真高之前的兜底值：textarea 64 + 动作行 28 + 内边距 24 + 间距。 */
const CARD_FALLBACK_HEIGHT = 132
const LIST_FALLBACK_HEIGHT = 160
/** 引用列表最多 240px 高，再多就在列表内部滚动 —— 它是 portal 在 body 上的
 * 浮层，没有"把 composer 顶飞"的问题，但也不该长到盖住整屏对话。 */
const LIST_MAX_HEIGHT = 240
const OVERLAY_EDGE_INSET = 8
/** 悬停徽标多久才浮出胶囊，以及指针离开后多久收起（悬停桥接：从徽标移到胶囊
 * 上的那一小段路不能把胶囊抖掉）。 */
const PEEK_OPEN_MS = 120
const PEEK_CLOSE_MS = 150

/**
 * 胶囊 / 卡片 / 引用列表共用的浮层面。
 *
 * 描边**不用** `SURFACE_FLOATING` 的 `border-inverted`：那个 token 深色合成后
 * 是 `#414244`，对页面 `#151517` 只有 1.81:1（`border-l4` 也只有 2.81:1）。
 * 划词工具条可以那么写，因为它浮在选区上方的空白里；这三层会**压在正文上**，
 * 边界一弱，正文就视觉上糊进浮层。`label-tertiary` 是本文件已有的先例（评论框
 * 静息描边那一段），沿用同一条论证：
 *   描边 / 页面 bg-base   浅 3.71:1   深 8.54:1   （1.4.11 要 3:1）
 *   描边 / 浮层面          浅 3.71:1   深 5.67:1
 * 浅色下所有 `bg-*` 层都是纯白，所以阴影（SHADOW_LV3）与描边两者都要写。
 */
const QUOTE_SURFACE: React.CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-3, #fff)',
  border: '1px solid var(--dsw-alias-label-tertiary, #81858c)',
  boxShadow: SHADOW_LV3,
}

/**
 * 折叠 ⇄ 展开的状态。**同时只允许一个**：两条 200px 宽的浮层必然互相遮挡，
 * 而徽标那种 `avoidTakenBadges` 式的避让对这个尺寸的盒子不成立。
 *
 * `anchor` 在**打开瞬间冻结**，之后即使锚点状态翻转也不换：打字过程中卡片突然
 * 从段落旁跳到 composer 上方，比"卡片指着一个已经滚走的位置"更糟。
 *
 * `baseline` 是上次保存值。「取消」回退到它 —— 不是清空，所以取消最多丢掉本次
 * 编辑会话的增量，永远不会把一条已保存的评论抹成空。
 *
 * ── 状态迁移 ──────────────────────────────────────────────────────────────
 *
 *   'none'    ──openCard──────────────────────────────▶ 'card'
 *   'none'    ──悬停任意徽标/胶囊（peekItemId 生效）────▶（不动，仍是 'none'，
 *                                                          胶囊由 peekItemId 单独驱动）
 *   'capsule' ──openCard──────────────────────────────▶ 'card'
 *   'capsule' ──悬停另一条引用的徽标/胶囊──────────────▶ 'none'（见下）
 *   'card'    ──保存成功 / 取消───────────────────────▶ 'capsule'
 *   'card'    ──保存失败 / 删除失败───────────────────▶ 'card'（原地，带 error）
 *   'card'    ──删除成功──────────────────────────────▶ 'none'
 *   （新增一条引用会直接把 'none'/'capsule' 都改写成新条目的 'capsule'，
 *    见下面 `seen` 那个 effect。）
 *
 * 只有 `removeQuote` 成功那一条路径会显式写 `{kind:'none'}`——这是本轮修复之前
 * 唯一能回到 'none' 的出口。`capsule` 因此是一张**只进不出**的钉子：openItemId
 * 在 `ui.kind !== 'none'` 时恒等于 `ui.itemId`（见下），于是只要用户跟任意一条
 * 引用交互过一次（哪怕只是打开卡片又取消），这枚钉子就再也拔不掉——之后悬停
 * 别的引用的徽标，`hoveredItemId` 照常更新（正文高亮会跟着走），但 `peekItemId`
 * 被 `ui.kind !== 'none'` 这个判据挡在 `openItemId` 公式外面，胶囊纹丝不动。
 *
 * 修法在 `schedulePeek` 里补上第三条退出路径：**悬停到一条不同的引用**时，
 * 如果当前是被钉住的 'capsule'（不是正在编辑的 'card'——那个绝不能被悬停打断），
 * 就把钉子拔回 'none'，让 `peekItemId` 重新接管。拔钉子本身不用等
 * `PEEK_OPEN_MS`：钉子代表的是"上一条引用还留着"，不是"新一条正在被看"，这两件
 * 事没有理由绑在同一个延迟上。
 */
type QuoteAnchorKind = 'quote' | 'chip'

type QuoteUi =
  | { readonly kind: 'none' }
  | { readonly kind: 'capsule'; readonly itemId: string; readonly anchor: QuoteAnchorKind }
  | {
    readonly kind: 'card'
    readonly itemId: string
    readonly anchor: QuoteAnchorKind
    readonly draft: string
    readonly baseline: string
    readonly error: string | null
  }

interface OverlayRect {
  readonly top: number
  readonly bottom: number
  readonly left: number
}

/** 视口本身当作一条带子用（chip 锚定时没有滚动容器可依）。 */
function viewportBand(): QuoteBand {
  const width = typeof window === 'undefined' ? 0 : window.innerWidth
  const height = typeof window === 'undefined' ? 0 : window.innerHeight
  return {
    top: OVERLAY_EDGE_INSET,
    bottom: Math.max(OVERLAY_EDGE_INSET, height - OVERLAY_EDGE_INSET),
    left: OVERLAY_EDGE_INSET,
    right: Math.max(OVERLAY_EDGE_INSET, width - OVERLAY_EDGE_INSET),
  }
}

function clampWidth(band: QuoteBand, min: number, max: number): number {
  const available = band.right - band.left - 32
  if (!(available > 0)) return max
  return Math.max(min, Math.min(max, available))
}

function anchorNote(state: QuoteAnchorState, t: Translate): string {
  // anchored 故意留空串：滚动会让 anchored ⇄ offscreen 频繁翻转，任何提示都会
  // 变成噪音。也正因为如此，承载它的 span 绝不设 aria-live。
  if (state === 'detached') return t('selection.anchor.detached')
  if (state === 'offscreen') return t('selection.anchor.offscreen')
  // 'unmeasured' 说的是「这一帧量不出几何」，不是「滚出视口」——锚点是好的。
  if (state === 'unmeasured') return t('selection.anchor.unmeasured')
  return ''
}

/* ── 卡片里的按钮 ───────────────────────────────────────────────────────── */

interface CardButtonProps {
  readonly tone: 'primary' | 'ghost'
  /** `aria-disabled` 而不是 `disabled`：保持可 Tab 到，屏读用户能听到它存在，
   * 并通过 `aria-describedby` 听到禁用的原因。点击是 no-op。 */
  readonly disabled?: boolean
  readonly label: string
  readonly describedBy?: string
  readonly onClick: () => void
  readonly children: React.ReactNode
}

function CardButton({ tone, disabled = false, label, describedBy, onClick, children }: CardButtonProps) {
  const { hovered, active, focusRing, handlers } = useInteractive()
  const hot = !disabled && (hovered || active)
  // 保存 · 启用   button-primary-fill + label-primary-foreground  浅 18.90:1 深 18.08:1
  // 保存 · 禁用   button-primary-dimmed + label-secondary         浅  4.98:1 深  6.37:1
  //               （禁用态本可豁免 4.5，这一对仍然过）
  // 取消 ghost    label-secondary on 卡面                          浅  5.80:1 深  8.03:1
  const background = tone === 'primary'
    ? disabled
      ? 'var(--dsw-alias-button-primary-dimmed, #ebeef2)'
      : hot
        ? 'var(--dsw-alias-button-primary-hover, #43454a)'
        : 'var(--dsw-alias-button-primary-fill, #0f1115)'
    : active
      ? 'var(--dsw-alias-interactive-bg-active, rgba(38,49,72,.1))'
      : hot
        ? 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06))'
        : 'transparent'
  const color = tone === 'primary'
    ? disabled
      ? 'var(--dsw-alias-label-secondary, #61666b)'
      : 'var(--dsw-alias-label-primary-foreground, #fff)'
    : hot
      ? 'var(--dsw-alias-label-primary, #0f1115)'
      : 'var(--dsw-alias-label-secondary, #61666b)'
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-describedby={describedBy}
      onClick={() => { if (!disabled) onClick() }}
      {...handlers}
      style={{
        ...TOOLBAR_BUTTON_BASE,
        background,
        color,
        // 光标写在按钮自己身上：子元素的 cursor 声明压过从容器继承（见工具条
        // busy cursor 那段教训）。
        cursor: disabled ? 'not-allowed' : 'pointer',
        outline: focusRing ? FOCUS_RING : 'none',
      }}
    >
      {children}
    </button>
  )
}

/** armed 状态多久自动解除。键盘用户可能就停在按钮上不动，armed 不该常驻。 */
const DELETE_ARM_MS = 4000

/**
 * 删除的「按两次」闸门。
 *
 * 为什么是二次确认而不是可撤销的软删除：**这里根本做不出诚实的撤销。**
 * 删最后一条时 `removeSelectionItem` 会把 composer 草稿里那枚引用 token 连同它的
 * 分隔符一起 `consumeSpan` 掉；把它放回去只有 `appendSelectionReference` 一条路，
 * 而那个函数要的是一个**活的 `ConversationSelection`**（带 DOM Range）——
 * detached 的条目根本给不出来，原文行早就不在对话里了。于是「撤销」必然存在
 * 「点了撤销却失败」的路径，那比压根不给撤销更糟：用户以为救回来了，其实没有。
 * 而删除走的是 CAS 改写草稿，不进浏览器的文本 undo 栈，一击即毁。
 *
 * 二次确认的代价则接近零：**静息态与今天逐字节相同**（不加任何常驻装饰、不加
 * 任何新控件），只有按下第一次之后按钮才点亮成 armed。移开指针 / 失焦 /
 * `DELETE_ARM_MS` 之后自动解除，armed 不会跨交互残留。
 *
 * 屏读侧：第一次按下**不再**只挂一个 `aria-pressed`。`aria-pressed`（「已按下」）
 * 描述的是切换按钮的开关状态，套在一个破坏性的一次性动作上是在撒谎——它在
 * 「删除引用 1」这个按钮名上最自然的解读恰恰是「已经删掉了」，与「还没删、
 * 再按一次才删」完全相反，而且切换按钮的默认隐含语义是"再按一次会切回原状"，
 * 这里再按一次却是不可逆的删除，双重误导。改法是调用方把 armed 时的
 * `aria-label` 换成 `dictionaries.ts` 的 `selection.remove.armed`
 * （「再按一次以删除引用 {n}」），并通过 `onArm` 把同一句话送进 live region——
 * 前者覆盖"该元素本来就有焦点、只是还没换焦点"的情形，后者覆盖"多数屏读不会
 * 因为 aria-label 变了就重新朗读一个仍持有焦点的元素"的情形，两条通道都不
 * 依赖 `aria-pressed`，所以这里索性不再渲染它。
 */
function useArmedDelete(onConfirm: () => void, onArm?: () => void): {
  readonly armed: boolean
  readonly press: () => void
  readonly disarm: () => void
} {
  const [armed, setArmed] = React.useState(false)
  const timer = React.useRef(0)
  const stop = React.useCallback(() => {
    if (timer.current !== 0 && typeof window !== 'undefined') window.clearTimeout(timer.current)
    timer.current = 0
  }, [])
  // 卸载时清掉定时器：卡片收起 / Pane 关闭都会走这里。
  React.useEffect(() => stop, [stop])
  const disarm = () => {
    if (!armed) return
    stop()
    setArmed(false)
  }
  const press = () => {
    if (armed) {
      stop()
      setArmed(false)
      onConfirm()
      return
    }
    stop()
    setArmed(true)
    onArm?.()
    if (typeof window === 'undefined') return
    timer.current = window.setTimeout(() => { timer.current = 0; setArmed(false) }, DELETE_ARM_MS)
  }
  return { armed, press, disarm }
}

interface CardIconButtonProps {
  readonly tone: 'danger' | 'plain'
  /** armed 时调用方会换成 `selection.remove.armed`；`aria-pressed` 不用于表达
   * 这个状态（见 `useArmedDelete` 上方注释），颜色/内描边仍然靠 `armed` 变化。 */
  readonly label: string
  readonly disabled?: boolean
  /** 已进入「再按一次就真删」的状态：颜色钉住 danger，再套一圈内描边。 */
  readonly armed?: boolean
  /** 指针移开 / 失焦 —— armed 在这里解除。 */
  readonly onIdle?: () => void
  readonly onClick: () => void
  readonly children: React.ReactNode
}

function CardIconButton({
  tone, label, disabled = false, armed = false, onIdle, onClick, children,
}: CardIconButtonProps) {
  const { hovered, active, focusRing, handlers } = useInteractive()
  const hot = !disabled && (hovered || active || armed)
  // 垃圾桶静息 label-tertiary（图标，3:1 门槛）浅 3.71:1 / 深 5.67:1；
  // hover 换 state-error-primary on interactive-bg-hover-danger 浅 4.50:1 / 深 3.68:1。
  // 「跳到原文」用 label-secondary 浅 5.80:1 / 深 8.03:1。
  const color = disabled
    ? 'var(--dsw-alias-label-tertiary, #81858c)'
    : tone === 'danger'
      ? hot
        ? 'var(--dsw-alias-state-error-primary, #ec1313)'
        : 'var(--dsw-alias-label-tertiary, #81858c)'
      : 'var(--dsw-alias-label-secondary, #61666b)'
  const background = !hot
    ? 'transparent'
    : tone === 'danger'
      ? 'var(--dsw-alias-interactive-bg-hover-danger, rgba(236,19,19,.05))'
      : 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06))'
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onClick={() => { if (!disabled) onClick() }}
      {...handlers}
      onMouseLeave={() => { handlers.onMouseLeave(); onIdle?.() }}
      onBlur={() => { handlers.onBlur(); onIdle?.() }}
      style={{
        display: 'grid', placeItems: 'center', width: 28, height: 28, padding: 0,
        border: 0, borderRadius: 999, background, color,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        // armed 的内描边是非文本指示器（门槛 3:1）。armed ⊂ hot，所以填充这时是
        // danger hover 那块：描边外侧对浮层面 浅 4.50:1 / 深 3.68:1，内侧对填充
        // 浅 4.15:1 / 深 3.11:1，两侧都过。
        boxShadow: armed ? 'inset 0 0 0 1px var(--dsw-alias-state-error-primary, #ec1313)' : undefined,
        outlineOffset: FOCUS_RING_OFFSET,
        outline: focusRing ? FOCUS_RING : 'none',
      }}
    >
      {children}
    </button>
  )
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden focusable="false">
      <path
        d="M3 4h8M5.5 4V2.8h3V4M4.2 4l.5 7h4.6l.5-7"
        fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}

function RevealIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden focusable="false">
      <circle cx="7" cy="7" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M7 1.4v1.6M7 11v1.6M1.4 7H3M11 7h1.6"
        fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"
      />
    </svg>
  )
}

function BubbleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden focusable="false">
      <path
        d="M2 5.4A3.6 3.6 0 0 1 5.6 1.8h1.8A3.6 3.6 0 0 1 11 5.4a3.6 3.6 0 0 1-3.6 3.6H5.1L2.8 10.9V8.6A3.6 3.6 0 0 1 2 5.4Z"
        fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"
      />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden focusable="false">
      <path
        d="M2 2 L10 10 M10 2 L2 10"
        fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      />
    </svg>
  )
}

/* ── 折叠态胶囊 ─────────────────────────────────────────────────────────── */

interface QuoteCapsuleLayerProps {
  readonly ordinal: string
  readonly top: number
  readonly left: number
  readonly width: number
  /** 已保存的评论。空串 = 这条引用还没有评论，只有这时才显示占位符。 */
  readonly comment: string
  readonly placeholder: string
  readonly onOpen: () => void
  readonly onHoverChange: (hovering: boolean) => void
}

/**
 * 浮在被引用段落末行下方的圆角胶囊。
 *
 * 整层 `aria-hidden` + `role="presentation"`，与徽标层同一条论证：它 portal 在
 * `document.body`，屏读会在**完全错误的文档顺序**上读到它。因此里面**没有任何
 * 可聚焦控件** —— aria-hidden 容器里放 `<button>` 会造出「能 Tab 到但读不出来」
 * 的黑洞。键盘的等价路径是 chip → 引用列表 → 卡片，而且它比胶囊更强：
 * offscreen / detached 时胶囊根本不画，列表永远在。
 *
 * **胶囊显示的是评论本身，不是占位符。** 本轮特性的整个目的就是「把批注标在被
 * 引段落旁边」——旧写法把 `selection.comment.placeholder` 写死传进来，于是保存完
 * 评论后段落旁那枚胶囊仍写着「添加可选评论...」，用户必须重新展开卡片才能看到
 * 自己写了什么，等于这轮 UI 的核心目的没有实现。
 *
 * 两种状态的前景色分开（都在 `bg-layer-3` 浮层面上量）：
 *   已保存评论  label-primary    浅 18.90:1  深 11.57:1
 *   占位符      label-secondary  浅  5.80:1  深  8.03:1
 * 13px 正文的门槛是 4.5:1，两者都过；占位符按语义弱一档，但没有弱到不达标。
 * 截断交给 `text-overflow: ellipsis`，完整值挂 `title`（本层对 AT 隐藏，`title`
 * 在这里纯粹是指针悬停的提示，不参与可访问名）。
 */
function QuoteCapsuleLayer({
  ordinal, top, left, width, comment, placeholder, onOpen, onHoverChange,
}: QuoteCapsuleLayerProps) {
  const hasComment = comment !== ''
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      data-dsh-quote-capsule-layer
      aria-hidden="true"
      role="presentation"
      style={{ position: 'fixed', top: 0, left: 0, width: 0, height: 0, zIndex: Z_QUOTE_CAPSULE }}
    >
      <div
        data-dsh-quote-capsule={ordinal}
        onClick={onOpen}
        onMouseEnter={() => onHoverChange(true)}
        onMouseLeave={() => onHoverChange(false)}
        style={{
          ...QUOTE_SURFACE,
          position: 'absolute', top, left, width, height: CAPSULE_HEIGHT,
          boxSizing: 'border-box', borderRadius: 999,
          display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px',
          cursor: 'pointer', userSelect: 'none',
          fontFamily: 'inherit', fontSize: 13, lineHeight: '30px',
          color: 'var(--dsw-alias-label-secondary, #61666b)',
        }}
      >
        {/* 编号徽标就是那个"图标位"。参考产品右边放的是它自己的语音能力，我们
            没有——放个假图标或留个空槽都是在骗用户。徽标反而是胶囊 ↔ 正文 ↔
            引用列表三者之间唯一的连接机制，多条引用挨得近时零成本消歧。 */}
        <QuoteBadge label={ordinal} state="anchored" emphasis={false} />
        <span
          data-dsh-quote-capsule-text={hasComment ? 'comment' : 'placeholder'}
          title={hasComment ? comment : undefined}
          style={{
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            color: hasComment
              ? 'var(--dsw-alias-label-primary, #0f1115)'
              : 'var(--dsw-alias-label-secondary, #61666b)',
          }}
        >
          {hasComment ? comment : placeholder}
        </span>
      </div>
    </div>,
    document.body,
  )
}

/* ── 展开态卡片 ─────────────────────────────────────────────────────────── */

interface QuoteCommentCardProps {
  /** DOM id 的命名空间。**不能用序号**：SelectionDock 是按 session 注册的，双 Pane
   * 下会同时存在两个实例，序号生成的 id 逐字节相同，`aria-describedby` 会解析到
   * 文档里靠前的那一个，把另一个 Pane 的状态读给用户听。 */
  readonly itemId: string
  readonly ordinal: string
  readonly excerpt: string
  readonly stateNote: string
  readonly canReveal: boolean
  readonly draft: string
  readonly baseline: string
  readonly error: string | null
  readonly top: number
  readonly left: number
  readonly width: number
  readonly maxHeight: number
  readonly onDraftChange: (value: string) => void
  /** 保存并收起。返回 false = 提交失败，卡片必须留在原地（父级已经写好错误）。 */
  readonly onCommit: (value: string) => boolean
  readonly onCancel: () => void
  /** 删除并收起。返回 false = 删除失败，卡片必须留在原地（父级已经写好错误）。 */
  readonly onRemove: () => boolean
  /** 删除按钮第一次按下（进入 armed）时报给 dock 级的 live region——「再按一次
   * 以删除」必须在这一刻就说出口，不能等到真删掉才发声（那时已经晚了）。 */
  readonly onAnnounce: (text: string) => void
  readonly onReveal: () => void
  /** 卡片因**卡片内的显式动作**（保存 / 取消 / Esc / 组合键）收起时，把焦点还回
   * 一个合理落点。指针点到外面、focusout 到别的元素这两条路径**不**调用它 ——
   * 那是用户自己在挪焦点。 */
  readonly onRestoreFocus: () => void
  readonly onMeasure: (size: { readonly width: number; readonly height: number }) => void
  readonly t: Translate
}

/**
 * 展开态卡片。
 *
 * **失焦 = 保存。全流程没有任何一条路径会丢弃用户已输入的文字；唯一的丢弃
 * 入口是显式的「取消」按钮，且它只回退到上次保存值。** 三条实现细节，缺一条
 * 就会踩到数据丢失：
 *
 *  1. 用**卡片级 `focusout` + `relatedTarget`** 判「离开整张卡片」，不用
 *     textarea 的 `onBlur`。加了按钮之后，鼠标按在「取消」上会**先**让 textarea
 *     blur —— 旧写法（`input.onBlur → onCommentCommit`）会"先提交再回退"，两次
 *     写 aggregate；第二次撞上 CAS `stale-draft` 时，不想要的文字就永久留在了
 *     草稿里。判据必须是 `!card.contains(relatedTarget)`。
 *  2. `relatedTarget === null` **一律不动作**。窗口失焦、点到不可聚焦的空白都
 *     会给 null。真正的"点了外面"由独立的 capture 阶段 `pointerdown` 负责，
 *     它同样走保存分支。
 *  3. 提交失败**不收起、不清 draft**。`updateSelectionComment` 会返回
 *     `{ok:false, reason:'stale-draft'}`，旧代码只 notify 就算完；卡片必须把
 *     错误显示在自己身上并留住文字。
 *
 * `Esc = 保存并收起`，是本组件唯一一处刻意违反惯例的地方：这张浮层的 Esc 语义
 * 是"从浮层里出来"，而不是"销毁我打的字"。显式的「取消」按钮就在一个 Tab 之外，
 * 把"丢弃"这个动词只留给一个带标签的按钮，比让一个手滑的按键拥有破坏力更符合
 * 本轮的优先级。
 */
function QuoteCommentCard({
  itemId, ordinal, excerpt, stateNote, canReveal, draft, baseline, error,
  top, left, width, maxHeight,
  onDraftChange, onCommit, onCancel, onRemove, onAnnounce, onReveal, onRestoreFocus, onMeasure, t,
}: QuoteCommentCardProps) {
  const card = React.useRef<HTMLDivElement | null>(null)
  const textarea = React.useRef<HTMLTextAreaElement | null>(null)
  const [focusedInput, setFocusedInput] = React.useState(false)
  // 卸载时尽力提交：这几个 ref 让清理函数读到**最后一帧**的值，而不是闭包里
  // 捕获的第一帧。`settled` 由显式的保存成功 / 取消 / 删除置位。
  const settled = React.useRef(false)
  const latest = React.useRef({ draft, baseline })
  latest.current = { draft, baseline }
  const commit = React.useRef(onCommit)
  commit.current = onCommit

  const stateId = `dsh-quote-card-state-${itemId}`
  const saveHintId = `dsh-quote-card-savehint-${itemId}`
  // 「保存」在没有东西可存时弱化：草稿是空的、且此前也没存过评论。反过来，
  // 已存过评论而用户把它清空时按钮**必须可用**——那是"删掉这条评论"的唯一
  // 显式入口。
  const nothingToSave = draft.trim() === '' && baseline === ''

  const finish = (run: () => void) => {
    settled.current = true
    run()
  }
  /**
   * 返回 true = 已落定，卡片可以收起。
   *
   * `settled` 之后一律不再写：显式动作收起卡片后我们会把焦点还给 chip，那次
   * 焦点移动本身会触发卡片的 focusout（relatedTarget 在卡片外）→ 又走到这里。
   * 没有这道闸门就是同一份文字写两遍 aggregate，第二遍撞 CAS 就报假错。
   */
  const save = (): boolean => {
    if (settled.current) return true
    // 提交失败时父级返回 false 并把错误写进卡片：卡片留在原地、文字留住，
    // 所以 settled 不能置位（下一次卸载仍要尽力提交）。
    if (!commit.current(latest.current.draft)) return false
    settled.current = true
    return true
  }
  /**
   * 删除。**删成功了才算落定。**
   *
   * 旧写法是 `finish(onRemove)` —— 在不知道删除成不成功之前就把 `settled` 置了
   * 位。删除失败时（CAS 竞争）父级那边又已经先把卡片收起了，于是卡片卸载 →
   * 卸载清理里的「尽力提交」被 settled 挡掉 → 条目没删掉、用户刚打的字没了。
   * 本文件其它每条失败路径都精心保住了草稿，唯独这条没有。
   */
  const remove = () => { if (onRemove()) settled.current = true }
  const removeGate = useArmedDelete(remove, () => onAnnounce(t('selection.remove.armed', { n: ordinal })))
  const removeLabel = removeGate.armed
    ? t('selection.remove.armed', { n: ordinal })
    : t('selection.remove.aria', { n: ordinal, excerpt })

  React.useEffect(() => {
    const node = textarea.current
    if (node === null) return
    node.focus()
    // 光标置末：接着上次打到哪儿写。
    const end = node.value.length
    try { node.setSelectionRange(end, end) } catch { /* jsdom / 不支持的输入类型 */ }
  }, [])

  // 量真实尺寸交回父级定位。尺寸没变时父级会 bail out，不会循环。
  React.useLayoutEffect(() => {
    const node = card.current
    if (node === null) return
    onMeasure({ width: node.offsetWidth, height: node.offsetHeight })
  })

  // 卡片**外**的 pointerdown（capture 阶段）= 保存并收起。focusout 的
  // relatedTarget 在这条路径上常常是 null（点到不可聚焦的空白），所以两条判据
  // 缺一不可。
  React.useEffect(() => {
    if (typeof document === 'undefined') return
    const onPointerDown = (event: Event) => {
      const target = event.target
      if (target instanceof Node && card.current?.contains(target) === true) return
      save()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  React.useEffect(() => () => {
    if (settled.current) return
    if (latest.current.draft === latest.current.baseline) return
    // 卸载路径（Pane 关闭、会话切换…）：尽力提交，绝不静默丢弃。
    try { commit.current(latest.current.draft) } catch { /* 尽力而为 */ }
  }, [])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      data-dsh-quote-card
      ref={card}
      // 非模态：不做焦点陷阱。用户完全可以在卡片打开时去划另一段文字。
      role="dialog"
      aria-modal="false"
      aria-label={t('selection.card.aria', { n: ordinal, excerpt })}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (next === null) return
        if (next instanceof Node && card.current?.contains(next)) return
        save()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          // stopPropagation：一次 Esc 不该连带收掉宿主的东西。
          event.stopPropagation()
          // 卡片 portal 在 document.body，收起 = 卸载：不还焦点它就掉到 <body>。
          if (save()) onRestoreFocus()
          return
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          if (save()) onRestoreFocus()
        }
        // 裸 Enter 是换行：评论是多行文本，不提交。
      }}
      style={{
        ...QUOTE_SURFACE,
        position: 'fixed', top, left, width, maxHeight,
        boxSizing: 'border-box', borderRadius: 16, padding: 12,
        zIndex: Z_QUOTE_CARD,
        display: 'grid', gap: 8,
      }}
    >
      {/* DOM 顺序 = 视觉顺序：输入 → 删除 → 跳到原文 → 取消 → 保存。 */}
      <textarea
        ref={textarea}
        data-dsh-quote-comment
        // 摘要进 name 而不是 description：它是这个输入框的**身份**，身份属于
        // name，聚焦时立刻朗读。
        aria-label={t('selection.comment.aria', { n: ordinal, excerpt })}
        aria-describedby={stateId}
        value={draft}
        placeholder={t('selection.comment.placeholder')}
        onChange={(event) => onDraftChange(event.target.value)}
        onFocus={() => setFocusedInput(true)}
        onBlur={() => setFocusedInput(false)}
        style={{
          boxSizing: 'border-box', width: '100%', minHeight: 64,
          maxHeight: Math.max(64, maxHeight - 120),
          resize: 'none', padding: '8px 10px', borderRadius: 10,
          // 焦点环内缩：卡片内边距只有 12px，外侧 4px 的环会压到动作行上。
          // 环整条落在输入框自己的填充里，实测 4.23 / 6.86（对 bg-base）。
          outline: focusedInput ? FOCUS_RING : 'none',
          outlineOffset: -FOCUS_RING_OFFSET,
          border: `1px solid ${focusedInput
            ? 'var(--dsw-alias-state-business-primary, #4176e6)'
            : 'var(--dsw-alias-label-tertiary, #81858c)'}`,
          background: 'var(--dsw-alias-bg-base, #fff)',
          color: 'var(--dsw-alias-label-primary, #0f1115)',
          fontFamily: 'inherit', fontSize: 13, lineHeight: '20px',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <CardIconButton
          tone="danger"
          label={removeLabel}
          armed={removeGate.armed}
          onIdle={removeGate.disarm}
          onClick={removeGate.press}
        >
          <TrashIcon />
        </CardIconButton>
        <span style={{ flex: 1 }} />
        <CardIconButton
          tone="plain"
          label={t('selection.reveal.aria', { n: ordinal })}
          disabled={!canReveal}
          onClick={onReveal}
        >
          <RevealIcon />
        </CardIconButton>
        <CardButton
          tone="ghost"
          label={t('selection.comment.cancelAria', { n: ordinal })}
          onClick={() => { finish(onCancel); onRestoreFocus() }}
        >
          {t('selection.comment.cancel')}
        </CardButton>
        <CardButton
          tone="primary"
          disabled={nothingToSave}
          label={t('selection.comment.saveAria', { n: ordinal })}
          describedBy={nothingToSave ? saveHintId : undefined}
          onClick={() => { if (save()) onRestoreFocus() }}
        >
          {t('selection.comment.save')}
        </CardButton>
      </div>
      <span id={stateId} style={VISUALLY_HIDDEN}>{stateNote}</span>
      <span id={saveHintId} style={VISUALLY_HIDDEN}>{t('selection.comment.saveEmpty')}</span>
      {error !== null && (
        <div
          role="alert"
          style={{
            // 12px 正文要过 4.5:1。红字在 bg-layer-3 上浅 4.50 / 深 3.68 不达标，
            // 所以错误语义交给左侧那道红竖条（非文本，3:1），文字用 label-primary
            // （浅 18.90:1 / 深 11.57:1）—— 与工具条提示条同一条论证。
            borderLeft: '3px solid var(--dsw-alias-state-error-primary, #ec1313)',
            paddingLeft: 6,
            fontSize: 12, lineHeight: '18px',
            color: 'var(--dsw-alias-label-primary, #0f1115)',
          }}
        >
          {error}
        </div>
      )}
    </div>,
    document.body,
  )
}

/* ── 引用列表（chip 的 popover） ─────────────────────────────────────────── */

interface QuoteListProps {
  readonly items: readonly SelectionAggregateItem[]
  readonly states: ReadonlyMap<string, QuoteAnchorState>
  /** 打开这份列表的 chip。外部 pointerdown 关列表时**必须**把它排除在外，见下。 */
  readonly anchor: { readonly current: HTMLElement | null }
  readonly top: number
  readonly left: number
  readonly width: number
  readonly onMeasure: (size: { readonly width: number; readonly height: number }) => void
  readonly onEdit: (itemId: string) => void
  readonly onRemove: (itemId: string) => void
  /** 转给每一行的删除闸门：armed 那一刻把「再按一次以删除」送进 dock 的
   * live region（见 `QuoteCommentCard` 同名 prop 的注释）。 */
  readonly onAnnounce: (text: string) => void
  readonly onClose: () => void
  readonly t: Translate
}

/**
 * 原文滚出视口（甚至整行被移除）之后，够到那条引用的**唯一保证路径**。
 *
 * 数据源是 aggregate（草稿里的 JSON），**不是 DOM**：`detached` / `offscreen` /
 * `unmeasured` 三种状态下条目照样在列表里、照样能编辑能删除。删除入口不依赖
 * 锚点活着 —— 这是既有代码就写下的不变量，本轮继承。
 *
 * 永远打开列表，即使只有 1 条：一条代码路径，可预测。
 */
function QuoteList({
  items, states, anchor, top, left, width, onMeasure, onEdit, onRemove, onAnnounce, onClose, t,
}: QuoteListProps) {
  const box = React.useRef<HTMLDivElement | null>(null)
  const first = React.useRef<HTMLButtonElement | null>(null)
  const close = React.useRef(onClose)
  close.current = onClose

  React.useEffect(() => { first.current?.focus() }, [])
  React.useLayoutEffect(() => {
    const node = box.current
    if (node === null) return
    onMeasure({ width: node.offsetWidth, height: node.offsetHeight })
  })
  React.useEffect(() => {
    if (typeof document === 'undefined') return
    const onPointerDown = (event: Event) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (box.current?.contains(target) === true) return
      // **chip 自己排除在外。** 它是 capture 阶段的监听，点 chip 时先跑这里 →
      // `setListOpen(false)`；紧接着 chip 的 click 走 onToggle 读到 `open=false`
      // → 取反成 true → 列表又开回来，`first.current?.focus()` 还把焦点拽回第 1
      // 行。结果是 chip 永远关不掉自己的列表、`aria-expanded` 一直在说谎。
      if (anchor.current?.contains(target) === true) return
      close.current()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [anchor])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      data-dsh-quote-list
      ref={box}
      role="group"
      aria-label={t('selection.list.label')}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        close.current()
      }}
      style={{
        ...QUOTE_SURFACE,
        position: 'fixed', top, left, width,
        boxSizing: 'border-box', borderRadius: 12, padding: 4,
        zIndex: Z_QUOTE_CARD,
        maxHeight: LIST_MAX_HEIGHT, overflowY: 'auto',
        display: 'grid', gap: 2,
      }}
    >
      {items.map((item, index) => (
        <QuoteListRow
          key={item.id}
          ref={index === 0 ? first : undefined}
          ordinal={String(index + 1)}
          item={item}
          state={states.get(item.id) ?? 'detached'}
          onEdit={() => onEdit(item.id)}
          onRemove={() => onRemove(item.id)}
          onAnnounce={onAnnounce}
          t={t}
        />
      ))}
    </div>,
    document.body,
  )
}

interface QuoteListRowProps {
  readonly ordinal: string
  readonly item: SelectionAggregateItem
  readonly state: QuoteAnchorState
  readonly onEdit: () => void
  readonly onRemove: () => void
  readonly onAnnounce: (text: string) => void
  readonly t: Translate
}

const QuoteListRow = React.forwardRef<HTMLButtonElement, QuoteListRowProps>(function QuoteListRow(
  { ordinal, item, state, onEdit, onRemove, onAnnounce, t }, ref,
) {
  const edit = useInteractive()
  const remove = useInteractive()
  const removeGate = useArmedDelete(onRemove, () => onAnnounce(t('selection.remove.armed', { n: ordinal })))
  const excerpt = quoteExcerpt(item.text)
  const comment = item.comment ?? ''
  const stateId = `dsh-quote-state-${item.id}`
  // 可访问名走 aria-labelledby 而不是 aria-label。
  //
  // `aria-label` 会**覆盖**按钮内容，所以旧写法（只有「编辑第 {n} 条引用的评论」）
  // 让按钮里可见的摘要和评论预览对屏读完全不可见 —— 而这份列表按设计是「原文滚出
  // 视口甚至整条消息没了之后唯一的入口」，屏读用户恰恰在这里最需要分辨哪条是哪条：
  // 三个只有序号不同的「编辑…的评论」根本没法选。
  //
  // labelledby 按 id 顺序拼接：动作 + 摘要 + 评论（或"未添加评论"），三段都是既有
  // 文案，不需要新键；徽标那个 `<span>{ordinal}</span>` 不在引用列表里，序号只由
  // 动作那一段说一次，不会读成"1 编辑第 1 条…"。
  const actionId = `dsh-quote-edit-${item.id}`
  const excerptId = `dsh-quote-excerpt-${item.id}`
  const commentId = `dsh-quote-comment-${item.id}`
  const removeLabel = removeGate.armed
    ? t('selection.remove.armed', { n: ordinal })
    : t('selection.remove.aria', { n: ordinal, excerpt })
  return (
    <div
      data-dsh-quote-list-row={item.id}
      style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 4, alignItems: 'center' }}
    >
      <button
        ref={ref}
        type="button"
        aria-labelledby={`${actionId} ${excerptId} ${commentId}`}
        aria-describedby={stateId}
        onClick={onEdit}
        {...edit.handlers}
        style={{
          display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: 8, alignItems: 'center',
          minWidth: 0, minHeight: 32, padding: '4px 8px', border: 0, borderRadius: 8,
          textAlign: 'left', cursor: 'pointer',
          background: edit.active
            ? 'var(--dsw-alias-interactive-bg-active, rgba(38,49,72,.1))'
            : edit.hovered
              ? 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06))'
              : 'transparent',
          fontFamily: 'inherit', fontSize: 13,
          color: 'var(--dsw-alias-label-primary, #0f1115)',
          outlineOffset: -FOCUS_RING_OFFSET,
          outline: edit.focusRing ? FOCUS_RING : 'none',
        }}
      >
        <span id={actionId} style={VISUALLY_HIDDEN}>{t('selection.list.edit', { n: ordinal })}</span>
        <QuoteBadge label={ordinal} state={state} emphasis={false} />
        <span style={{ display: 'grid', gap: 1, minWidth: 0 }}>
          <span id={excerptId} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {excerpt}
          </span>
          <span
            id={commentId}
            style={{
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontSize: 12, lineHeight: '16px',
              color: 'var(--dsw-alias-label-secondary, #61666b)',
            }}
          >
            {/* 复用摘要那半（quoteExcerpt）同一套截断规则：这半走的是
                aria-labelledby，可访问名会把这个 span 的**整段文字**读出来——
                视觉上 text-overflow 只是裁剪显示，DOM 里的原文本从没变短过。
                一条长评论不截断，屏读用户要听完整段才能轮到下一个按钮。 */}
            {comment === '' ? t('selection.comment.empty') : quoteExcerpt(comment)}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label={removeLabel}
        onClick={removeGate.press}
        {...remove.handlers}
        onMouseLeave={() => { remove.handlers.onMouseLeave(); removeGate.disarm() }}
        onBlur={() => { remove.handlers.onBlur(); removeGate.disarm() }}
        style={{
          display: 'grid', placeItems: 'center', width: 24, height: 24, padding: 0,
          border: 0, borderRadius: 999, cursor: 'pointer', outlineOffset: -FOCUS_RING_OFFSET,
          // 三个热态（hover / active / armed）共用 danger 填充，与卡片上的
          // CardIconButton 逐字节同款。**armed 尤其不能用中性的
          // `interactive-bg-active`**：那块填充深色合成后是 #515254，armed 的红色
          // 内描边（#f25a5a）画在它上面只有 2.37:1，低于 1.4.11 对非文本指示器的
          // 3:1；换成 danger 填充（深 #513b3d）后是 3.11:1，浅色侧 4.15:1。
          background: remove.hovered || remove.active || removeGate.armed
            ? 'var(--dsw-alias-interactive-bg-hover-danger, rgba(236,19,19,.05))'
            : 'transparent',
          color: remove.hovered || remove.active || removeGate.armed
            ? 'var(--dsw-alias-state-error-primary, #ec1313)'
            : 'var(--dsw-alias-label-tertiary, #81858c)',
          // armed 的内描边：非文本指示器（3:1）。描边的两侧相邻色都要过：
          // 外侧是浮层面 bg-layer-3（浅 4.50:1 / 深 3.68:1），内侧是上面那块
          // danger 填充（浅 4.15:1 / 深 3.11:1）。
          boxShadow: removeGate.armed
            ? 'inset 0 0 0 1px var(--dsw-alias-state-error-primary, #ec1313)'
            : undefined,
          outline: remove.focusRing ? FOCUS_RING : 'none',
        }}
      >
        <CloseIcon />
      </button>
      <span id={stateId} style={VISUALLY_HIDDEN}>{anchorNote(state, t)}</span>
    </div>
  )
})

/* ── 引用坞 ─────────────────────────────────────────────────────────────── */

interface SelectionDockProps {
  readonly sessionId: string
  readonly session: { readonly sessionId: string }
  readonly input: SelectionInputSnapshot
  readonly updateComment: (itemId: string, comment: string) => SelectionMutationResult
  readonly removeItem: (itemId: string) => SelectionMutationResult
  readonly t: Translate
  /** 测试注入用；生产走 quote-highlight.ts 的模块级单例。 */
  readonly highlights?: QuoteHighlightRegistry
}

export function SelectionDock({
  sessionId, session, input, updateComment, removeItem, t, highlights,
}: SelectionDockProps) {
  const owned = session.sessionId === sessionId ? readSelectionAggregate(input) : null
  const ref = owned?.occurrence.ref
  const items = owned?.aggregate.items ?? NO_ITEMS
  const [ui, setUi] = React.useState<QuoteUi>({ kind: 'none' })
  const [listOpen, setListOpen] = React.useState(false)
  const [announcement, setAnnouncement] = React.useState('')
  // React 的 setState 对基础类型做 Object.is 比较：新值跟当前值逐字节相同时，
  // 直接跳过这次更新——连 live region 的文本节点都不会被碰一下。连续两次保存
  // 同一条引用（编辑→保存→再编辑→再保存）、连续删除总落在同一序号上的条目、
  // 或者"已添加引用 N，共 M 条"在相邻两次操作里凑巧相同，都会踩中这一条：第二次
  // 播报对屏读用户是彻底的静音，而不是"没有变化"（用户确实做了一次新的保存/
  // 删除，只是文案恰好和上一次一样）。
  //
  // 修法：在文本尾部追加一个不可见的零宽空格（U+200B）来强制产生一次真实的
  // DOM 变更。零宽空格主流屏读不朗读，纯粹是"骗过" React/浏览器的 diff，不改变
  // 听感。只在新文本与**当前已经渲染出来的**文本逐字节相同时才加，且只跟当前
  // 值比较（不需要额外的布尔标记）：这样两次相同播报之间会在"纯文本"与
  // "文本+U+200B"之间自然交替，第三次又变回纯文本——不会无限累加零宽字符，
  // 也不需要单独维护一份"上一条播报是什么"的状态。
  //
  // 备选方案（双缓冲两个 live region 轮流写）会让测试和消费方多认一个
  // DOM 节点，且对这里的场景没有额外收益（这个组件只有一处播报出口，不存在
  // "两个播报几乎同时到达、需要各自独立队列"的问题）；追加计数器后缀则会让
  // 屏读把一串数字念给用户听，是明显更差的用户体验。零宽字符交替是两者之间
  // 侵入性最小、且不改变可感知内容的一种。
  const announce = React.useCallback((text: string) => {
    setAnnouncement((current) => (text === current ? `${text}​` : text))
  }, [])
  // 正文徽标的悬停：与"预览胶囊"分开存。徽标一进就点亮强调（即时），胶囊要等
  // PEEK_OPEN_MS 才浮出来（避免鼠标扫过正文时闪一片胶囊）。
  const [hoveredItemId, setHoveredItemId] = React.useState<string | null>(null)
  const [peekItemId, setPeekItemId] = React.useState<string | null>(null)
  const [chipRect, setChipRect] = React.useState<OverlayRect | null>(null)
  const [cardSize, setCardSize] = React.useState({ width: CARD_MAX_WIDTH, height: CARD_FALLBACK_HEIGHT })
  const [listSize, setListSize] = React.useState({ width: CARD_MAX_WIDTH, height: LIST_FALLBACK_HEIGHT })
  const chip = React.useRef<HTMLButtonElement | null>(null)
  const peekTimer = React.useRef(0)
  // 上一帧算出来的卡片落点。锚点这一帧量不出来时卡片**冻结**在这里，而不是
  // 跳走 —— 正在打字的浮层不许因为滚动或重排而移位（设计 §3.3）。
  const frozenCard = React.useRef<{ top: number; left: number } | null>(null)
  // 首次渲染时草稿里已有的条目不算"新增"。
  //
  // `undefined` = 还没定基线（首次渲染）；`new Set()` = 定过基线，只是当时一条
  // 都没有。**两者必须是不同的值。** 旧写法把「0 条」也编码成 `null`，于是
  // `if (previous === null) return` 把 0→1 这个真实的新增整个吞掉：**第一条**
  // 引用没有胶囊（本轮 UI 的主入口）、没有「已添加引用 1，共 1 条」播报，
  // 第二条起才正常。
  const seen = React.useRef<ReadonlySet<string> | undefined>(undefined)

  const openItemId = ui.kind === 'none' ? peekItemId : ui.itemId
  const activeItemId = hoveredItemId ?? openItemId

  // Hook 必须无条件调用 —— `owned === null` 的早退在它之后。空列表会让 registry
  // 收到一次空发布，正好把这个 session 的色带撤掉。
  const anchors = useQuoteAnchors({
    items,
    revision: ref,
    sessionId,
    activeItemId,
    openItemId,
    ownerId: `dsh-workbench.selection-dock:${sessionId}`,
    registry: highlights,
  })

  React.useEffect(() => () => {
    if (peekTimer.current !== 0 && typeof window !== 'undefined') window.clearTimeout(peekTimer.current)
  }, [])

  // 新增一条引用（「添加到对话」成功）→ 直接浮出折叠态胶囊，但**不抢焦点**
  // （焦点留在 composer：用户刚点完按钮多半是要接着打字）。
  React.useEffect(() => {
    const ids = items.map((item) => item.id)
    const previous = seen.current
    seen.current = new Set(ids)
    if (previous === undefined) return
    const added = ids.filter((id) => !previous.has(id))
    if (added.length !== 1) return
    const itemId = added[0]!
    setUi({ kind: 'capsule', itemId, anchor: 'quote' })
    announce(t('selection.announce.added', {
      n: String(ids.indexOf(itemId) + 1), total: String(ids.length),
    }))
  }, [ref])

  // chip 的矩形：只在真要用（列表打开 / 浮层锚在 chip 上）的那段时间里量，
  // 顺带跟随窗口尺寸变化。用完即撤，不留常驻监听。
  const needsChipRect = listOpen || (ui.kind !== 'none' && ui.anchor === 'chip')
  React.useLayoutEffect(() => {
    if (!needsChipRect || typeof window === 'undefined') return
    const measure = () => {
      const node = chip.current
      if (node === null) return
      const rect = node.getBoundingClientRect()
      setChipRect((current) => (
        current !== null && current.top === rect.top && current.bottom === rect.bottom && current.left === rect.left
          ? current
          : { top: rect.top, bottom: rect.bottom, left: rect.left }
      ))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [needsChipRect])

  if (owned === null) return null

  const indexOf = (itemId: string) => items.findIndex((item) => item.id === itemId)
  const itemOf = (itemId: string) => items.find((item) => item.id === itemId)
  const anchorKindFor = (itemId: string): QuoteAnchorKind => (
    anchors.states.get(itemId) === 'anchored' ? 'quote' : 'chip'
  )

  const schedulePeek = (itemId: string | null) => {
    setHoveredItemId(itemId)
    // 悬停到「跟当前钉住的胶囊不同」的另一条引用时先拔钉子：不拔的话
    // openItemId 恒等于 ui.itemId，胶囊追不上鼠标，只有 activeItemId（走
    // hoveredItemId）还在动——正文高亮换了，胶囊没换。只在 'capsule' 时拔，
    // 'card' 打开时绝不能被单纯的悬停打断（状态迁移见 QuoteUi 上方的注释）。
    if (itemId !== null && ui.kind === 'capsule' && ui.itemId !== itemId) {
      setUi({ kind: 'none' })
    }
    if (typeof window === 'undefined') return
    if (peekTimer.current !== 0) window.clearTimeout(peekTimer.current)
    peekTimer.current = window.setTimeout(() => {
      peekTimer.current = 0
      setPeekItemId(itemId)
    }, itemId === null ? PEEK_CLOSE_MS : PEEK_OPEN_MS)
  }

  const reveal = (item: SelectionAggregateItem) => {
    const reducedMotion = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // `highlight: false` 是刻意的：revealNode 默认会往宿主锚点写
    // `data-dsh-nux-reveal` 属性。我们自己的色带已经是视觉反馈，关掉它顺便让
    // 本特性**一个宿主属性都不写**。
    // findAnchor 也换成 findBusinessRow —— 默认那个比 `data-chat-anchor-key`，
    // 而引用身份用的是 `data-chat-flow-key`，混用会滚到别的行。
    void revealNode(item.parentSessionId, item.nodeKey, { highlight: false, reducedMotion }, {
      locateScrollport: () => locateScrollport(focusedPaneScope(item.parentSessionId)),
      findAnchor: (scrollport, nodeKey) => findBusinessRow(scrollport, nodeKey),
      currentSessionId: () => sessionId,
    }).catch(() => {})
  }

  /**
   * 打开卡片。
   *
   * **进到这里时 `ui.kind` 恒不是 `'card'`，所以这里不需要（也绝不该）替上一张
   * 卡片补一次保存。** 这条不变量由两件事共同保证：
   *
   *  - 指针路径：卡片自己在 capture 阶段挂了 `document.pointerdown`，点徽标 /
   *    点 chip 都会**先**触发它 → `commitCard` → `ui` 已经变成 `capsule`，之后
   *    click 才走到这里。
   *  - 键盘路径不存在：徽标是 `aria-hidden` 的 `<span>`（不可聚焦），胶囊里没有
   *    任何 `<button>`，而引用列表在卡片打开时是关着的（下面就 `setListOpen(false)`）。
   *
   * 曾经这里有一段「切换时替旧卡片补写一次」的兜底，删掉了：它不可达，而且一旦
   * 可达就是错的。写完之后 `setUi` 换掉 `itemId` → `QuoteCommentCard` 的
   * `key`（= `ui.itemId`）变化 → 旧卡片卸载 → 卸载清理里 `settled` 仍是 false、
   * `draft !== baseline` 仍成立 → **第二次** `commit.current(draft)`；而那个
   * `commit.current` 是旧渲染帧的 `commitCard` 闭包，成功后会
   * `setUi({kind:'capsule', itemId: 旧id})`，把刚打开的新卡片打回旧条目的胶囊。
   * 见测试 `saves the previous card exactly once when the user switches quotes`。
   */
  const openCard = (itemId: string) => {
    const item = itemOf(itemId)
    if (item === undefined) return
    // 原文还在、只是滚走或量不出来时先滚回去；detached 不 reveal（没有可滚的行）。
    const state = anchors.states.get(itemId)
    if (state === 'offscreen' || state === 'unmeasured') reveal(item)
    if (peekTimer.current !== 0 && typeof window !== 'undefined') window.clearTimeout(peekTimer.current)
    peekTimer.current = 0
    setPeekItemId(null)
    setListOpen(false)
    setUi({
      kind: 'card',
      itemId,
      anchor: anchorKindFor(itemId),
      draft: item.comment ?? '',
      baseline: item.comment ?? '',
      error: null,
    })
  }

  /**
   * 保存并收起。返回 false = 提交失败，卡片留在原地。
   *
   * 每一次 `setUi` 都走函数式更新并**先核对当前打开的还是不是这张卡片**：
   * 卸载路径上 `commit.current` 拿到的是上一帧的 `commitCard` 闭包，而这时 `ui`
   * 可能已经被「新增引用自动浮胶囊」那个 effect 换成了另一条的胶囊。无条件
   * `setUi({kind:'capsule', itemId: 旧id})` 会把刚浮出来的新胶囊打回旧条目 ——
   * 没有数据丢失，但胶囊指着错的那一条。
   */
  const commitCard = (value: string): boolean => {
    if (ui.kind !== 'card') return true
    const { itemId, anchor, baseline } = ui
    const collapse = () => setUi((current) => (
      current.kind === 'card' && current.itemId === itemId
        ? { kind: 'capsule', itemId, anchor }
        : current
    ))
    if (value === baseline) {
      collapse()
      return true
    }
    const result = updateComment(itemId, value)
    if (!result.ok) {
      setUi((current) => (current.kind === 'card' && current.itemId === itemId
        ? { ...current, draft: value, error: failureMessage(result, t) }
        : current))
      return false
    }
    collapse()
    announce(t('selection.announce.saved', { n: String(indexOf(itemId) + 1) }))
    return true
  }

  /**
   * 删除并收起。返回 false = 删除失败。
   *
   * **顺序是刻意的：先看结果，再动 UI。** 旧写法在 `if (!result.ok) return`
   * *之前*就 `setUi({kind:'none'})` + `setListOpen(false)`，于是删除失败时：
   *  - 卡片照样卸载 → 卸载清理的「尽力提交」又被 `finish()` 提前置位的 `settled`
   *    挡掉 → 条目没删掉、用户刚打的评论也没了（本文件其它每条失败路径都精心
   *    保住了草稿，唯独这条没有）；
   *  - 承载焦点的元素（卡片里的垃圾桶 / 列表行的 X）被卸载，焦点掉进 `<body>`
   *    ——成功路径的焦点归还很仔细，失败路径漏了。
   * 现在失败 = 什么都不收：卡片留在原地、草稿留住、错误画在卡片上（与提交失败
   * 同款）；列表路径则保持列表打开、焦点仍在那颗 X 上，错误由 `removeItem`
   * 自己的 `input.notify('error', …)` 报给宿主 composer（与 updateComment 同一
   * 条通道）。
   */
  const removeQuote = (itemId: string): boolean => {
    const ordinal = String(indexOf(itemId) + 1)
    const last = items.length <= 1
    const result = removeItem(itemId)
    if (!result.ok) {
      setUi((current) => (current.kind === 'card' && current.itemId === itemId
        ? { ...current, error: failureMessage(result, t) }
        : current))
      return false
    }
    setUi({ kind: 'none' })
    setPeekItemId(null)
    setListOpen(false)
    announce(t('selection.announce.removed', { n: ordinal }))
    // N 变 0 时这个坞整个消失，焦点不能留在被卸载的 chip 上。
    if (last) locateComposerInput(focusedPaneScope(sessionId))?.focus()
    else chip.current?.focus()
    return true
  }

  const count = String(items.length)
  const openIndex = openItemId === null ? -1 : indexOf(openItemId)
  const openItem = openIndex >= 0 ? items[openIndex]! : null
  const openOrdinal = String(openIndex + 1)
  const openState = openItemId === null ? 'detached' : (anchors.states.get(openItemId) ?? 'detached')
  const band = anchors.openAnchor?.band ?? viewportBand()
  const chipBand = viewportBand()

  // 卡片落点。锚在段落上时用这一帧的几何；量不出来就冻结在上一帧的位置；
  // 一次都没量到过（或锚在 chip 上）才退到 chip 上方。
  let cardPoint: { top: number; left: number } | null = null
  if (ui.kind === 'card' && ui.anchor === 'quote' && anchors.openAnchor !== null) {
    const place = placeQuoteCard(
      anchors.openAnchor, { left: anchors.openAnchor.rowLeft }, cardSize, anchors.openAnchor.band,
    )
    cardPoint = { top: place.top, left: place.left }
    frozenCard.current = cardPoint
  } else if (ui.kind === 'card' && ui.anchor === 'quote' && frozenCard.current !== null) {
    cardPoint = frozenCard.current
  } else if (ui.kind === 'card' && chipRect !== null) {
    const place = placeQuoteCard(chipRect, chipRect, cardSize, chipBand)
    cardPoint = { top: place.top, left: place.left }
  }

  const capsuleWidth = clampWidth(band, 160, CAPSULE_MAX_WIDTH)
  const capsulePoint = anchors.openAnchor === null
    ? null
    : placeQuoteCard(
      anchors.openAnchor,
      { left: anchors.openAnchor.rowLeft },
      { width: capsuleWidth, height: CAPSULE_HEIGHT },
      anchors.openAnchor.band,
    )
  // 未聚焦的胶囊只是预览，不承载未保存内容：锚点滚出可见带就隐藏它。卡片
  // **不**看 inBand —— 正在打字的浮层不许因为滚动而消失。
  const showCapsule = (ui.kind === 'capsule' || (ui.kind === 'none' && peekItemId !== null))
    && anchors.openAnchor !== null
    && anchors.openAnchor.inBand
    && capsulePoint !== null

  const listPoint = chipRect === null
    ? null
    : placeQuoteCard(chipRect, chipRect, listSize, chipBand)

  return (
    <section
      data-dsh-selection-dock
      // 可见计数由 chip 承担；这里把它并进无障碍名，与旧实现一致。
      aria-label={t('selection.dock.labelCount', { count })}
      style={{
        boxSizing: 'border-box', flex: 'none', margin: '0 auto',
        // 与 TodoPanel(order 0) / QueueDock(order 20) 对齐同一根宽度轴，否则 composer 上下文栈会散。
        width: 'calc(100% - var(--dsh-composer-side-clearance, 16px) * 2 - var(--dsh-composer-dock-inset, 8px) * 4)',
        maxWidth: 'calc(var(--dsh-composer-card-max-width, 780px) - var(--dsh-composer-dock-inset, 8px) * 4)',
        display: 'flex', justifyContent: 'flex-start', alignItems: 'center',
        // 焦点环画在 chip 外面（offset 2 + 宽 2），给它 4px 容身之处。
        padding: 4,
      }}
    >
      <QuoteChip
        ref={chip}
        label={t('selection.chip.label', { count })}
        ariaLabel={t('selection.chip.aria', { count })}
        expanded={listOpen}
        onToggle={() => setListOpen((open) => !open)}
      />
      {/* 只播报离散的、用户发起的结果。锚点四态照旧不进 live region：滚动会让
          anchored ⇄ offscreen 高频翻转，任何提示都会变噪音。 */}
      <span data-dsh-quote-announce role="status" aria-live="polite" style={VISUALLY_HIDDEN}>
        {announcement}
      </span>
      {listOpen && listPoint !== null && (
        <QuoteList
          items={items}
          states={anchors.states}
          anchor={chip}
          top={listPoint.top}
          left={listPoint.left}
          width={clampWidth(chipBand, CARD_MIN_WIDTH, CARD_MAX_WIDTH)}
          onMeasure={(size) => setListSize((current) => (
            current.width === size.width && current.height === size.height ? current : size
          ))}
          onEdit={openCard}
          onRemove={removeQuote}
          onAnnounce={announce}
          onClose={() => { setListOpen(false); chip.current?.focus() }}
          t={t}
        />
      )}
      {showCapsule && openItemId !== null && capsulePoint !== null && (
        <QuoteCapsuleLayer
          ordinal={openOrdinal}
          top={capsulePoint.top}
          left={capsulePoint.left}
          width={capsuleWidth}
          comment={openItem?.comment ?? ''}
          placeholder={t('selection.comment.placeholder')}
          onOpen={() => openCard(openItemId)}
          onHoverChange={(hovering) => schedulePeek(hovering ? openItemId : null)}
        />
      )}
      {ui.kind === 'card' && openItem !== null && cardPoint !== null && (
        <QuoteCommentCard
          key={ui.itemId}
          itemId={ui.itemId}
          ordinal={openOrdinal}
          excerpt={quoteExcerpt(openItem.text)}
          stateNote={anchorNote(openState, t)}
          canReveal={openState !== 'detached'}
          draft={ui.draft}
          baseline={ui.baseline}
          error={ui.error}
          top={cardPoint.top}
          left={cardPoint.left}
          width={clampWidth(band, CARD_MIN_WIDTH, CARD_MAX_WIDTH)}
          maxHeight={Math.max(160, band.bottom - band.top - 16)}
          onDraftChange={(value) => setUi((current) => (
            current.kind === 'card' ? { ...current, draft: value } : current
          ))}
          onCommit={commitCard}
          onCancel={() => setUi({ kind: 'capsule', itemId: ui.itemId, anchor: ui.anchor })}
          onRemove={() => removeQuote(ui.itemId)}
          onAnnounce={announce}
          onReveal={() => reveal(openItem)}
          // 焦点落点选 chip：卡片 portal 在 document.body，收起就是卸载。胶囊层
          // 是 aria-hidden 且里面一个可聚焦控件都没有，正文徽标同理；chip 是
          // 「chip → 引用列表 → 卡片」这条键盘路径的起点，而且只要坞还在它就在。
          // removeQuote 与 QuoteList.onClose 早就落在这里 —— 所有收起路径归一。
          onRestoreFocus={() => chip.current?.focus()}
          onMeasure={(size) => setCardSize((current) => (
            current.width === size.width && current.height === size.height ? current : size
          ))}
          t={t}
        />
      )}
      {/* 正文徽标只写 hover 格子：它是纯指针图层，不该有能力清掉别处的强调。 */}
      <QuoteBadgeLayer
        badges={anchors.badges}
        activeItemId={activeItemId}
        onHover={schedulePeek}
        onSelect={openCard}
      />
    </section>
  )
}

interface QuoteChipProps {
  readonly label: string
  readonly ariaLabel: string
  readonly expanded: boolean
  readonly onToggle: () => void
}

/**
 * composer 上方的常驻入口。轮廓式小圆角标签，左对齐。
 *   描边 label-tertiary       浅 3.71:1   深 8.54:1
 *   文字/图标 label-secondary  浅 5.80:1   深 12.11:1
 *
 * 文案说的是「引用」而不是「注释」：aggregate 里每一条都会随消息发出去，其中
 * 可能一条评论都没有——用「注释」配引用数在 0 条评论时是句假话。
 *
 * 它是**键盘可达路径的起点**：chip → 引用列表 → 卡片。徽标仍是 aria-hidden 的
 * `<span>`（不改成按钮），因为 offscreen / detached 时它根本不渲染，而这条路径
 * 在任何锚点状态下都在。
 */
const QuoteChip = React.forwardRef<HTMLButtonElement, QuoteChipProps>(function QuoteChip(
  { label, ariaLabel, expanded, onToggle }, ref,
) {
  const { hovered, active, focusRing, handlers } = useInteractive()
  return (
    <button
      ref={ref}
      type="button"
      data-dsh-quote-chip
      aria-label={ariaLabel}
      aria-expanded={expanded}
      onClick={onToggle}
      {...handlers}
      style={{
        boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', gap: 6,
        height: 26, padding: '0 10px', borderRadius: 13,
        border: '1px solid var(--dsw-alias-label-tertiary, #81858c)',
        background: active
          ? 'var(--dsw-alias-interactive-bg-active, rgba(38,49,72,.1))'
          : hovered
            ? 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06))'
            : 'transparent',
        color: 'var(--dsw-alias-label-secondary, #61666b)',
        fontFamily: 'inherit', fontSize: 12, lineHeight: '24px', whiteSpace: 'nowrap',
        cursor: 'pointer',
        outlineOffset: FOCUS_RING_OFFSET,
        outline: focusRing ? FOCUS_RING : 'none',
      }}
    >
      <BubbleIcon />
      <span>{label}</span>
    </button>
  )
})

/** Register the stock-compatible selection toolbar, codec owner, and aggregate dock. */
export function applySelectionActions(
  ctx: SelectionApplyContext,
  services: SelectionApplyServices,
  t: Translate,
  locale = 'dsh-workbench',
  itemIdFactory: () => string = createSelectionItemId,
): SelectionController {
  const controller = new SelectionController(services.sessions)
  const sideChat = createSideChatActions({
    services: services.harness,
    revalidateSelection: (selection) => controller.revalidate(selection) !== null,
    confirmReplace: () => typeof window !== 'undefined'
      && typeof window.confirm === 'function'
      && window.confirm(t('selection.side.confirmReplace')),
    copy: {
      get referenceBoundary() { return t('selection.side.boundary') },
      get moreDetailsRequest() { return t('selection.side.moreDetailsRequest') },
    },
    insertDraftReference: ({ input, reference, ordinaryDraft }) => {
      if (ordinaryDraft !== '') throw new Error('side-chat ordinary draft must start empty')
      const result = insertSideChatReference(input, reference, t('selection.side.reference.label'))
      if (!result.ok) throw new Error(`side-chat reference insertion failed: ${result.reason}`)
    },
  })
  const onAdd = (selection: ConversationSelection) => addSelectionToConversation(
    controller, services, selection, itemIdFactory(), t,
  )
  // “添加到对话”（路径 3）没有 fork，唯一的语义标记就是这份散文标签，之前
  // 这里调用 createSelectionReferenceSource() 不传参，codec 永远回退到
  // SELECTION_QUOTE_COPY.en——中文宿主也会把 "Quoting from above:" 这类英文
  // 前缀发给模型。另外两条路径（moreDetails / askInSideChat）早已通过下面
  // createSideChatActions() 的 copy 字段接了 t()，这里补上第三条路径，三者
  // 才算真正一致地跟随宿主 locale。
  const quoteCopy: SelectionQuoteCopy = {
    quoteHeading: t('selection.quote.heading'),
    quoteHeadingMultiple: t('selection.quote.headingMultiple'),
    quoteItem: t('selection.quote.item'),
    quoteNote: t('selection.quote.note'),
  }
  ctx.effect(() => () => controller.dispose(), 'dsh-workbench: selection controller')
  // 就地高亮的 `::highlight()` 规则只能来自样式表（没有内联等价物）。注入点
  // 与 navigator.tsx:547 的 reveal-highlight 同形，是既有适配器决策的延伸，
  // 不是新机制；样式表刻意不随 dispose 撤回（模块级 once flag，同 ensureHighlightStyles）。
  ctx.effect(() => {
    ensureQuoteHighlightStyles()
    return () => {}
  }, 'dsh-workbench: quote highlight styles')
  ctx.effect(() => services.inputTriggers.registerSource(createSelectionReferenceSource(quoteCopy)), 'dsh-workbench: selection reference source')
  ctx.effect(() => services.inputTriggers.registerSource(createSideChatReferenceSource()), 'dsh-workbench: side-chat reference source')

  services.slots.inject('shell.overlay', () => services.slots.register({
    name: 'shell.overlay',
    id: 'dsh-workbench.selection-actions',
    label: () => t('selection.toolbar.label'),
    locale,
    inject: () => ({ controller, onAdd, sideChat, t }),
  }, SelectionToolbar))

  services.slots.inject('conversation.input.dock', () => services.slots.register({
    name: 'conversation.input.dock',
    id: 'dsh-workbench.selection-aggregate',
    label: () => t('selection.dock.label'),
    locale,
    order: 10,
    inject: (sessionId: string) => ({
      t,
      updateComment: (itemId: string, comment: string) => {
        const input = inputFor(services, sessionId)
        if (input === null) return { ok: false, reason: 'missing-reference' } satisfies SelectionMutationResult
        const result = updateSelectionComment(input, itemId, comment, t('selection.reference.label'))
        if (!result.ok) input.notify?.('error', failureMessage(result, t))
        return result
      },
      removeItem: (itemId: string) => {
        const input = inputFor(services, sessionId)
        if (input === null) return { ok: false, reason: 'missing-reference' } satisfies SelectionMutationResult
        const result = removeSelectionItem(input, itemId, t('selection.reference.label'))
        if (!result.ok) input.notify?.('error', failureMessage(result, t))
        return result
      },
    }),
  }, SelectionDock))

  return controller
}
