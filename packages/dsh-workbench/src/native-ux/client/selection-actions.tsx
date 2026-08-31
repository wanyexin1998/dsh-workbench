import * as React from 'react'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { HarnessServices } from './harness-adapter.js'
import { SelectionController, type SelectionSessions } from './selection-controller.js'
import type { ConversationSelection } from './selection-contract.js'
import {
  appendSelectionReference, createSelectionReferenceSource, createSideChatReferenceSource,
  insertSideChatReference, readSelectionAggregate, removeSelectionItem,
  updateSelectionComment, type SelectionInput,
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

interface SelectionDockProps {
  readonly sessionId: string
  readonly session: { readonly sessionId: string }
  readonly input: SelectionInputSnapshot
  readonly updateComment: (itemId: string, comment: string) => SelectionMutationResult
  readonly removeItem: (itemId: string) => SelectionMutationResult
  readonly t: Translate
}

export function SelectionDock({ sessionId, session, input, updateComment, removeItem, t }: SelectionDockProps) {
  const owned = session.sessionId === sessionId ? readSelectionAggregate(input) : null
  const ref = owned?.occurrence.ref
  const [comments, setComments] = React.useState<Record<string, string>>({})
  React.useEffect(() => {
    if (owned === null) {
      setComments({})
      return
    }
    setComments(Object.fromEntries(owned.aggregate.items.map((item) => [item.id, item.comment ?? ''])))
  }, [ref])
  if (owned === null) return null
  return (
    <section
      data-dsh-selection-dock
      aria-label={t('selection.dock.label')}
      style={{
        boxSizing: 'border-box', flex: 'none', overflow: 'hidden', margin: '0 auto',
        // 与 TodoPanel(order 0) / QueueDock(order 20) 对齐同一根宽度轴，否则 composer 上下文栈会散。
        width: 'calc(100% - var(--dsh-composer-side-clearance, 16px) * 2 - var(--dsh-composer-dock-inset, 8px) * 4)',
        maxWidth: 'calc(var(--dsh-composer-card-max-width, 780px) - var(--dsh-composer-dock-inset, 8px) * 4)',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04))',
        borderRadius: 12,
        // bg-layer-1 浅色下就是纯白，和正文分不开；specific-tip 浅 #F5F6F7 / 深 #353638 两边都有层次。
        // 栈内卡片一律无阴影——阴影是浮层专用。
        background: 'var(--dsw-specific-tip, #f5f6f7)',
      }}
    >
      <div style={{ display: 'grid', gap: 8, padding: '6px 12px' }}>
        <div style={{
          fontSize: 13, lineHeight: '24px', fontWeight: 500,
          color: 'var(--dsw-alias-label-primary, #0f1115)',
        }}>
          {t('selection.dock.label')}{' '}
          {/* 13px 计数是正文，要过 4.5:1。label-tertiary 画在 specific-tip 卡面上浅色
              只有 3.42:1（深色 5.67:1 过）；换成 label-secondary：浅 5.36:1 / 深 8.03:1。 */}
          <span style={{ fontWeight: 400, color: 'var(--dsw-alias-label-secondary, #61666b)' }}>
            ({owned.aggregate.items.length})
          </span>
        </div>
        {owned.aggregate.items.map((item, index) => (
          <SelectionDockRow
            key={item.id}
            index={index}
            text={item.text}
            comment={comments[item.id] ?? ''}
            onCommentChange={(value) => setComments((current) => ({ ...current, [item.id]: value }))}
            onCommentCommit={(value) => updateComment(item.id, value)}
            onRemove={() => removeItem(item.id)}
            t={t}
          />
        ))}
      </div>
    </section>
  )
}

interface SelectionDockRowProps {
  readonly index: number
  readonly text: string
  readonly comment: string
  readonly onCommentChange: (value: string) => void
  readonly onCommentCommit: (value: string) => void
  readonly onRemove: () => void
  readonly t: Translate
}

function SelectionDockRow({
  index, text, comment, onCommentChange, onCommentCommit, onRemove, t,
}: SelectionDockRowProps) {
  const remove = useInteractive()
  const [inputFocused, setInputFocused] = React.useState(false)
  return (
    <div
      style={{
        display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 10,
        alignItems: 'center', minHeight: 36,
        ...(index > 0
          ? { paddingTop: 8, boxShadow: 'inset 0 1px 0 var(--dsw-alias-border-l1, rgba(0,0,0,.04))' }
          : null),
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          title={text}
          style={{
            fontSize: 13, lineHeight: '20px',
            color: 'var(--dsw-alias-label-primary-dimmed, #151517)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            // 竖条与发送出去的引用装订线呼应；不要用 markdown-citation——它深色下与
            // specific-tip 同色，竖条会消失。
            borderLeft: '2px solid var(--dsw-alias-border-l4, rgba(0,0,0,.16))', paddingLeft: 8,
          }}
        >
          {text}
        </div>
        <input
          aria-label={`${t('selection.comment')} ${index + 1}`}
          value={comment}
          placeholder={t('selection.comment')}
          onChange={(event) => onCommentChange(event.target.value)}
          onFocus={() => setInputFocused(true)}
          onBlur={(event) => {
            setInputFocused(false)
            onCommentCommit(event.target.value)
          }}
          style={{
            boxSizing: 'border-box', width: '100%', height: 28, marginTop: 4,
            padding: '0 8px', borderRadius: 6, outline: 'none',
            // bg-base 在 specific-tip 上是凹面（浅 #FFF on #F5F6F7、深 #151517 on #353638）。
            //
            // 静息边框曾用 border-l2（10% 黑 alpha）。按 WCAG 公式自己合成一遍：
            // rgba(0,0,0,.1) 叠在浅色 bg-base #FFF 上 → 有效色 ≈ #E6E6E6（L=0.7874），
            // 对 #FFF（L=1.0）只有 (1.05)/(0.7874+0.05) ≈ 1.25:1——WCAG 1.4.11 对 UI
            // 组件边界要求的是 3:1，差了一倍还多。border-l2 在这份文件里从没被
            // 实测过深色值，但它是同一套「弱 alpha 描边」token，观感上不会比浅色好到
            // 哪去，达标希望不大，所以直接换 token 而不是等深色实测。
            //
            // 换成 label-tertiary（本文件删除按钮静息态在用的同一个 token，见下方
            // remove.hovered 分支），不是本轮焦点环选的 business-primary——那是
            // focus 态专用色，静息态另选是任务要求，也是设计上"焦点才该跳色"的
            // 惯例。label-tertiary 是不透明纯色，不需要 alpha 合成，直接算：
            //   浅色 #81858c vs bg-base #FFFFFF        → 3.71:1
            //   浅色 #81858c vs specific-tip #F5F6F7    → 3.43:1
            //   深色 #adb2b8 vs bg-base #151517         → 8.54:1
            //   深色 #adb2b8 vs specific-tip #353638    → 5.66:1
            // 边框内侧贴 bg-base、外侧（隔着无背景色的包裹层）透出 specific-tip，
            // 两侧四个数字都过 3:1，两套主题都有余量。label-tertiary 在本组件里
            // 已经是这两块卡面上验证过的边界色（3.71 / 3.42 / 5.67，删除按钮那三个
            // 数字），不是新引入的观感。
            border: `1px solid ${inputFocused
              ? 'var(--dsw-alias-state-business-primary, #4176e6)'
              : 'var(--dsw-alias-label-tertiary, #81858c)'}`,
            background: 'var(--dsw-alias-bg-base, #fff)',
            color: 'var(--dsw-alias-label-primary, #0f1115)',
            fontFamily: 'inherit', fontSize: 13,
          }}
        />
      </div>
      <button
        type="button"
        aria-label={`${t('selection.remove')} ${index + 1}`}
        onClick={onRemove}
        {...remove.handlers}
        style={{
          display: 'grid', placeItems: 'center', width: 28, height: 28, padding: 0,
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
