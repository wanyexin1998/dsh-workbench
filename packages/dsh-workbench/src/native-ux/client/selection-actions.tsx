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
  pinQuoteCard, placeQuoteCard, quoteExcerpt,
  type QuoteAnchorState, type QuoteHighlightRegistry,
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
 * 整块 UI 的聚焦语言一致。实测（含 hover 态，因为环已不碰填充，值与填充无关）：
 *   工具条 bg-layer-3      浅 #4176e6/#fff     4.23:1   深 #679efe/#353638  4.55:1
 *   引用面板 specific-tip  浅 #4176e6/#f5f6f7  3.91:1   深 #679efe/#353638  4.55:1
 * 环的外沿正好压在工具条 1px 的 border-inverted 上，深色下那一侧最保守取 3.79:1，
 * 仍在 3:1 之上。
 *
 * 环宽本轮从 2px 收到 1px：用户两次反馈聚焦态"边框重、难看"。1.4.11 只约束
 * "指示器对相邻色 ≥3:1"，没有厚度要求（那是 2.4.13 的 AAA 附加项，本文件其余
 * 部分只做到 AA）——上面几组对比度是纯颜色计算，与环宽无关，所以收到 1px
 * 不用牺牲任何一组数字，仍然全部 ≥3.79:1。
 */
export const FOCUS_RING_COLOR = 'var(--dsw-alias-state-business-primary, #4176e6)'
const FOCUS_RING = `1px solid ${FOCUS_RING_COLOR}`
/**
 * 正值 = 环画在按钮外面。2px 缝隙 + 1px 环宽 = 3px，落在工具条 / 引用面板行
 * 留给按钮的 4px 空隙里（环变细之后留白比之前更松，不影响布局），环的内外
 * 两侧相邻色都是表面色，与按钮填充无关。
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
   发生在**被引用段落旁边**：展开态是一张卡片，收起态是一条批注标签——写着
   用户自己那句话，没写评论就什么都不画。

   z 轴（自下而上）：897 徽标 / 898 批注标签 / 899 卡片与引用列表 / 900 划词工具条。
   徽标从 899 降到 897 是因为 16px 的蓝点绝不该画在卡片上面；工具条留在 900 是
   因为它是用户当下正在操作的瞬时面（层级考据见上面 SelectionToolbar 的 zIndex
   注释）。三层新浮层都用 0×0 的 `position:fixed` 容器（照 QuoteBadgeLayer 的
   写法），绝不铺满屏幕拦截宿主的指针事件。 */

const Z_QUOTE_NOTE = 898
const Z_QUOTE_CARD = 899

const NOTE_HEIGHT = 32
/** 批注标签的宽度**上限**，不再是字面宽度——标签本身按内容用 `width:max-content`
 * 撑开，这个数字只封顶（配合 `clampWidth` 收进可见带），防止长批注横穿屏幕。 */
const NOTE_MAX_WIDTH = 280
const CARD_MIN_WIDTH = 240
const CARD_MAX_WIDTH = 360
/** 删除按钮与保存按钮之间**额外**的间距（叠加在动作行本身的 `gap:4` 之上，
 * 合计 16px）。删除挪到了紧邻保存左侧的位置之后单加的防误触手段之一——见动作行
 * 那段 JSX 注释；不是随手选的数字，是与卡片其余间距同一量级（卡片内边距 12、
 * 评论框内边距 10）的一档，够形成视觉停顿，又不至于让两颗按钮看起来像分属两组。 */
const DELETE_SAVE_GAP = 12

/* ── 评论框的高度 ───────────────────────────────────────────────────────────
   旧写法是固定的 `minHeight: 64`（三行多）：收起态那条标签只有 32px，点开就
   蹦成一张 130px 的卡片。改成「一行起步 → 按真实行数长高 → 到阈值转框内滚动」。
   一行 = 行高 20 + 上下内边距各 8 = 36px（描边已经取消，不再占高），对标签的
   32px 只差 4px——**输入框**不再是一次跳变。卡片整体仍有 chrome（下方
   CARD_CHROME_HEIGHT）：标签 32px → 开卡高度 CARD_FALLBACK_HEIGHT(96)px 依旧是
   一次三倍多的跳变，这里改掉的只是"输入框本身"那一段落差，不是整张卡片。 */
const COMMENT_LINE_HEIGHT = 20
const COMMENT_PADDING_Y = 8
const COMMENT_ONE_LINE = COMMENT_LINE_HEIGHT + COMMENT_PADDING_Y * 2
/** 超过这么多行就在框内滚动，卡片不再往下长。 */
const COMMENT_MAX_LINES = 6
const COMMENT_MAX_HEIGHT = COMMENT_LINE_HEIGHT * COMMENT_MAX_LINES + COMMENT_PADDING_Y * 2
/** 卡片上评论框以外的固定开销：内边距 12×2 + 网格间距 8 + 动作行 28。**不含**
 * 错误提示行——那一行只在提交/删除失败时才出现，预算单独由 `ERROR_ROW_HEIGHT`
 * 记账，按 `error` 是否非空动态并进 `lineCap`（见下方用到它的地方）。 */
const CARD_CHROME_HEIGHT = 60
/** 错误提示行的高度预算：`fontSize:12/lineHeight:18` 的文字行 + `display:grid`
 * 卡片自己的 `gap:8`（这一行是 grid 的第 4 个子项，会再吃一份 gap）。
 * `error !== null` 时必须并进 chrome 预算：卡片的 `maxHeight` 是画在盒子上的
 * CSS 上限，`overflow` 默认 `visible`，超出的内容不会被裁掉、而是直接画到盒子
 * 外面——错误行会压在卡片下方的正文上，读不清。 */
const ERROR_ROW_HEIGHT = 18 + 8
/**
 * **开卡瞬间**的卡片高度（一行评论框 + chrome）—— 不是稳定高度。
 *
 * 它有两个用途，都只发生在"这一刻"：① 首帧、`onMeasure` 量到真高之前的兜底；
 * ② 在开卡那一帧决定卡片朝上还是朝下，之后这个朝向被冻结、不再翻面。
 *
 * 评论框可变高之后，卡片高度每帧都可能变，所以**位置绝不能再是高度的函数**：
 * 落点由 `pinQuoteCard` 钉住朝向原文的那条边（放在下方钉上缘、放在上方钉下缘），
 * 长高的余量由收紧后的 `maxHeight` 吃掉（论证见 quote-highlight.ts 的
 * `pinQuoteCard`）。所以这个兜底值"与稳定高度对不上"**不是 bug** —— 它本来就
 * 只描述开卡那一刻，后续的增高不通过重定位吸收。
 */
const CARD_FALLBACK_HEIGHT = COMMENT_ONE_LINE + CARD_CHROME_HEIGHT
const LIST_FALLBACK_HEIGHT = 160
/** 引用列表最多 240px 高，再多就在列表内部滚动 —— 它是 portal 在 body 上的
 * 浮层，没有"把 composer 顶飞"的问题，但也不该长到盖住整屏对话。 */
const LIST_MAX_HEIGHT = 240
const OVERLAY_EDGE_INSET = 8
/** 悬停徽标多久才浮出批注标签，以及指针离开后多久收起（悬停桥接：从徽标移到
 * 标签上的那一小段路不能把标签抖掉）。 */
const PEEK_OPEN_MS = 120
const PEEK_CLOSE_MS = 150

/**
 * 批注标签 / 卡片 / 引用列表共用的浮层面的描边色：宿主自己那条发丝线。
 *   `border-l2` 合成后 浅 `#E6E6E6` 1.25:1 / 深 `#4D4E50` 2.19:1（对页面底）
 *
 * 上一轮这里是 `label-tertiary`（浅 3.71 / 深 8.54），依据写的是「1.4.11 要
 * 3:1」——**那条 SC 管不到这里**。它只规范 "user interface components and
 * states"，而标签 / 卡片 / 列表是**容器面板**，不是控件；Understanding 还明写：
 * 控件本身有可见内容时不要求画出边界（"a border or other indication of the
 * overall boundary of the hit area is not required"）。所以这条描边从来不是
 * 合规项，只是可读性判断——而它正是用户看到的「边框线太重」：全产品里没有第二
 * 处浮层描边这么黑。
 *
 * 宿主同类物的写法（只读参考 rc.2 产物）：`MessageFeedbackActions` 的
 * `.notePanel` 是宿主自己的消息批注弹层，用 `border-inverted` + `shadow-lv3`，
 * **浅色下那条描边是全透明的**，只剩阴影。这里比它还强一档（真的画了一条
 * 1.25:1 的灰线），足够把浮层从正文里拉开。
 *
 * 阴影替代不了描边，所以两者都要写：`shadow-lv3` 的第一层是
 * `0 0 1px 0 rgba(0,0,0,.2)`，1px 模糊让贴边处 alpha≈0.1，压白之后恰好也是
 * `#E6E6E6` = 1.25:1（blur=0 的理论上限也只有 1.61:1）。而浅色下 `bg-base` 与
 * `bg-layer-1..3` 全是纯白，少了任何一个浮层就糊进正文。
 *
 * 若真机上觉得深色太"飘"，唯一的旋钮是升到 `border-l4`（浅 1.45 / 深 2.81）——
 * 仍然明显比 `label-tertiary` 浅，且同样不涉及任何合规阈值。
 */
const QUOTE_SURFACE_BORDER_COLOR = 'var(--dsw-alias-border-l2, rgba(0,0,0,.1))'

/**
 * 三条边框属性写 longhand，不写 `border` 简写：本文件早有一条教训（见上面提示条
 * 那段长注释）——`border` 简写在赋值那一刻就展开成 12 个具体的 longhand，不是
 * 持续跟踪的引用，跟逐 key diff 的 React 混用会踩出"覆盖一个 longhand 之后简写
 * 整条失效"的坑。这里三个 key 在每一帧都显式给值。
 *
 * **卡片这条边在聚焦前后一个像素、一个色号都不变。** 曾经它在评论框持有焦点时
 * 换成 `label-tertiary`（再往前是框内一道 3px 蓝环），用户两次点名说边框太重；
 * 而 1.4.11 只管**焦点指示器自身对相邻色 ≥3:1**，它没有规定"必须有一条画在
 * 容器上的焦点线"——文本输入框的焦点指示器是**插入符本身**（2.4.7 对文本框的
 * 常规解读），那是浏览器画的、始终可见、且不占任何边框预算。所以这一档不是
 * "放弃了一条合规项"，是把焦点信号交还给它本来的承载者。
 *
 * 与之对照，**按钮那圈 `FOCUS_RING` 一个都没动**：按钮没有插入符，键盘焦点在
 * 它身上时除了这圈环再没有别的可见信号，两者不是同一回事，别顺手一起删。
 *
 * 顺带钉一句给后来人：宿主自己的主 composer 也**一个焦点态都没有**
 * （`.input { outline: none }`，全文件 grep 不到 `focus`）。
 */
const QUOTE_SURFACE: React.CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-3, #fff)',
  borderWidth: 1, borderStyle: 'solid', borderColor: QUOTE_SURFACE_BORDER_COLOR,
  boxShadow: SHADOW_LV3,
}

/**
 * 评论输入区**自己的**边界——不是描边，是背景比卡面深一档（浅色主题）/浅一档
 * （深色主题）。
 *
 * 上一轮把输入框的 `border` 和 `background` 一起清空了，理由是"边界交给卡片
 * 那条发丝线代劳"——但那条线圈的是**整张卡片**，五颗按钮和输入框共用同一条
 * 边，输入框自己没有任何边界。深色下尤其看得出来：卡面 `bg-layer-3`
 * （#353638）与 `background:transparent` 逐字节同色，输入区跟按钮区糊成一整块。
 * 旧一版（清空之前）用的是 `background: bg-base`（深色 #151517），在 #353638
 * 的卡面上是一口挖得出来的"井"——但浅色下 `bg-base` 与 `bg-layer-3` 全是纯白，
 * 那口井在浅色下根本不存在，只解决了深色一侧。
 *
 * 这里换 `color-mix`：往卡面的 `bg-layer-3` 里混一点 `label-primary`（正文色）。
 * 选它不是随手拿一个 token，是因为它在两个主题下天然落在"要挖的方向"两端：
 * 浅色下 `label-primary` 接近黑（#0f1115），混一点会把卡面的纯白轻轻压暗；
 * 深色下 `label-primary` 接近白（对 `bg-layer-3` 是 11.57:1，反推亮度 ≈0.95，
 * 约等于 rgb(249,250,251)），混一点会把卡面的深灰轻轻提亮。同一行代码，两个
 * 主题不用分支，都会得到"比卡面靠近正文色一点点"的效果。
 *
 * 10% 的量是刻意选的——两种背景色的对比度自算如下（这不是 SC 要求的边界，纯粹
 * 可读性判断，所以没有 3:1/4.5:1 那样的阈值，只是拿卡片自己已经被接受的
 * `border-l2` 描边当参照系）：
 *   卡面 → 输入区背景         浅色              深色
 *   #ffffff → ≈#ebebec        1.24:1            —
 *   #353638 → ≈#484a4c        —                 1.34:1
 * 与用户抱怨"太重"的旧描边 `label-tertiary`（浅 3.71:1 / 深 8.54:1）差了一个
 * 量级；也比卡片自己那条已经过关的 `border-l2`（浅 1.25:1 / 深 2.19:1）更轻——
 * 克制，但不再是"没有边界"。
 */
const QUOTE_INPUT_SURFACE =
  'color-mix(in srgb, var(--dsw-alias-bg-layer-3, #fff) 90%, var(--dsw-alias-label-primary, #0f1115) 10%)'

/**
 * 批注标签自己的底——不描边、不投影，靠这道填充把它从原文里托出来。
 *
 * 用户原话「为啥输入完，会有一个小输入框固定在这」，元凶有两个，都在
 * `QUOTE_SURFACE` 身上：那圈 `QUOTE_SURFACE_BORDER_COLOR` 实心描边（键盘/鼠标
 * 用户见过的每一个"可输入"控件都是描边勾出来的矩形），和曾经的定宽（见
 * `QuoteNoteLayer` 调用点，已经改成 `width:max-content`）。形状本来就是徽标+
 * 文字的胶囊、不是矩形，把描边也去掉，两个"像输入框"的信号一起消失。
 *
 * 底色**直接复用** `QUOTE_INPUT_SURFACE` 那道 color-mix 配方（bg-layer-3 混
 * 10% label-primary），不是重新调一个数字：这张标签飘在原文旁边，没有一张
 * "卡面"在它下面，`bg-layer-3` 与页面 `bg-base` 在浅色主题下逐字节相同，直接
 * 借用现成配方就是"比页面深一档/浅一档"，且已经在 `QUOTE_INPUT_SURFACE` 那段
 * 注释里验证过浅色端的数字（下面 1.24:1 与它逐字相同）。
 *
 * 对比度（这不是 1.4.11 要求的边界——标签是容器，不是控件，论证见
 * `QUOTE_SURFACE_BORDER_COLOR` 上方那段——纯粹是可读性判断）：
 *   底 vs 页面 bg-base       浅 1.24:1   深 ≈2.05:1   （旧描边同一用途是
 *                                                     1.25:1 / 2.19:1，同一
 *                                                     量级，不是"没了边界"）
 *   标签文字 label-primary vs 底   浅 15.86:1  深 8.52:1   （13px 门槛 4.5:1，
 *                                                     旧底 bg-layer-3 是
 *                                                     18.90/11.57，换底后
 *                                                     仍留足余量）
 *
 * 换底之后，画在这张底上的 `QuoteBadge` 自己那圈 1px 描边（对表面 3:1 的
 * 1.4.11 判据）也要重新过一遍——它原来是照 `bg-layer-3` 算的
 * （quote-overlay.tsx 那张四表面表格里的"标签"行）：
 *   浅 4.87:1（原 5.80）   深 5.91:1（原 8.03）
 * 两个都仍在 3:1 之上，只是余量变薄；这张标签自己不做 hover/pressed 背景变化
 * （不是可交互控件，只有 `cursor:pointer` 和 `title`），所以只有静息一档，
 * quote-overlay.tsx 里那张表格已经同步拆出这一行。
 */
const QUOTE_NOTE_SURFACE: React.CSSProperties = {
  background: QUOTE_INPUT_SURFACE,
}

/**
 * 折叠 ⇄ 展开的状态。**同时只允许一个**：两条 200px 宽的浮层必然互相遮挡，
 * 而徽标那种 `avoidTakenBadges` 式的避让对这个尺寸的盒子不成立。
 *
 * `anchor` 在**打开瞬间冻结**（只有 'card' 需要它：批注标签永远只画在段落旁，
 * 没有 chip 兜底那条分支），之后即使锚点状态翻转也不换：打字过程中卡片突然从
 * 段落旁跳到 composer 上方，比"卡片指着一个已经滚走的位置"更糟。
 *
 * `baseline` 是上次保存值——不是清空。「取消」已经删除（所有退出路径现在都是
 * 保存），但 `baseline` 没有跟着变成死字段：`commitCard` 用它判断"这次真的
 * 改了吗"（`value === baseline` 时跳过一次没意义的 aggregate 写入，只做收起态
 * 判定），卸载时的"尽力提交"也拿它跟 `draft` 比对同一件事。两处都与"取消"无关，
 * 纯粹是"有没有变化"的判据。
 *
 * **收起态只有 'none'：卡片关掉之后，段落旁一个常驻的盒子都不留。** 用户原话
 * 「划词输入，保存后，不应该在划词的下面还停有一个小框，只应该出现在主输入框上
 * 的引用，在划词附近会遮挡其他内容」——常驻浮层的落点由 `placeQuoteCard` 算在
 * 段落末行的正下方，那里通常正是下一段正文，盖住的是用户真正在读的东西。
 *
 * 批注没有因此变得看不见，只是换了三个不遮挡的出口：composer 上那枚 chip 展开的
 * 引用列表（每行都读得到评论正文）、正文里那枚 16px 数字徽标（点开即编辑）、以及
 * 悬停徽标时**临时**浮出的那条标签（`peekItemId` 驱动，指针移开即收）。
 * **"悬停时浮出"与"保存后停住"是两件事，被否掉的只有后者。**
 *
 * ── 状态迁移 ──────────────────────────────────────────────────────────────
 *
 *   'none'  ──openCard（徽标 / 引用列表 / 悬停浮出的标签）─▶ 'card'
 *   'none'  ──悬停一条**有评论**的引用（peekItemId 生效）──▶（不动，仍是 'none'，
 *                                                       标签由 peekItemId 单独驱动）
 *   'card'  ──保存成功 / 关闭 / 删除成功──────────────────▶ 'none'
 *   'card'  ──保存失败 / 删除失败────────────────────────▶ 'card'（原地，带 error）
 *   （新增一条引用会把任何状态直接改写成新条目的 'card'，焦点落进输入框，见下面
 *    `seen` 那个 effect —— 这是 'card' 除 `openCard` 之外唯一的生产者。）
 *
 * 这条线走过四版，写下来免得再绕回去：① 一律收成一枚定宽空胶囊 → 用户读成
 * 「输入框关不掉」；② 一律收成 'none' → 写好的批注在段落旁看不见；③ 有评论就钉
 * 一条写着那句话的标签 → 标签仍然压着下一段正文；④ 就是现在这版。①③ 共同的错处
 * 是**把"能看到批注"这件事交给一个常驻浮层**，② 的错处是把出口一起砍了。现在
 * 出口有三个（列表 / 徽标 / 悬停），常驻浮层零个。
 *
 * 因为收起态不再钉任何东西，`schedulePeek` 也就不需要"拔钉子"分支了：`peekItemId`
 * 是段落旁那条标签的**唯一**驱动源，悬停切到另一条引用时它自己就会跟过去。
 */
type QuoteAnchorKind = 'quote' | 'chip'

type QuoteUi =
  | { readonly kind: 'none' }
  | {
    readonly kind: 'card'
    readonly itemId: string
    readonly anchor: QuoteAnchorKind
    readonly draft: string
    readonly baseline: string
    readonly error: string | null
  }

/**
 * 悬停时到底浮不浮出那条批注标签，全产品只有这一个判据（渲染闸门 `showNote`）。
 * 收起态本身不再看它——卡片关掉一律收成 'none'，与这条引用有没有评论无关
 * （论证见 `QuoteUi` 上方的状态迁移表）。
 *
 * 只有空白字符的评论等同于没写：`updateSelectionComment` 存的是原样字符串
 * （`comment.length > 0 ? comment : undefined`，不 trim），而一条只画着空白的
 * 标签除了占位没有任何信息——与「没有评论就什么都不留」是同一条理由。
 */
function hasNote(comment: string): boolean {
  return comment.trim() !== ''
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
  // ghost 态目前没有调用点（原来的「取消」按钮已删除）——`tone` 仍留着两个值，
  // 这颗按钮眼下只以 primary 态出现，数字留作这条分支复活时的参照：
  // ghost      label-secondary on 卡面                             浅  5.80:1 深  8.03:1
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

interface CardIconButtonProps {
  readonly tone: 'danger' | 'plain'
  readonly label: string
  /** 指针悬停提示（原生 `title`）。可选——只有可访问名本身不够直白、需要额外
   * 给指针用户一句话时才传（目前只有右上角那颗关闭按钮用到，见调用点注释）。 */
  readonly title?: string
  readonly disabled?: boolean
  /** 焦点环画在按钮**内侧**而不是外侧。默认（外侧，`outlineOffset:+2`）只对
   * 卡片 chrome 里有余量的按钮成立；右上角那颗关闭按钮贴着卡片 16px 的圆角，
   * 外环的直角外沿会画到圆角描边之外的空白里（见调用点注释与 QuoteList 里
   * `outlineOffset: -FOCUS_RING_OFFSET` 那个同款先例）。 */
  readonly insetFocusRing?: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}

function CardIconButton({
  tone, label, title, disabled = false, insetFocusRing = false, onClick, children,
}: CardIconButtonProps) {
  const { hovered, active, focusRing, handlers } = useInteractive()
  const hot = !disabled && (hovered || active)
  // 垃圾桶静息 label-tertiary（图标，3:1 门槛）浅 3.71:1 / 深 5.67:1；
  // hover 换 state-error-primary on interactive-bg-hover-danger 浅 4.50:1 / 深 3.68:1。
  // plain 态（右上角关闭按钮）用 label-secondary 浅 5.80:1 / 深 8.03:1。
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
      title={title}
      aria-disabled={disabled || undefined}
      onClick={() => { if (!disabled) onClick() }}
      {...handlers}
      style={{
        display: 'grid', placeItems: 'center', width: 28, height: 28, padding: 0,
        border: 0, borderRadius: 999, background, color,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        outlineOffset: insetFocusRing ? -FOCUS_RING_OFFSET : FOCUS_RING_OFFSET,
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

/* ── 收起态批注标签 ─────────────────────────────────────────────────────── */

interface QuoteNoteLayerProps {
  readonly ordinal: string
  readonly top: number
  readonly left: number
  /** 宽度**上限**，不是字面宽度——标签自己按内容用 `width:max-content` 撑开，
   * 短批注不再留一截空白。调用方拿去算 `left`（`placeQuoteCard` 的
   * `size.width`）时仍然当成"这条标签可能有多宽"的保守估计：真实渲染宽度只会
   * 更窄（不会更宽，因为 CSS `max-width` 封了顶），而 `placeQuoteCard` 只在
   * 靠近带子右缘时才用它把 `left` 往左夹——用上限算出的 `left` 因此永远不会让
   * 一个更窄的真实盒子越出带子，只会在盒子本来就没那么宽时，右边多留一点点
   * 用不上的夹算余量，纯视觉上无感。 */
  readonly maxWidth: number
  /** 用户写下的那句话。**调用方保证非空**（`hasNote`）——没有评论时整层不渲染，
   * 所以这里没有、也不该有任何占位符分支。 */
  readonly note: string
  readonly onOpen: () => void
  readonly onHoverChange: (hovering: boolean) => void
}

/**
 * 浮在被引用段落末行下方的批注标签：一条**已经写好的**评论贴在它所属的段落旁。
 *
 * **它是标签，不是输入框。** 上一版这里是一枚写着「添加可选评论...」的折叠胶囊：
 * 长得像输入框、却必须再点一次才能打字。用户的原话是「图 1 那个小输入框的意义
 * 是什么呢，用户的动作应该是划词 - 点击添加到对话 - 输入文字」——所以占位符那条
 * 分支连同它服务的那次点击一起删掉了：想打字的人在「添加到对话」之后**已经**
 * 站在展开的卡片里（见 `seen` 那个 effect），而这里只剩「把写好的批注展示在
 * 原文旁边」这一个职责。没有评论时整条标签不画（渲染闸门在 `showNote`）。
 *
 * 整层 `aria-hidden` + `role="presentation"`，与徽标层同一条论证：它 portal 在
 * `document.body`，屏读会在**完全错误的文档顺序**上读到它。因此里面**没有任何
 * 可聚焦控件** —— aria-hidden 容器里放 `<button>` 会造出「能 Tab 到但读不出来」
 * 的黑洞。键盘的等价路径是 chip → 引用列表 → 卡片，而且它比标签更强：
 * offscreen / detached 时标签根本不画，列表永远在（评论正文也在列表行里读得到，
 * 见 `QuoteListRow` 的 `aria-labelledby`）。
 *
 * 前景色 `label-primary`（在批注标签自己的底 `QUOTE_NOTE_SURFACE` 上 浅
 * 15.86:1 / 深 8.52:1）：这是用户自己写的正文，13px 的门槛 4.5:1 远远过关。
 * 截断交给 `text-overflow: ellipsis`，完整值挂 `title`（本层对 AT 隐藏，
 * `title` 在这里纯粹是指针悬停的提示，不参与可访问名）。
 *
 * **宽度按内容收缩，不再定宽。** 用户对着截图问的原话是「为啥输入完，会有一个
 * 小输入框固定在这」——盒子本身定宽是这句话的另一半元凶（另一半是描边，见
 * `QUOTE_NOTE_SURFACE`）：短批注撑不满那个宽度，视觉上就是一段空白，跟一个
 * "等着被打字"的输入框长得一模一样。`width:max-content` 让盒子跟着 `note`
 * 这段真实文字走，`maxWidth` 只负责在批注很长时封顶，不许它横穿屏幕。
 *
 * flex 容器里 `width:max-content` 单独用不够：子元素默认的 `min-width:auto`
 * 会按自己的内容撑到底，长批注撞上 `maxWidth` 那道顶时，文字 span 会被这条
 * 默认值挡住、不肯收缩，`overflow:hidden` + `text-overflow:ellipsis` 就形同
 * 虚设——盒子被 `maxWidth` 卡死之后，文字反而会溢出圆角画到盒子外面。下面文字
 * span 上的 `minWidth: 0` 就是解这个的：允许它缩到比自身内容还窄，ellipsis
 * 才有地方生效。
 */
function QuoteNoteLayer({ ordinal, top, left, maxWidth, note, onOpen, onHoverChange }: QuoteNoteLayerProps) {
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      data-dsh-quote-note-layer
      aria-hidden="true"
      role="presentation"
      style={{ position: 'fixed', top: 0, left: 0, width: 0, height: 0, zIndex: Z_QUOTE_NOTE }}
    >
      <div
        data-dsh-quote-note={ordinal}
        title={note}
        onClick={onOpen}
        onMouseEnter={() => onHoverChange(true)}
        onMouseLeave={() => onHoverChange(false)}
        style={{
          ...QUOTE_NOTE_SURFACE,
          position: 'absolute', top, left, width: 'max-content', maxWidth, height: NOTE_HEIGHT,
          boxSizing: 'border-box', borderRadius: 999,
          display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px',
          cursor: 'pointer', userSelect: 'none',
          fontFamily: 'inherit', fontSize: 13, lineHeight: '30px',
          color: 'var(--dsw-alias-label-primary, #0f1115)',
        }}
      >
        {/* 编号徽标就是那个"图标位"。参考产品右边放的是它自己的语音能力，我们
            没有——放个假图标或留个空槽都是在骗用户。徽标反而是标签 ↔ 正文 ↔
            引用列表三者之间唯一的连接机制，多条引用挨得近时零成本消歧。 */}
        <QuoteBadge label={ordinal} state="anchored" emphasis={false} />
        <span
          data-dsh-quote-note-text
          // minWidth: 0 —— 见上面函数级注释那段 flex 收缩的坑：没有它，长批注
          // 撞上 maxWidth 时这个 span 会拒绝缩到比自身文字还窄，ellipsis 生效
          // 不了，文字会溢出标签的圆角画到盒子外面。
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
        >
          {note}
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
  /** 删除并收起。返回 false = 删除失败，卡片必须留在原地（父级已经写好错误）。 */
  readonly onRemove: () => boolean
  /** 卡片因**卡片内的显式动作**（保存 / Esc / 组合键）收起时，把焦点还回
   * 一个合理落点。指针点到外面、focusout 到别的元素这两条路径**不**调用它 ——
   * 那是用户自己在挪焦点。 */
  readonly onRestoreFocus: () => void
  readonly onMeasure: (size: { readonly width: number; readonly height: number }) => void
  readonly t: Translate
}

/**
 * 展开态卡片。
 *
 * **失焦 = 保存，也是现在唯一的退出结果：没有任何路径会丢弃用户已输入的文字。**
 * 「取消」按钮已经删除——上一版它是唯一的丢弃入口，且只回退到上次保存值；删掉
 * 之后失焦 / 点外面 / 关闭 X / Esc / 保存这些出口字面意义上全部收敛成同一件事，
 * 语义反而更简单：不再需要区分"这条路径保存、那条路径丢弃"。三条实现细节，
 * 缺一条就会踩到数据丢失：
 *
 *  1. 用**卡片级 `focusout` + `relatedTarget`** 判「离开整张卡片」，不用
 *     textarea 的 `onBlur`。卡片内任何按钮被点击时，鼠标按下都会**先**让
 *     textarea blur —— 若直接用 `input.onBlur → onCommentCommit`，紧接着按钮
 *     自己的 onClick 又会再提交一次，两次写 aggregate；第二次撞上 CAS
 *     `stale-draft` 时，不想要的文字就永久留在了草稿里。判据必须是
 *     `!card.contains(relatedTarget)`——按钮在卡片内，这次 blur 什么都不做。
 *  2. `relatedTarget === null` **一律不动作**。窗口失焦、点到不可聚焦的空白都
 *     会给 null。真正的"点了外面"由独立的 capture 阶段 `pointerdown` 负责，
 *     它同样走保存分支。
 *  3. 提交失败**不收起、不清 draft**。`updateSelectionComment` 会返回
 *     `{ok:false, reason:'stale-draft'}`，旧代码只 notify 就算完；卡片必须把
 *     错误显示在自己身上并留住文字。
 *
 * `Esc = 保存并收起`：不少界面里 Esc 约定俗成地表示"放弃刚才的改动"，这里仍然
 * 刻意选择让它跟其它退出路径一致——保存。这不是遗漏了一条丢弃路径，是本轮
 * 拍板删掉的：防数据丢失优先于"给手滑一个后悔药"。
 */
function QuoteCommentCard({
  itemId, ordinal, excerpt, stateNote, draft, baseline, error,
  top, left, width, maxHeight,
  onDraftChange, onCommit, onRemove, onRestoreFocus, onMeasure, t,
}: QuoteCommentCardProps) {
  const card = React.useRef<HTMLDivElement | null>(null)
  const textarea = React.useRef<HTMLTextAreaElement | null>(null)
  // 卸载时尽力提交：这几个 ref 让清理函数读到**最后一帧**的值，而不是闭包里
  // 捕获的第一帧。`settled` 由显式的保存成功 / 删除置位。
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
   * 旧写法在不知道删除成不成功之前就把 `settled` 置了位。删除失败时（CAS
   * 竞争）父级那边又已经先把卡片收起了，于是卡片卸载 →
   * 卸载清理里的「尽力提交」被 settled 挡掉 → 条目没删掉、用户刚打的字没了。
   * 本文件其它每条失败路径都精心保住了草稿，唯独这条没有。
   *
   * **单击立即删除，不再二次确认。** 上一轮加过「按两次才删」（`useArmedDelete`），
   * 用户实测后反馈这个交互是错的：第一次按下只点亮一圈内描边，视觉上跟"聚焦了"
   * 完全撞脸，被读成"已经点开了"而不是"再按一次才真删"；可访问性验证在屏读侧
   * 发现过同源问题——`aria-pressed` 套在删除按钮上会被念成"已按下"=已经删了。
   * 视觉与屏读两侧都读反了，说明这个表达本身就不对，不是哪一侧没做好。而它要
   * 保护的场景本来就选错了对象：误删代价很低（原文还在对话里，重新划一次词就
   * 能再加回来），真正不可逆的只有 detached 条目（原文行已经不在对话里，见上面
   * `appendSelectionReference` 那条论证），而那是少数情形——为了防住少数情形，
   * 让**每一次**删除都变成两步，不划算。
   */
  const remove = () => { if (onRemove()) settled.current = true }
  const removeLabel = t('selection.remove.aria', { n: ordinal, excerpt })

  // 评论框的高度上限：6 行封顶，且不许把卡片撑出可见带（`maxHeight` 已经是
  // `pinQuoteCard` 收紧过的、这个朝向上的剩余空间）。至少留一行。有错误提示行
  // 时预算里再扣掉它的高度——否则输入框会占满 `maxHeight - CARD_CHROME_HEIGHT`，
  // 错误行没有余量可用，只能画到卡片盒子外面（见 `ERROR_ROW_HEIGHT` 的注释）。
  const lineCap = Math.max(
    COMMENT_ONE_LINE,
    Math.min(COMMENT_MAX_HEIGHT, maxHeight - CARD_CHROME_HEIGHT - (error !== null ? ERROR_ROW_HEIGHT : 0)),
  )

  React.useEffect(() => {
    const node = textarea.current
    if (node === null) return
    node.focus()
    // 光标置末：接着上次打到哪儿写。
    const end = node.value.length
    try { node.setSelectionRange(end, end) } catch { /* jsdom / 不支持的输入类型 */ }
  }, [])

  /**
   * 按真实行数定高。**必须声明在下面 `onMeasure` 那个 layout effect 之前** ——
   * 同一组件内的 layout effect 按声明顺序执行，输入框先定好高，卡片才量得到真高。
   *
   * 用 `scrollHeight` 回写，不用 CSS `field-sizing: content`：后者 2026-06-16 才
   * 进 Baseline newly available（Chrome/Edge 123+、Firefox 152+、Safari 26.2+），
   * 而本产品是本机起服务、用**系统默认浏览器**打开，没有可控的浏览器下限 ——
   * Safari 18 / Firefox 140 上会静默退回固定高度，用户抱怨的症状原样保留。等它
   * widely available（预计 2028-12）之后，这一整段可以换成两行 CSS。
   *
   * 也不用宿主 composer 那套隐藏 mirror div：它需要 mirror 是因为还要在下面叠一层
   * backdrop 画 @-引用高亮，我们没有那一层，mirror 是纯成本。
   *
   * 不加防抖：高度只在**换行数变化**时才真的变（不是每个字符），而防抖会让输入框
   * 已经长高、卡片还停在旧尺寸，反而看得见一次追赶。
   */
  React.useLayoutEffect(() => {
    const node = textarea.current
    if (node === null) return
    // 先归零再读 scrollHeight：否则删字时 scrollHeight 恒等于当前高度，只涨不落。
    node.style.height = '0px'
    node.style.height = `${Math.min(Math.max(node.scrollHeight, COMMENT_ONE_LINE), lineCap)}px`
  }, [draft, lineCap])

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
        // 边框整条来自 QUOTE_SURFACE，聚焦前后不做任何变化——这张卡片没有"聚焦
        // 态"（论证见 QUOTE_SURFACE 上方那段：焦点信号是输入框自己的插入符）。
        ...QUOTE_SURFACE,
        // `position:fixed` 本身就是绝对定位子元素的包含块，右上角那颗 X 直接
        // 落在这个 padding box 里，不需要再写 position:relative。
        position: 'fixed', top, left, width, maxHeight,
        boxSizing: 'border-box', borderRadius: 16, padding: 12,
        zIndex: Z_QUOTE_CARD,
        display: 'grid', gap: 8,
      }}
    >
      {/* DOM 顺序（= Tab 顺序）：输入 → 关闭 → 删除 → 保存。「跳到原文」和「取消」
          两颗按钮已经删除——动作行现在只剩删除和保存，DOM 顺序与视觉顺序
          （删除紧邻保存左侧）逐字一致，不再需要额外论证。
          唯一还留着的不一致是关闭 X：它是绝对定位在卡片右上角的（见下面
          `top:4,right:4` 那个 div），视觉上比输入框的正文更早入眼；这里保证的
          只是键盘可达性（从输入框一次 Tab 就到 X），不是"DOM 先后 = 屏幕先后"。
          这条不一致的实害很低（X 的位置符合"关闭按钮在右上角"的通用直觉，
          键盘用户也不依赖视觉顺序），所以没有为了让两者字面一致而去改 DOM
          顺序或断开当前这条更符合操作直觉的 Tab 路径。 */}
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
        style={{
          // height 由上面那个 layout effect 直接写在 node.style 上（React 只 diff
          // 它自己给过的 key，从没给过 height 就不会去清它）。这里不写 minHeight：
          // 一行的下限已经由那段 `Math.max(scrollHeight, COMMENT_ONE_LINE)` 保证。
          boxSizing: 'border-box',
          // 右侧给右上角那颗 X 让位：**收窄整个盒子**，不是加大 padding-right。
          // 两者对文字的效果一样，但滚动条画在**边框盒的右内缘**上、padding 推不动
          // 它 —— 超过 6 行开始滚动之后，那条滚动条会正好画在 X 底下。
          // 24 = 28（按钮宽）+ 4（按钮距卡片内边距）− 12（卡片内边距）+ 4（留缝）。
          width: 'calc(100% - 24px)',
          // 自动增高与手动拖拽会互相打架，所以 resize 保持关闭（宿主 composer
          // 同款）；到 lineCap 之后转框内滚动。
          resize: 'none', overflowY: 'auto',
          padding: `${COMMENT_PADDING_Y}px 10px`,
          borderRadius: 10,
          // **框内不留描边、不留焦点环，卡片外沿也不再跟着换色**——聚焦信号只剩
          // 插入符本身（论证见 QUOTE_SURFACE 上方那段），这一段与宿主
          // `ui-primitives/Input.module.css` 的
          // `.input { border:none; outline:none }` 同款。但**静息态的边界不再
          // 完全交给卡片那条发丝线**——那条线圈的是整张卡片（五颗按钮 + 输入框
          // 共用），输入框自己需要一点自身的边界，交给背景（`QUOTE_INPUT_SURFACE`，
          // 论证与对比度见该常量上方的注释），不是重新描一条边。
          borderWidth: 0, borderStyle: 'none',
          outline: 'none', background: QUOTE_INPUT_SURFACE,
          color: 'var(--dsw-alias-label-primary, #0f1115)',
          fontFamily: 'inherit', fontSize: 13, lineHeight: `${COMMENT_LINE_HEIGHT}px`,
        }}
      />
      {/* 关闭 = 「点外面」的可见形态：**保存并收起**，不是丢弃。它不带来新语义，
          带来的是可发现性与键盘可达性——"点外面"对键盘用户根本不存在，Esc 存在
          但不可见。可访问名里写死「并保存」，堵住"卡片上同时有『保存』按钮，X
          必然是丢弃"这条最自然的误读（见 dictionaries.ts 该键的注释——同一段
          文案现在也直接当 `title` 用，指针用户悬停就看得到同一句话，不用另开
          一个键）。产品决定见 dictionaries.ts：X 保持"保存并收起"的语义不变，
          只把可访问名改写成不再是 `saveAria` 的子串。 */}
      <div style={{ position: 'absolute', top: 4, right: 4 }}>
        <CardIconButton
          tone="plain"
          label={t('selection.comment.closeAria', { n: ordinal })}
          title={t('selection.comment.closeAria', { n: ordinal })}
          // 贴着卡片 16px 的圆角（这颗 div 离卡片上/右边缘只有 4px）：外侧焦点环
          // （默认 outlineOffset:+2）的外沿会正好落在卡片 padding box 的直角
          // 顶点上，被圆角描边"切掉"一块、画到圆角之外的空白里。改内环——与
          // QuoteList 那两颗贴边按钮（`outlineOffset: -FOCUS_RING_OFFSET`）同款
          // 先例，环缩进按钮自己的 28×28 圆里，不再触到卡片的圆角。
          insetFocusRing
          onClick={() => { if (save()) onRestoreFocus() }}
        >
          <CloseIcon />
        </CardIconButton>
      </div>
      {/* 动作行现在只剩两颗按钮：删除、保存。「跳到原文」（✧，卡片上本来就贴着
          被引段落浮着，这颗按钮在这里基本冗余）与「取消」（移除后所有出口都变成
          保存，见上面 QuoteCommentCard 顶部的论证）都已删除。
          删除挪到了原来「取消」的位置——紧邻保存左侧——但删除刚从"按两次"改回
          "单击立即执行"，两个变化叠加会明显推高误触概率，所以这里没有照搬旧的
          `gap:4`：`DELETE_SAVE_GAP` 在它与保存之间单开一段明显更宽的间距，删除
          维持**图标态**而不是文字按钮（视觉体量天然更小），hover/active 也仍是
          单独的危险色（见 CardIconButton 里 tone="danger" 的对比度注释）——三层
          加在一起把"手滑点错"的概率往下压，同时不引入产品已经否决过的二次确认。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ flex: 1 }} />
        <CardIconButton
          tone="danger"
          label={removeLabel}
          onClick={remove}
        >
          <TrashIcon />
        </CardIconButton>
        <span aria-hidden style={{ width: DELETE_SAVE_GAP }} />
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
  items, states, anchor, top, left, width, onMeasure, onEdit, onRemove, onClose, t,
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
  readonly t: Translate
}

const QuoteListRow = React.forwardRef<HTMLButtonElement, QuoteListRowProps>(function QuoteListRow(
  { ordinal, item, state, onEdit, onRemove, t }, ref,
) {
  const edit = useInteractive()
  const remove = useInteractive()
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
  const removeLabel = t('selection.remove.aria', { n: ordinal, excerpt })
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
        onClick={onRemove}
        {...remove.handlers}
        style={{
          display: 'grid', placeItems: 'center', width: 24, height: 24, padding: 0,
          border: 0, borderRadius: 999, cursor: 'pointer', outlineOffset: -FOCUS_RING_OFFSET,
          background: remove.hovered || remove.active
            ? 'var(--dsw-alias-interactive-bg-hover-danger, rgba(236,19,19,.05))'
            : 'transparent',
          color: remove.hovered || remove.active
            ? 'var(--dsw-alias-state-error-primary, #ec1313)'
            : 'var(--dsw-alias-label-tertiary, #81858c)',
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
  /**
   * 消费一次「这个 itemId 确实是用户刚点『添加到对话』真实新增的」证据。
   *
   * 由 `applySelectionActions` 在 `onAdd` 成功之后记一笔（sessionId → 新
   * itemId），这里传下来的就是"查这笔账、命中就划掉"的读写口子。返回
   * `true` = 命中且已经消费掉（下一次同一个 itemId 不会再被认成新增）；
   * `false` = 没有这笔账，这一帧的"items 多了一条"不能采信为用户意图。
   *
   * 不传（生产之外的裸渲染 / 老测试）时下面的 `seen` effect 一律当作
   * "没有证据"处理——宁可不开卡，也不要在没证据的时候瞎猜。
   */
  readonly consumeAddSignal?: (itemId: string) => boolean
}

export function SelectionDock({
  sessionId, session, input, updateComment, removeItem, t, highlights, consumeAddSignal,
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
  // 正文徽标的悬停：与"预览批注"分开存。徽标一进就点亮强调（即时），标签要等
  // PEEK_OPEN_MS 才浮出来（避免鼠标扫过正文时闪一片标签）。
  const [hoveredItemId, setHoveredItemId] = React.useState<string | null>(null)
  const [peekItemId, setPeekItemId] = React.useState<string | null>(null)
  const [chipRect, setChipRect] = React.useState<OverlayRect | null>(null)
  const [cardSize, setCardSize] = React.useState({ width: CARD_MAX_WIDTH, height: CARD_FALLBACK_HEIGHT })
  const [listSize, setListSize] = React.useState({ width: CARD_MAX_WIDTH, height: LIST_FALLBACK_HEIGHT })
  const chip = React.useRef<HTMLButtonElement | null>(null)
  const peekTimer = React.useRef(0)
  // 上一帧算出来的卡片落点。锚点这一帧量不出来时卡片**冻结**在这里，而不是
  // 跳走 —— 正在打字的浮层不许因为滚动或重排而移位（设计 §3.3）。
  const frozenCard = React.useRef<{ top: number; left: number; maxHeight: number } | null>(null)
  // 卡片朝上还是朝下，在开卡后的第一帧定死（`openCard` 每次把它清空）。评论框
  // 可变高之后，翻面判据绝不能再每帧重跑——否则打到某一行卡片会突然跳到原文上方。
  const frozenFacing = React.useRef<{ itemId: string; above: boolean } | null>(null)
  // 首次渲染时草稿里已有的条目不算"新增"。
  //
  // `undefined` = 还没定基线（首次渲染）；`new Set()` = 定过基线，只是当时一条
  // 都没有。**两者必须是不同的值。** 旧写法把「0 条」也编码成 `null`，于是
  // `if (previous === null) return` 把 0→1 这个真实的新增整个吞掉：**第一条**
  // 引用不开卡（本轮 UI 的主入口）、没有「已添加引用 1，共 1 条」播报，
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

  /**
   * 整个坞被 `owned === null` 收掉的那一帧**不是卸载**：组件还在树上，上面那个
   * 卸载清理不会跑，徽标层与标签层只是从渲染结果里消失了——浏览器不会为"没被
   * 卸载、只是不再渲染"的元素补发 `mouseleave`，所以 `schedulePeek(null)` 永远
   * 不会被调用，`peekItemId` 这个闩就这么留在原位。等聚合回来（撤销/重做把
   * composer 里的引用 token 抹掉又写回、ref 一帧解码失败、切走再切回同一个
   * session——`seen` 那个 effect 上方的注释把这些都列成"真的会发生"），标签就
   * 凭空重新挂回段落下方，中间指针一次都没动过。
   *
   * 与 `schedulePeek` 里那道闸门同一条道理：闩只能由真实的指针动作置位。这一帧
   * 里连"被悬停的那个东西"都不在页面上了，意图必须跟着作废。
   */
  const blanked = owned === null
  React.useEffect(() => {
    if (!blanked) return
    if (peekTimer.current !== 0 && typeof window !== 'undefined') window.clearTimeout(peekTimer.current)
    peekTimer.current = 0
    setPeekItemId(null)
    setHoveredItemId(null)
  }, [blanked])

  /**
   * 新增一条引用（「添加到对话」成功）→ **直接展开卡片**，焦点由卡片自己的
   * mount effect 放进输入框。
   *
   * 上一版浮的是折叠胶囊、并且刻意不抢焦点，于是用户想写批注必须再点一次那枚
   * 胶囊——用户原话：「图 1 那个小输入框的意义是什么呢，用户的动作应该是划词 -
   * 点击添加到对话 - 输入文字，现在输入文字前用户还多一步点击」。这里删掉的正是
   * 那一次点击。
   *
   * **这不会打断 composer 里正在输入的内容。** `addSelectionToConversation` 在
   * 插入引用之后调 `controller.focusSourceComposer()`（焦点回到来源 Pane 的
   * composer），紧接着这个 effect 把焦点交给评论框——移动焦点不改动任何草稿文本，
   * 而且这条路径的触发者是用户**用鼠标点了工具条按钮**，那一刻 composer 里不可能
   * 有正在进行的击键或输入法组词。`focusSourceComposer` 也仍然必须留着：锚点
   * 解析不出几何（detached / unmeasured）时卡片根本不会渲染，那时它就是唯一的
   * 焦点落点。
   *
   * `anchor: 'quote'` 是刻意的（不查 `anchors.states`）：这一帧 `useQuoteAnchors`
   * 的解析 effect 还没为新条目跑过，查出来必然是 `undefined` → 会被判成 'chip'，
   * 把一张本该贴着原文的卡片钉到 chip 上方去。
   *
   * 首帧 `openAnchor` 恒为 null（量测 layout effect 还没为新的 `openItemId` 跑过），
   * 所以这一帧画在哪儿由兜底链决定，两种情况都不会画到**别的引用**旁边：
   *   · 常态（这次会话还没开过引用列表）：`chipRect` 是 null，`frozenCard` 也刚被
   *     下面清空 → `cardPoint` 为 null，卡片**干脆不渲染**，等下一帧真几何到位再
   *     一次性画出来。宁可晚一帧，也不要先闪在错的位置上。
   *   · 开过引用列表：`chipRect` 还留着 → 这一帧落到既有的 chip 兜底上（卡片出现
   *     在 chip 上方），下一帧回到原文旁。朝向**不会**被这一帧冻结——那道闸门
   *     （`quoteAnchor !== null || ui.anchor === 'chip'`）正是为这种帧写的。
   *
   * **"items 比上一帧多了一条" 本身不是用户意图的证据，必须再核对
   * `consumeAddSignal`。** `items` 来自 `readSelectionAggregate(input)`，它在
   * `occurrences.length !== 1` 或 ref 解码失败时返回 `null`（→ `items` 变成
   * `NO_ITEMS`，即空数组）。于是任何一帧的短暂空档都会在下一帧被单纯的集合差
   * 误读成"用户点了添加到对话"：composer 撤销/重做把引用 token 抹掉又还原、
   * 草稿里瞬间出现 2 个 occurrence、ref 解码短暂失败、`session.sessionId` 与
   * `sessionId` 有一帧不等（会话切走再切回）——这些情形里 `seen.current` 都会
   * 先被写成空集合，条目"重新出现"时纯集合差会把它算成新增，开一张不该开的
   * 卡片，卡片 mount 时的 `node.focus()` 还会把插入符从用户正在写的 composer
   * 里拽走。
   *
   * 真正的证据是 `applySelectionActions` 里的 `onAdd`：它在
   * `addSelectionToConversation` 成功之后，把 `(sessionId, 新 itemId)` 记一笔
   * 待认领的账，`consumeAddSignal(itemId)` 就是查这笔账、命中即消费（一次性，
   * 防止同一个 id 被后续巧合的空档复用）。集合差只用来算出"新增的是哪一个
   * id"，不再单独作为"要不要开卡"的判据——两者都成立才开卡。
   */
  React.useEffect(() => {
    const ids = items.map((item) => item.id)
    const previous = seen.current
    seen.current = new Set(ids)
    if (previous === undefined) return
    const added = ids.filter((id) => !previous.has(id))
    if (added.length !== 1) return
    const itemId = added[0]!
    if (consumeAddSignal?.(itemId) !== true) return
    if (peekTimer.current !== 0 && typeof window !== 'undefined') window.clearTimeout(peekTimer.current)
    peekTimer.current = 0
    // 开卡前把上一张卡片留下的两个冻结值清干净——不清的话首帧会用**别的条目**的
    // 落点/朝向画一帧（`openCard` 里同款，论证见那里）。
    frozenCard.current = null
    frozenFacing.current = null
    setPeekItemId(null)
    setListOpen(false)
    // 刚添加的条目一定还没有评论，draft/baseline 都是空串。
    setUi({ kind: 'card', itemId, anchor: 'quote', draft: '', baseline: '', error: null })
    announce(t('selection.announce.added', {
      n: String(ids.indexOf(itemId) + 1), total: String(ids.length),
    }))
  }, [ref])

  // chip 的矩形：只在真要用（列表打开 / 任意卡片开着）的那段时间里量，顺带
  // 跟随窗口尺寸变化。用完即撤，不留常驻监听。批注标签不在这条清单里：它只画
  // 在段落旁（几何全部来自 `anchors.openAnchor`），没有 chip 兜底。
  //
  // **任意卡片**（不再局限于 `ui.anchor === 'chip'`）：`anchor:'quote'` 的卡片
  // 量不出真几何时，下面 `cardPoint` 那段本来就有一条「退到 chipRect」的兜底
  // 分支（quoteAnchor === null 时看 chipRect），只是旧版只在"列表打开过"或
  // "锚本来就是 chip" 时才量 chipRect —— 本次会话第一次开卡（比如"添加到
  // 对话"之后直接开卡，见下面 `seen` 那个 effect）时列表还没开过，chipRect
  // 恰好是 null，兜底链条断在最后一环：真几何量不出来 + chipRect 也是 null
  // → `cardPoint` 整个是 null → 卡片干脆不渲染。用户点了"添加到对话"，
  // 什么反馈都没有。
  //
  // 选择「卡片锚到 chip」而不是「播报一句提示」：前者复用的正是下面
  // `cardPoint` 里那条早就写好、也早就考虑过朝向判据（above 恒为 false，见
  // "freezes the card facing…" 那条测试的注释）的兜底路径，只需要把测量门槛
  // 打开，不用再新开一条"提示用户去点徽标/chip"的旁路；后者对着一个视觉上
  // 什么都没发生的界面播报，屏读用户能听到，但更大多数的指针用户还是会
  // 觉得"点了没反应"。宁可卡片先贴着 chip 显示、下一帧量到真几何再跳过去，
  // 也不留一次完全无声的点击。
  const needsChipRect = listOpen || ui.kind === 'card'
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
    // 这里曾经有一段「拔钉子」：收起态会把某条引用钉成 'note'，悬停到另一条时
    // 得先把钉子拔掉，否则 openItemId 恒等于 ui.itemId，标签追不上鼠标。收起态
    // 改成一律 'none' 之后（论证见 QuoteUi 上方），peekItemId 成了标签的唯一
    // 驱动源，悬停切换自己就会跟过去，那段分支连同它要修的 bug 一起没有了。
    if (typeof window === 'undefined') return
    if (peekTimer.current !== 0) window.clearTimeout(peekTimer.current)
    peekTimer.current = 0
    /**
     * **卡片开着的时候绝不给悬停上膛。** 这一条不是防御性编程，是用户那句抱怨
     * 的另一条通路：`peekItemId` 是个闩，只有后续的指针事件能把它拨开。旧写法
     * 里悬停在卡片打开期间照样计时、照样置位，只是被 `showNote` 的
     * `ui.kind === 'none'` 挡着看不见；等 `collapseCard` 把 ui 收成 'none' 的
     * 那一刻闸门放开，标签就**凭空**挂到段落下方——指针一步没动，用户也没有做
     * 任何"悬停"的动作，画面上就是「保存后划词下面停了一个小框」。
     *
     * 现实里踩中它一点也不刁钻：新增引用会自动开卡并把焦点放进输入框，用户打完
     * 字顺手把鼠标搁在那枚徽标上（它就在被引段落旁边），再用键盘 Esc / Ctrl+Enter
     * 保存——三步全是正常操作。
     *
     * 所以上膛的前提收紧成「此刻什么都没开」，并且顺手把闩拨回去：卡片开着期间
     * 攒下的悬停意图一律作废，不留到关卡之后。指针真的还停在徽标上的话，用户挪
     * 开再回来就会重新触发 —— 一次真实的悬停动作换一次浮出，这才是这层的语义。
     *
     * `itemId === null`（收起）不受此限：关标签在任何状态下都该照常走。
     */
    if (itemId !== null && ui.kind !== 'none') {
      setPeekItemId(null)
      return
    }
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
   *    点 chip 都会**先**触发它 → `commitCard` → `ui` 已经收成了 `none`，之后
   *    click 才走到这里。
   *  - 键盘路径不存在：徽标是 `aria-hidden` 的 `<span>`（不可聚焦），批注标签里
   *    没有任何 `<button>`，而引用列表在卡片打开时是关着的（下面就
   *    `setListOpen(false)`）。
   *
   * 曾经这里有一段「切换时替旧卡片补写一次」的兜底，删掉了：它不可达，而且一旦
   * 可达就是错的。写完之后 `setUi` 换掉 `itemId` → `QuoteCommentCard` 的
   * `key`（= `ui.itemId`）变化 → 旧卡片卸载 → 卸载清理里 `settled` 仍是 false、
   * `draft !== baseline` 仍成立 → **第二次** `commit.current(draft)`；而那个
   * `commit.current` 是旧渲染帧的 `commitCard` 闭包，成功后会
   * `setUi({kind:'note', itemId: 旧id})`，把刚打开的新卡片打回旧条目的标签。
   * 见测试 `saves the previous card exactly once when the user switches quotes`。
   *
   * `draft` 用 `item.comment` 重建：评论在失焦那一刻就已经写进草稿聚合（那才是
   * 「临时暂存」的真身——存在 composer 草稿里，随草稿走、随草稿清空而消失、发送
   * 后随消息消费），所以"点别处收起 → 点数字徽标重新打开"这条来回不丢字。
   */
  const openCard = (itemId: string) => {
    const item = itemOf(itemId)
    if (item === undefined) return
    // 原文还在、只是滚走或量不出来时先滚回去；detached 不 reveal（没有可滚的行）。
    const state = anchors.states.get(itemId)
    if (state === 'offscreen' || state === 'unmeasured') reveal(item)
    if (peekTimer.current !== 0 && typeof window !== 'undefined') window.clearTimeout(peekTimer.current)
    peekTimer.current = 0
    // 朝向只在开卡后的第一帧算，所以每次开卡都要把上一次的冻结值丢掉 ——
    // 同一条引用先后两次打开，两次的原文位置可能已经不同了。
    //
    // `frozenCard` 同理，而且它更凶：它是**上一张卡片**（很可能是别的条目）的
    // 落点，而开卡后的第一帧 `anchors.openAnchor` 恒为 null（量测 layout effect
    // 还没为新的 `openItemId` 跑过）——那一帧的 `frozen` 分支会拿着旧条目的坐标
    // 把新卡片画出来，下一帧真几何到位再跳过去。清掉之后这一帧要么落到 chip
    // 兜底（列表路径，chipRect 已量过），要么干脆不渲染（徽标/标签路径），
    // 都不会出现"先在别的引用旁边闪一下"。
    frozenCard.current = null
    frozenFacing.current = null
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
   * 收起卡片：**一律落到 'none'**，段落旁不留任何常驻浮层。与用户点的是保存、
   * 关闭还是外面无关，也与这条引用有没有评论无关（论证见 `QuoteUi` 上方的状态
   * 迁移表）。写好的批注仍然能从 chip 的引用列表读到、悬停徽标时浮出、点徽标
   * 重新编辑。
   *
   * 走函数式更新并**先核对当前打开的还是不是这张卡片**：卸载路径上
   * `commit.current` 拿到的是上一帧的 `commitCard` 闭包，而这时 `ui` 可能已经被
   * 「新增引用直接开卡」那个 effect 换成了另一条的卡片。无条件 `setUi` 会把刚
   * 打开的那张新卡片顶掉 —— 没有数据丢失，但用户刚添加的那条引用旁边就不是
   * 他正在编辑的东西了。
   */
  const collapseCard = (itemId: string) => setUi((current) => (
    current.kind === 'card' && current.itemId === itemId
      ? { kind: 'none' }
      : current
  ))

  /** 保存并收起。返回 false = 提交失败，卡片留在原地。 */
  const commitCard = (value: string): boolean => {
    if (ui.kind !== 'card') return true
    const { itemId, baseline } = ui
    if (value === baseline) {
      // 没改过：跳过一次没意义的 aggregate 写入，直接收起。
      collapseCard(itemId)
      return true
    }
    const result = updateComment(itemId, value)
    if (!result.ok) {
      setUi((current) => (current.kind === 'card' && current.itemId === itemId
        ? { ...current, draft: value, error: failureMessage(result, t) }
        : current))
      return false
    }
    collapseCard(itemId)
    announce(t('selection.announce.saved', { n: String(indexOf(itemId) + 1) }))
    return true
  }

  /**
   * 删除并收起。返回 false = 删除失败。
   *
   * **顺序是刻意的：先看结果，再动 UI。** 旧写法在 `if (!result.ok) return`
   * *之前*就 `setUi({kind:'none'})` + `setListOpen(false)`，于是删除失败时：
   *  - 卡片照样卸载 → 卸载清理的「尽力提交」又被提前置位的 `settled` 挡掉 →
   *    条目没删掉、用户刚打的评论也没了（本文件其它每条失败路径都精心保住了
   *    草稿，唯独这条没有）；
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
    // 计时器要跟 `setPeekItemId(null)` 一起掐——另外两处清 peek 的地方
    // （`seen` effect、`openCard`）都是这么写的。漏掉它今天不出事，纯粹是因为
    // 被删条目的 `noteText` 是空串、`hasNote` 在渲染闸门那里又挡了一道；
    // 也就是说这条不变量现在靠巧合成立，不是靠构造成立。
    if (peekTimer.current !== 0 && typeof window !== 'undefined') window.clearTimeout(peekTimer.current)
    peekTimer.current = 0
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
  //
  // **朝向（上/下）只在开卡后的第一帧算一次，之后冻结**；落点由 `pinQuoteCard`
  // 钉住朝向原文的那条边，剩余空间作为卡片的 `maxHeight` 交下去。评论框可变高
  // 之后这两件事缺一不可：照旧每帧 `placeQuoteCard(…, cardSize, …)` 的话，
  // 打字会让卡片一边长一边往上爬（下缘钳制 `band.bottom - height` 一直在动），
  // 长到某一行还会突然翻到原文上方去。这与本文件既有的不变量（"正在打字的浮层
  // 不许因为滚动或重排而移位"、`frozenCard`）是同一条，只是从"量不出几何时"
  // 扩展到了"高度变化时"。
  let cardPoint: { top: number; left: number; maxHeight: number } | null = null
  if (ui.kind === 'card') {
    // 三条来源的优先级与改动前逐字相同：这一帧的段落几何 → 冻结的上一帧落点 →
    // chip 上方（`anchor==='chip'`，以及"锚在段落上但一次都还没量到"的首帧）。
    const quoteAnchor = ui.anchor === 'quote' ? anchors.openAnchor : null
    const frozen = ui.anchor === 'quote' && quoteAnchor === null && frozenCard.current !== null
    const source = quoteAnchor !== null
      ? { rect: quoteAnchor, rowLeft: quoteAnchor.rowLeft, band: quoteAnchor.band }
      : !frozen && chipRect !== null
        ? { rect: chipRect, rowLeft: chipRect.left, band: chipBand }
        : null
    if (source !== null) {
      // 朝向用**开卡高度**判，不是当前高度：判据本身也必须与高度解耦。
      const opening = placeQuoteCard(
        source.rect, { left: source.rowLeft },
        { width: cardSize.width, height: CARD_FALLBACK_HEIGHT }, source.band,
      )
      const above = frozenFacing.current?.itemId === ui.itemId
        ? frozenFacing.current.above
        : opening.above
      // **只在几何来自真锚点（或 chip 本就是终局来源）时才落笔冻结**——
      // `anchors.openAnchor` 在开卡后的第一帧恒为 `null`（quote-overlay.tsx 的
      // B 段量测 layout effect 还没为新的 `openItemId` 跑过），这一帧 `source`
      // 会退到 `chipRect` 兜底渲染点什么，但那不是这条引用真正的位置。chipRect
      // 一旦在引用列表打开过就不会再清空（`openCard` 走的 chip → 列表 → 编辑
      // 这条路径本身就会先量一次），如果这一帧顺手把 `above` 焊进
      // `frozenFacing.current`，下一帧真几何到位后也再也不会重算（上面那行
      // `itemId` 命中就直接复用），朝向就永久错了。`ui.anchor === 'chip'` 时没
      // 有"稍后会有更准的几何"这回事——它本身就是终局来源，照旧当帧冻结。
      if (quoteAnchor !== null || ui.anchor === 'chip') frozenFacing.current = { itemId: ui.itemId, above }
      const pin = pinQuoteCard(source.rect, cardSize.height, source.band, above, CARD_FALLBACK_HEIGHT)
      // left 与高度无关（只看 width 和带子左右缘），照旧交给 placeQuoteCard。
      cardPoint = { top: pin.top, left: opening.left, maxHeight: pin.maxHeight }
      frozenCard.current = cardPoint
    } else if (ui.anchor === 'quote' && frozenCard.current !== null) {
      cardPoint = frozenCard.current
    }
  }

  const noteText = openItem?.comment ?? ''
  // `noteMaxWidth` 现在是标签的宽度**上限**（标签自己按内容 `width:max-content`）。
  // 拿它当 `placeQuoteCard` 的 `size.width` 仍然安全：那个函数只在标签贴近带子
  // 右缘时才会把 `left` 往左夹，用上限（而不是真实、更窄的渲染宽度）算出的
  // `left` 只会夹得更保守，真实盒子永远落在算出的带子里——不会因为改用上限而
  // 越出带子，最多是短批注右边多出一点用不上的夹算余量，纯视觉上无感。
  const noteMaxWidth = clampWidth(band, 160, NOTE_MAX_WIDTH)
  const notePoint = anchors.openAnchor === null
    ? null
    : placeQuoteCard(
      anchors.openAnchor,
      { left: anchors.openAnchor.rowLeft },
      { width: noteMaxWidth, height: NOTE_HEIGHT },
      anchors.openAnchor.band,
    )
  /**
   * 批注标签只在**悬停**时浮出，来源只剩 `peekItemId` 一条：保存后不再钉住任何
   * 东西（论证见 `QuoteUi` 上方）。它只展示已保存内容、不承载未保存的字，所以
   * 锚点滚出可见带就隐藏。卡片**不**看 inBand —— 正在打字的浮层不许因为滚动
   * 而消失。
   *
   * `hasNote` 挡掉「悬停一条没有评论的引用」：那时能显示的只有占位符，而占位符
   * 正是前几版删掉的东西；徽标的强调环仍然照亮，悬停反馈没丢。
   */
  const showNote = ui.kind === 'none' && peekItemId !== null
    && hasNote(noteText)
    && anchors.openAnchor !== null
    && anchors.openAnchor.inBand
    && notePoint !== null

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
          onClose={() => { setListOpen(false); chip.current?.focus() }}
          t={t}
        />
      )}
      {showNote && openItemId !== null && notePoint !== null && (
        <QuoteNoteLayer
          ordinal={openOrdinal}
          top={notePoint.top}
          left={notePoint.left}
          maxWidth={noteMaxWidth}
          note={noteText}
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
          draft={ui.draft}
          baseline={ui.baseline}
          error={ui.error}
          top={cardPoint.top}
          left={cardPoint.left}
          width={clampWidth(band, CARD_MIN_WIDTH, CARD_MAX_WIDTH)}
          // 高度上限 = 被钉住的那条边到带子边缘的剩余空间（`pinQuoteCard` 已经
          // 兜过下限）。评论框的行数上限再从这里减掉卡片 chrome —— 于是卡片长不
          // 出带子，钳制永远不触发，被钉的那条边一个像素都不动。
          maxHeight={cardPoint.maxHeight}
          onDraftChange={(value) => setUi((current) => (
            current.kind === 'card' ? { ...current, draft: value } : current
          ))}
          onCommit={commitCard}
          onRemove={() => removeQuote(ui.itemId)}
          // 焦点落点选 chip：卡片 portal 在 document.body，收起就是卸载。批注标签
          // 层是 aria-hidden 且里面一个可聚焦控件都没有，正文徽标同理；chip 是
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
  // sessionId → 最近一次经由 onAdd 真实新增、尚未被 SelectionDock 认领的
  // itemId。这是「seen effect 不能只靠集合差判断用户意图」的证据来源——见
  // SelectionDock 里 `consumeAddSignal` 参数与它上方的注释。同一个 session 只
  // 记最新一笔（连续两次真实新增之间来不及被认领的情形极罕见，且旧的一笔
  // 被覆盖也不会误判——它从来不会被拿去跟一个它没产生过的 itemId 匹配）。
  const pendingAdds = new Map<string, string>()
  const onAdd = (selection: ConversationSelection) => {
    const itemId = itemIdFactory()
    const result = addSelectionToConversation(controller, services, selection, itemId, t)
    // `revalidate` 内部只在 selection 仍是当前激活的那一份时才返回非 null，
    // 且返回的正是同一个对象（identity 不变）——见 SelectionController.revalidate。
    // 所以这里读 `selection.parentSessionId` 而不是重新解一次 current，两者
    // 恒相等，不需要 addSelectionToConversation 额外把它吐出来。
    // 只在真正插入成功时记账：失败路径（stale selection / composer 找不到 /
    // CAS 竞争）根本没有新 occurrence 写进草稿，`items` 集合差不会把这个
    // itemId 判成新增，留一笔认领不到的账毫无意义，还会在同一 session 后续
    // 一次失败又成功之间白白占住 `pendingAdds` 的那一格。
    if (result.ok) pendingAdds.set(selection.parentSessionId, itemId)
    return result
  }
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
      consumeAddSignal: (itemId: string) => {
        if (pendingAdds.get(sessionId) !== itemId) return false
        pendingAdds.delete(sessionId)
        return true
      },
    }),
  }, SelectionDock))

  return controller
}
