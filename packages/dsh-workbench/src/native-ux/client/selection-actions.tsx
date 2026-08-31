import * as React from 'react'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { revealNode } from '../core/navigation-adapter.js'
import {
  ensureQuoteHighlightStyles, findBusinessRow, focusedPaneScope, locateScrollport,
} from './conversation-dom.js'
import type { HarnessServices } from './harness-adapter.js'
import {
  quoteExcerpt, type QuoteAnchorState, type QuoteHighlightRegistry,
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

/** 引用区最多常驻 4 行（32 行高 + 2 行距），再多就滚动 —— 旧实现无高度上限，
 * 6 条以上会把 composer 顶飞。 */
const DOCK_MAX_HEIGHT = 4 * 34

const NO_ITEMS: readonly SelectionAggregateItem[] = []

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
  const [comments, setComments] = React.useState<Record<string, string>>({})
  // 引用区行与正文徽标共享的强调状态：hover 任意一侧、或聚焦行内控件都会点亮它，
  // 于是键盘用户免费拿到与鼠标 hover 等价的联动。
  //
  // hover 与 focus **分开存**，合成时 hover 优先。合成前两者共用一个
  // activeItemId，而行的 onMouseLeave 是无条件清空：鼠标划过第 2 行再移开，会把
  // 第 1 行（键盘正聚焦）的强调一起抹掉——键盘用户的状态被指针的路过事件顺手
  // 删了。拆开之后 leave 只动 hover 格子，focus 格子原封不动，指针离开时强调
  // **回落**到聚焦那一行而不是消失。
  // 顺序取 hover 在前是因为指针是即时的直接操作：鼠标停在哪一行，那一行就该亮；
  // 松开后再回到键盘的那一行。两个 leave 各自带身份判据（只清自己那条），乱序的
  // enter/leave（进入下一行的 enter 先于上一行的 leave）也不会误清后来者。
  const [hoveredItemId, setHoveredItemId] = React.useState<string | null>(null)
  const [focusedItemId, setFocusedItemId] = React.useState<string | null>(null)
  const activeItemId = hoveredItemId ?? focusedItemId
  const inputs = React.useRef(new Map<string, HTMLInputElement>())
  React.useEffect(() => {
    if (owned === null) {
      setComments({})
      return
    }
    setComments(Object.fromEntries(owned.aggregate.items.map((item) => [item.id, item.comment ?? ''])))
  }, [ref])
  // Hook 必须无条件调用 —— `owned === null` 的早退在它之后。空列表会让 registry
  // 收到一次空发布，正好把这个 session 的色带撤掉。
  const anchors = useQuoteAnchors({
    items,
    revision: ref,
    sessionId,
    activeItemId,
    ownerId: `dsh-workbench.selection-dock:${sessionId}`,
    registry: highlights,
  })
  if (owned === null) return null

  const setHover = (itemId: string, on: boolean) => {
    setHoveredItemId((current) => (on ? itemId : current === itemId ? null : current))
  }
  const setFocus = (itemId: string, on: boolean) => {
    setFocusedItemId((current) => (on ? itemId : current === itemId ? null : current))
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

  return (
    <section
      data-dsh-selection-dock
      // 可见计数已随标题行一起删掉（计数由正文徽标承担），把它并进无障碍名，
      // 免得屏读用户丢掉"有几条引用"这个信息。
      aria-label={t('selection.dock.labelCount', { count: String(items.length) })}
      style={{
        boxSizing: 'border-box', flex: 'none', margin: '0 auto',
        // 与 TodoPanel(order 0) / QueueDock(order 20) 对齐同一根宽度轴，否则 composer 上下文栈会散。
        width: 'calc(100% - var(--dsh-composer-side-clearance, 16px) * 2 - var(--dsh-composer-dock-inset, 8px) * 4)',
        maxWidth: 'calc(var(--dsh-composer-card-max-width, 780px) - var(--dsh-composer-dock-inset, 8px) * 4)',
      }}
    >
      {/* 卡片外框、标题行、竖条预览、行间分隔线全部去掉：原文不再在这里重复
          显示，"轻"由减法实现，而不是靠把边框调淡（那会掉到 1.4.11 的 3:1 之下）。 */}
      {/* 左右各留 4px：`overflowY:'auto'` 让这个盒子成为滚动容器，溢出被裁在
          padding box 上，而「跳到原文」按钮的焦点环画在按钮**外面**
          （offset 2 + 宽 2 = 4px）。没有这 4px，第一列按钮的环会被容器左缘裁掉。 */}
      <div style={{ display: 'grid', gap: 2, padding: '2px 4px', maxHeight: DOCK_MAX_HEIGHT, overflowY: 'auto' }}>
        {items.map((item, index) => (
          <SelectionDockRow
            key={item.id}
            index={index}
            item={item}
            state={anchors.states.get(item.id) ?? 'detached'}
            emphasis={activeItemId === item.id}
            comment={comments[item.id] ?? ''}
            onHover={(on) => setHover(item.id, on)}
            onFocusChange={(on) => setFocus(item.id, on)}
            onCommentChange={(value) => setComments((current) => ({ ...current, [item.id]: value }))}
            onCommentCommit={(value) => updateComment(item.id, value)}
            onRemove={() => removeItem(item.id)}
            onReveal={() => reveal(item)}
            registerInput={(node) => {
              if (node === null) inputs.current.delete(item.id)
              else inputs.current.set(item.id, node)
            }}
            t={t}
          />
        ))}
      </div>
      {/* 正文徽标只写 hover 格子：它是纯指针图层，不该有能力清掉键盘聚焦的强调。 */}
      <QuoteBadgeLayer
        badges={anchors.badges}
        activeItemId={activeItemId}
        onHover={(itemId) => setHoveredItemId(itemId)}
        onSelect={(itemId) => inputs.current.get(itemId)?.focus()}
      />
    </section>
  )
}

interface SelectionDockRowProps {
  readonly index: number
  readonly item: SelectionAggregateItem
  readonly state: QuoteAnchorState
  readonly emphasis: boolean
  readonly comment: string
  /** 指针进入/离开本行。只写 hover 格子。 */
  readonly onHover: (on: boolean) => void
  /** 本行的某个控件拿到/失去键盘焦点。只写 focus 格子。 */
  readonly onFocusChange: (on: boolean) => void
  readonly onCommentChange: (value: string) => void
  readonly onCommentCommit: (value: string) => void
  readonly onRemove: () => void
  readonly onReveal: () => void
  readonly registerInput: (node: HTMLInputElement | null) => void
  readonly t: Translate
}

function SelectionDockRow({
  index, item, state, emphasis, comment, onHover, onFocusChange, onCommentChange, onCommentCommit,
  onRemove, onReveal, registerInput, t,
}: SelectionDockRowProps) {
  const remove = useInteractive()
  const jump = useInteractive()
  const [inputFocused, setInputFocused] = React.useState(false)
  const [inputHovered, setInputHovered] = React.useState(false)
  const ordinal = String(index + 1)
  const excerpt = quoteExcerpt(item.text)
  const stateId = `dsh-quote-state-${item.id}`
  // anchored 故意留空串：滚动会让 anchored ⇄ offscreen 频繁翻转,任何提示都会
  // 变成噪音。也正因为如此,这个 span 绝不设 aria-live —— 文本变了就行,
  // 屏读下次聚焦时读到。
  const stateNote = state === 'detached'
    ? t('selection.anchor.detached')
    : state === 'offscreen'
      ? t('selection.anchor.offscreen')
      // 'unmeasured' 说的是「这一帧量不出几何」，不是「滚出视口」——锚点是好的，
      // 只是滚动容器还没布局、或运行环境没有 Range 几何 API。两者混为一谈会让
      // 屏读用户听到一句关于位置的假话，这正是上一轮修掉的缺陷。
      : state === 'unmeasured'
        ? t('selection.anchor.unmeasured')
        : ''
  return (
    <div
      data-dsh-selection-dock-row={item.id}
      // 视觉用户拿回原文的那条途径。重写后引用区只剩数字徽标 + 空评论框，而正文
      // 侧徽标在 offscreen / detached 时**根本不渲染**——那两种状态下视觉用户
      // 没有任何办法知道第 N 条引用的是哪句话，屏读用户反而更全（摘要在评论框的
      // 可访问名里）。这里用 title 补齐，而不是把厚重的原文预览搬回来：
      //   * 挂在**整行**而不是 16px 的徽标上——行是这一区里最大的悬停靶（整宽
      //     32px 高），子元素自己没有 title 时浏览器会沿祖先找，所以悬停行内任
      //     何位置都读得到；
      //   * 零布局代价，引用区仍是「一行 = 一个编号 + 一个评论框」，用户要的
      //     简洁没有被换回来；
      //   * 三种锚点状态下**同一条**途径，包括 detached ——那时既没有正文徽标、
      //     也没有可跳转的原文，是最需要它的一档；
      //   * 这个 div 没有 role、没有可访问名，title 不会给 AT 造出第二处复读。
      title={excerpt}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: 8,
        alignItems: 'center', minHeight: 32,
      }}
    >
      {/* 「跳到原文」以前是 `<span aria-hidden onClick>`：对 AT 隐藏、不可聚焦、
          无 role，等于把「滚动到被引用段落」做成了纯鼠标能力。换成真 <button>：
          可 Tab、Enter/Space 生效、有可访问名。名字里**只**放编号（摘要留给同行
          评论框的名字和整行的 title），两个可访问名信息互补而不是复读。
          外观仍由 QuoteBadge 画，按钮只负责语义、命中区和焦点环。 */}
      <button
        type="button"
        aria-label={t('selection.reveal.aria', { n: ordinal })}
        onClick={onReveal}
        {...jump.handlers}
        // 聚焦这颗按钮与聚焦评论框一样点亮本行 —— 键盘拿到与 hover 等价的联动。
        // 展开在 handlers 之后：后写的 prop 覆盖同名的，再手动转调原处理器。
        onFocus={(event) => { jump.handlers.onFocus(event); onFocusChange(true) }}
        onBlur={() => { jump.handlers.onBlur(); onFocusChange(false) }}
        style={{
          display: 'inline-grid', placeItems: 'center',
          padding: 0, border: 0, background: 'transparent', borderRadius: 999,
          cursor: 'pointer',
          // 环画在徽标**外面**：徽标自身的描边就是 business-primary，内缩的环会
          // 和它糊成一团，分不出「聚焦了没有」。外侧 4px 的容身之处由引用区滚动
          // 容器的左右 padding 让出（见上）。
          outlineOffset: FOCUS_RING_OFFSET,
          outline: jump.focusRing ? FOCUS_RING : 'none',
        }}
      >
        <QuoteBadge label={ordinal} state={state} emphasis={emphasis} />
      </button>
      <div style={{ position: 'relative', minWidth: 0 }}>
        <input
          ref={registerInput}
          data-dsh-quote-comment
          // 摘要进 name 而不是 description：它是这个输入框的**身份**（用来区分
          // 三个长得一样的框），身份属于 name，聚焦时立刻朗读；description 在
          // 部分屏读的浏览模式里会被跳过。
          aria-label={t('selection.comment.aria', { n: ordinal, excerpt })}
          aria-describedby={stateId}
          value={comment}
          placeholder={t('selection.comment.placeholder')}
          onChange={(event) => onCommentChange(event.target.value)}
          onMouseEnter={() => setInputHovered(true)}
          onMouseLeave={() => setInputHovered(false)}
          onFocus={() => {
            setInputFocused(true)
            onFocusChange(true)
          }}
          onBlur={(event) => {
            setInputFocused(false)
            onFocusChange(false)
            onCommentCommit(event.target.value)
          }}
          style={{
            boxSizing: 'border-box', width: '100%', height: 32,
            // 右侧 30px 让开输入框内的删除按钮（20px 图标 + 6px 边距 + 4px 呼吸）。
            padding: '0 30px 0 10px', borderRadius: 8,
            // 焦点环。旧写法 `outline:'none'`，聚焦的唯一信号是描边从
            // label-tertiary 换成 business-primary —— 两色互比浅 1.14:1 / 深
            // 1.25:1，远低于「焦点态相对未聚焦态 3:1」。这里改用本文件为所有
            // 按钮定义的同一套 FOCUS_RING（2px business-primary）。
            //
            // 唯一不同是**偏移取负**：按钮的环画在外侧，因为它们的填充是近白/
            // 近黑的按钮色；输入框不能这么做——它高 32px、正好占满 32px 的行，
            // 而行距只有 2px、滚动容器上下 padding 也只有 2px，外侧 4px 的环会
            // 压到相邻行上、并被滚动容器的上下缘裁掉。内缩 2px 后环整条落在
            // 输入框自己的填充里（border 只占最外 1px，环在 2–4px 处，不碰它），
            // 而那块填充是 bg-base，实测环的两侧相邻色都远过 3:1：
            //   环 vs 聚焦态填充 bg-base       浅 #4176e6/#fff     4.23:1
            //                                  深 #679efe/#151517  6.86:1
            //   环 vs 未聚焦时同一批像素(卡面) 浅 #4176e6/#fff     4.23:1
            //                                  深 #679efe/#2c2c2e  5.24:1
            // 后一对就是 WCAG 要的「焦点态 vs 未聚焦态」，从 1.14/1.25 抬到
            // 4.23/5.24。
            outline: inputFocused ? FOCUS_RING : 'none',
            outlineOffset: -FOCUS_RING_OFFSET,
            // 静息态**故意**保留 1px 描边，与参考图的"完全无边框"不同：透明/
            // 弱 alpha 描边过不了 WCAG 1.4.11 的 3:1（border-l2 合成后只有
            // 1.25:1），而 label-tertiary 在这两块卡面上是 3.71 / 3.43 / 8.54 /
            // 5.66，四个数都过。"轻"已经由去掉卡片、标题、竖条、分隔线拿到了。
            border: `1px solid ${inputFocused
              ? 'var(--dsw-alias-state-business-primary, #4176e6)'
              : 'var(--dsw-alias-label-tertiary, #81858c)'}`,
            background: inputFocused
              ? 'var(--dsw-alias-bg-base, #fff)'
              : inputHovered
                ? 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06))'
                : 'transparent',
            color: 'var(--dsw-alias-label-primary, #0f1115)',
            fontFamily: 'inherit', fontSize: 13,
          }}
        />
        {/* 删除入口留在输入框里,不放正文徽标上 —— 那个徽标可能滚出视口
            (offscreen)、可能根本不存在(detached)，且只有 16px 命中区。
            删除不能依赖锚点活着。 */}
        <button
          type="button"
          aria-label={t('selection.remove.aria', { n: ordinal, excerpt })}
          onClick={onRemove}
          {...remove.handlers}
          style={{
            position: 'absolute', top: '50%', right: 6, transform: 'translateY(-50%)',
            display: 'grid', placeItems: 'center', width: 20, height: 20, padding: 0,
            border: 0, borderRadius: 999, cursor: 'pointer', outlineOffset: FOCUS_RING_OFFSET,
            background: remove.active
              ? 'var(--dsw-alias-interactive-bg-active, rgba(38,49,72,.1))'
              : remove.hovered
                ? 'var(--dsw-alias-interactive-bg-hover-danger, rgba(236,19,19,.05))'
                : 'transparent',
            color: remove.hovered || remove.active
              ? 'var(--dsw-alias-state-error-primary, #ec1313)'
              : 'var(--dsw-alias-label-tertiary, #81858c)',
            outline: remove.focusRing ? FOCUS_RING : 'none',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden focusable="false">
            <path
              d="M2 2 L10 10 M10 2 L2 10"
              fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
            />
          </svg>
        </button>
        <span id={stateId} style={VISUALLY_HIDDEN}>{stateNote}</span>
      </div>
    </div>
  )
}

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
