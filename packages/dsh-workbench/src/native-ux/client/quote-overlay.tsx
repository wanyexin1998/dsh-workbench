// 正文侧的引用编号徽标图层 + 锚点重解析循环。
//
// 这一层只做两件事：
//   1. 每次需要重绘时，从草稿里的引用身份**重新**解析 Range（绝不持有旧的，
//      见 conversation-dom.ts `resolveRowRange` 的注释），发布给高亮 registry；
//   2. 把末行矩形换算成一枚绝对定位的编号徽标（`::highlight()` 没有盒模型，
//      圆角徽标只能这么画）。
//
// 宿主 DOM 全程只读：查行、量矩形、造 Range。不插节点、不写属性。

import * as React from 'react'
import { createPortal } from 'react-dom'
import {
  focusedPaneScope, locateConversationRoot, locateScrollport, quoteBand,
} from './conversation-dom.js'
import {
  QUOTE_BADGE_HEIGHT, defaultQuoteHighlightRegistry, lastLineRect, placeQuoteBadge,
  quoteBadgeWidth, quoteBandIsMeasured, quoteMutationsMatter, resolveQuoteAnchor,
  type QuoteAnchor, type QuoteAnchorState, type QuoteBadgeBox, type QuoteHighlightRegistry,
} from './quote-highlight.js'
import type { SelectionAggregateItem } from './selection-reference.js'

export interface QuoteBadgePlacement {
  readonly id: string
  /** `aggregate.items` 的数组下标。编号是 `index + 1`，**永远**不按文档位置排序。 */
  readonly index: number
  readonly top: number
  readonly left: number
}

export interface QuoteAnchorSnapshot {
  readonly states: ReadonlyMap<string, QuoteAnchorState>
  readonly badges: readonly QuoteBadgePlacement[]
}

const EMPTY_SNAPSHOT: QuoteAnchorSnapshot = { states: new Map(), badges: [] }

/** 一条引用的解析结果缓存。滚动帧只读它、只重量矩形，不重新解析。 */
interface ResolvedQuote {
  readonly id: string
  readonly index: number
  readonly anchor: QuoteAnchor | null
}

/** 上一次真正发出去的那份 publication，外加它是发给谁的。 */
interface PublishedQuotes {
  readonly owner: string
  readonly store: QuoteHighlightRegistry
  readonly ranges: readonly Range[]
  readonly active: readonly Range[]
}

/**
 * 两次 publish 的内容一不一样。比的是 Range **对象身份**：滚动帧里
 * `anchorsRef` 一动不动，同一批 Range 会被原样重新收集一遍，身份相等正好
 * 表达"内容没变"。重解析一定造新 Range，身份必然不等。
 */
function samePublication(
  previous: PublishedQuotes | null, owner: string, store: QuoteHighlightRegistry,
  ranges: readonly Range[], active: readonly Range[],
): boolean {
  // 一次都还没发过时必须发：本图层"我这份是空的"也是一条要说出口的话（另一侧
  // 有 owner 在同一个 registry 里合并），省掉它就成了"沉默 = 未知"。
  if (previous === null) return false
  if (previous.owner !== owner || previous.store !== store) return false
  if (previous.ranges.length !== ranges.length || previous.active.length !== active.length) return false
  for (let index = 0; index < ranges.length; index += 1) {
    if (previous.ranges[index] !== ranges[index]) return false
  }
  for (let index = 0; index < active.length; index += 1) {
    if (previous.active[index] !== active[index]) return false
  }
  return true
}

function sameSnapshot(a: QuoteAnchorSnapshot, b: QuoteAnchorSnapshot): boolean {
  if (a.states.size !== b.states.size || a.badges.length !== b.badges.length) return false
  for (const [id, state] of a.states) {
    if (b.states.get(id) !== state) return false
  }
  for (let index = 0; index < a.badges.length; index += 1) {
    const left = a.badges[index]!
    const right = b.badges[index]!
    if (left.id !== right.id || left.index !== right.index) return false
    if (left.top !== right.top || left.left !== right.left) return false
  }
  return true
}

export interface UseQuoteAnchorsOptions {
  readonly items: readonly SelectionAggregateItem[]
  /** 草稿里 aggregate 的编码串。它一变就全量重解析——这是最便宜、最可靠的信号。 */
  readonly revision: string | undefined
  readonly sessionId: string
  readonly activeItemId: string | null
  readonly ownerId: string
  readonly registry?: QuoteHighlightRegistry
}

/**
 * 重解析循环。
 *
 * 信号与代价：
 *   ref 变化        → 全量重解析（React prop 变化，免费）
 *   scroll(passive) → 只重算徽标矩形，高亮不需要动（rAF 节流，抄 navigator.tsx:183）
 *   ResizeObserver + window.resize → 换行会变，重解析（抄 navigator.tsx:161）
 *   MutationObserver → 先过 `quoteMutationsMatter` 这道闸门，相关才置脏，
 *                      再合并到一次 rAF
 *
 * 那道闸门是必需的，不是保险丝。观察器挂在整个会话根上、`characterData` +
 * `subtree` 全开，流式输出期间每帧都有记录进来；此处曾经直通
 * `scheduleRestructure`，于是每帧一次全量重解析（每条引用一遍
 * `eligibleTextNodes`，每个文本节点一次 `getComputedStyle`）。"引用只能指向
 * settled 行、所以打不爆"这个推理本身没错，错在**没有人去用它**——推理必须
 * 落成代码里的判据才算数，`quoteMutationsMatter` 就是把它写下来。
 *
 * 重活（解析）也从 `useLayoutEffect` 挪到了 `useEffect`：它是同步阻塞布局的，
 * 而晚一帧上色对一个装饰图层完全可接受。留在 `useLayoutEffect` 的只有 B
 * （量矩形 + 定位徽标）——那一步必须在绘制前完成，否则滚动时徽标会拖后一帧。
 *
 * GA-031（navigator.tsx:102 那段教训）：观察器绝不长期挂在 document.body。
 * 找不到会话根 / 滚动容器 / pane 时宁可不装观察器——ref 变化与 scroll/resize
 * 仍在，功能降级而不是换来一个全局观察器。
 */
export function useQuoteAnchors({
  items, revision, sessionId, activeItemId, ownerId, registry,
}: UseQuoteAnchorsOptions): QuoteAnchorSnapshot {
  const store = registry ?? defaultQuoteHighlightRegistry()
  // 两个独立的脏标记，因为两条路径的代价差一个数量级：
  //   resolveTick  结构/尺寸变化 → 全量重解析（要走 eligibleTextNodes，
  //                每个文本节点一次 getComputedStyle，是这里最贵的一步）
  //   viewTick     滚动 → **只**重量矩形，高亮一动不动
  // 把滚动挂到重解析上会在流式输出时每帧做几千次 getComputedStyle。
  const [resolveTick, setResolveTick] = React.useState(0)
  const [viewTick, setViewTick] = React.useState(0)
  const [snapshot, setSnapshot] = React.useState<QuoteAnchorSnapshot>(EMPTY_SNAPSHOT)
  const anchorsRef = React.useRef<readonly ResolvedQuote[]>([])
  // 闸门只需要"当前锚在哪几行"，单独存一份免得每条记录都去翻 anchorsRef。
  const anchorRowsRef = React.useRef<readonly HTMLElement[]>([])
  // 上一次真正发出去的那份（`null` = 还一次都没发过）。
  const publishedRef = React.useRef<PublishedQuotes | null>(null)
  // items 每次渲染都是新数组（从 ref 现解的），不能进 deps —— 用 revision 当键，
  // 真正的读取走 ref，避免每渲染一次就重跑一次解析。
  const itemsRef = React.useRef(items)
  itemsRef.current = items

  React.useEffect(() => {
    if (typeof window === 'undefined') return
    let disposed = false
    let frame = 0
    let restructured = false
    let scrollTarget: HTMLElement | null = null
    let mutationTarget: Node | null = null
    const flush = () => {
      if (disposed) return
      if (restructured) {
        restructured = false
        retarget()
        setResolveTick((value) => value + 1)
      }
      setViewTick((value) => value + 1)
    }
    const schedule = () => {
      if (disposed) return
      if (typeof window.requestAnimationFrame !== 'function') {
        flush()
        return
      }
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(flush)
    }
    const scheduleRestructure = () => {
      restructured = true
      schedule()
    }
    function retarget(): void {
      if (disposed) return
      const scope = focusedPaneScope(sessionId)
      const scrollport = locateScrollport(scope)
      if (scrollport !== scrollTarget) {
        if (scrollTarget !== null) {
          scrollTarget.removeEventListener('scroll', schedule)
          resizes?.unobserve(scrollTarget)
        }
        scrollTarget = scrollport
        if (scrollport !== null) {
          scrollport.addEventListener('scroll', schedule, { passive: true })
          resizes?.observe(scrollport)
        }
      }
      const next = locateConversationRoot(scope)
        ?? scrollport
        ?? (scope instanceof HTMLElement ? scope : null)
      if (next !== mutationTarget) {
        mutations?.disconnect()
        mutationTarget = next
        if (next !== null) {
          mutations?.observe(next, { childList: true, characterData: true, subtree: true })
        }
      }
    }
    // 回调先过闸门再置脏（结构脏 vs 视口脏），真活儿合并到一次 rAF 里做。
    // 与引用无关的记录**一个 tick 都不排**——流式输出的那条洪流就死在这里。
    const mutations = typeof MutationObserver === 'function'
      ? new MutationObserver((records) => {
        if (!quoteMutationsMatter(records, anchorRowsRef.current)) return
        scheduleRestructure()
      })
      : null
    // 尺寸变化会改变换行，必须重解析而不只是重量。
    const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleRestructure) : null
    retarget()
    window.addEventListener('resize', scheduleRestructure)
    return () => {
      disposed = true
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', scheduleRestructure)
      scrollTarget?.removeEventListener('scroll', schedule)
      mutations?.disconnect()
      resizes?.disconnect()
    }
  }, [sessionId])

  // A) 解析。只在身份 / 结构 / 尺寸变化时跑，且**不在** layout 阶段——它是这一
  // 层最贵的一步（每条引用一遍 eligibleTextNodes），挂在 useLayoutEffect 上就是
  // 同步阻塞浏览器布局。装饰晚一帧上色，代价由 B 兜住。
  React.useEffect(() => {
    const scope = focusedPaneScope(sessionId)
    const resolved = itemsRef.current.map((item, index) => ({
      id: item.id,
      index,
      // 别的 Pane（或别的会话）的条目一律不解析（ADR-0009，fail-closed 的正确落点）。
      // captureConversationRange 那层的 pane 判据在宿主没有 [data-session-pane]
      // 时会放行，这道闸门是那种宿主上唯一的防线。
      anchor: item.parentSessionId === sessionId ? resolveQuoteAnchor(item, scope) : null,
    }))
    anchorsRef.current = resolved
    anchorRowsRef.current = resolved.flatMap((entry) => (entry.anchor === null ? [] : [entry.anchor.row]))
    setViewTick((value) => value + 1)
  }, [revision, sessionId, resolveTick])

  // B) 测量 + 发布。滚动只走这条：Range 不重建，浏览器自己重绘色带。
  React.useLayoutEffect(() => {
    const scrollport = locateScrollport(focusedPaneScope(sessionId))
    const band = scrollport === null ? null : quoteBand(scrollport)
    const measurable = quoteBandIsMeasured(band)
    const states = new Map<string, QuoteAnchorState>()
    const badges: QuoteBadgePlacement[] = []
    const taken: QuoteBadgeBox[] = []
    const ranges: Range[] = []
    const active: Range[] = []
    for (const resolved of anchorsRef.current) {
      // 缓存的 Range 在两次解析之间可能被宿主重渲染悄悄塌缩。`collapsed` 是
      // 唯一诚实的存活判据（`isConnected` 恒为 true，会一路骗到底），而且它不
      // 触发样式重算，放在每帧路径上是安全的。
      const anchor = resolved.anchor !== null && !resolved.anchor.range.collapsed ? resolved.anchor : null
      if (anchor === null) {
        states.set(resolved.id, 'detached')
        continue
      }
      ranges.push(anchor.range)
      if (resolved.id === activeItemId) active.push(anchor.range)
      const line = lastLineRect(anchor.range)
      // 量不出来 ≠ 不在视野内。滚动容器没找到 / 带子还没布局 / Range 拿不到
      // 客户区矩形，说的都是"这一帧不知道它在哪"，报成 offscreen 会让屏读用户
      // 听到一句假话（色带其实可能就在眼前）。
      if (!measurable || line === null) {
        states.set(resolved.id, 'unmeasured')
        continue
      }
      const box = { width: quoteBadgeWidth(String(resolved.index + 1)), height: QUOTE_BADGE_HEIGHT }
      const point = placeQuoteBadge(line, anchor.row.getBoundingClientRect(), band, box, taken)
      if (point === null) {
        states.set(resolved.id, 'offscreen')
        continue
      }
      states.set(resolved.id, 'anchored')
      taken.push({ top: point.top, left: point.left, width: box.width, height: box.height })
      badges.push({ id: resolved.id, index: resolved.index, top: point.top, left: point.left })
    }
    // 滚动帧里 Range 一条都没变，`new Highlight(...)` + `CSS.highlights.set` 完全
    // 是白做的（设计上"滚动只重算徽标矩形、高亮一动不动"）。sameSnapshot 只挡得住
    // React state，挡不住 publish —— 这里补上同一套判据。
    if (!samePublication(publishedRef.current, ownerId, store, ranges, active)) {
      publishedRef.current = { owner: ownerId, store, ranges, active }
      store.publish(ownerId, { ranges, active })
    }
    const next: QuoteAnchorSnapshot = { states, badges }
    setSnapshot((previous) => (sameSnapshot(previous, next) ? previous : next))
  }, [viewTick, activeItemId, sessionId, store, ownerId])

  React.useEffect(() => () => store.withdraw(ownerId), [store, ownerId])

  return snapshot
}

/* ── 徽标 ──────────────────────────────────────────────────────────────── */

export interface QuoteBadgeProps {
  readonly label: string
  readonly state: QuoteAnchorState
  readonly emphasis: boolean
}

/**
 * 编号徽标。引用区与正文侧渲染的是**同一个组件、同一套外观**——那是两边唯一
 * 的连接机制（原文预览已从引用区去掉）。
 *
 * 为什么不是参考图那种实心蓝：`state-business-primary` 实心 +
 * `label-primary-foreground` 白字，浅色下 #4176e6/#fff 只有 4.25:1——过 3:1
 * （UI 组件）但过不了 4.5:1，而数字是正文级文字。宿主 alias 层没有更深的蓝
 * （`deepseek-600 #4868b2` 能到 5.46:1，但它是 static token，不随主题翻转）。
 * 所以取「淡底 + 深蓝数字 + 蓝描边」：
 *   数字/底  浅 #0e3074 on #e4edfd = 10.55:1   深 #f9fafb on #34415b = 9.84:1
 *   描边/底  浅 3.57:1              深 3.86:1        （1.4.11 要 3:1）
 *   描边/行背景 bg-base  浅 4.25:1  深 7.15:1
 *
 * 描边走 `box-shadow` 而不是 `border`：emphasis 时 1px→2px 不能引起布局位移。
 * `detached` 换成虚线 `border`，此时 box-shadow 关掉，两态的 border 都存在
 * （只是颜色透明与否），盒子尺寸恒定。
 */
export function QuoteBadge({ label, state, emphasis }: QuoteBadgeProps) {
  // 只有 detached 换外观。`unmeasured` 的锚点是**好的**（复核全过，只是这一帧
  // 量不出几何），画成虚线残缺态是在冤枉它。
  const detached = state === 'detached'
  return (
    <span
      data-dsh-quote-badge={state}
      style={{
        boxSizing: 'border-box',
        display: 'inline-grid', placeItems: 'center',
        minWidth: 16, height: 16, padding: '0 4px',
        borderRadius: 999,
        border: `1px ${detached ? 'dashed' : 'solid'} ${detached
          ? 'var(--dsw-alias-label-tertiary, #81858c)'
          : 'transparent'}`,
        boxShadow: detached
          ? 'none'
          : `0 0 0 ${emphasis ? 2 : 1}px var(--dsw-alias-state-business-primary, #4176e6)`,
        background: detached ? 'transparent' : 'var(--dsw-alias-state-business-tertiary, #e4edfd)',
        color: 'var(--dsw-alias-label-primary-bluish, #0e3074)',
        fontFamily: 'inherit', fontSize: 11, lineHeight: '16px', fontWeight: 600,
        fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', userSelect: 'none',
      }}
    >
      {label}
    </span>
  )
}

export interface QuoteBadgeLayerProps {
  readonly badges: readonly QuoteBadgePlacement[]
  readonly activeItemId: string | null
  readonly onHover: (itemId: string | null) => void
  readonly onSelect: (itemId: string) => void
}

/**
 * 正文侧图层。
 *
 * 整层对 AT 隐藏（`aria-hidden` + `role="presentation"`）：它 portal 在
 * document.body，屏读会在**完全错误的文档顺序**上读到一串孤零零的「1 2 3」。
 * 隐藏严格优于错序朗读——无障碍语义全部落在引用区我们自己的 DOM 里。
 * 因此徽标是 `<span>` 而不是 `<button>`：aria-hidden 容器里放可聚焦控件会造出
 * 一个「能 Tab 到但读不出来」的黑洞。键盘的等价路径是聚焦评论框（同样触发
 * emphasis）。
 *
 * 容器本身是 0×0 的 fixed 盒子，不铺满屏幕，绝不拦截宿主的指针事件；
 * zIndex 899 压在选区工具条(900)之下、宿主 100/101 档之上
 * （层级考据见 selection-actions.tsx 的 zIndex 注释）。
 */
export function QuoteBadgeLayer({ badges, activeItemId, onHover, onSelect }: QuoteBadgeLayerProps) {
  if (typeof document === 'undefined' || badges.length === 0) return null
  return createPortal(
    <div
      data-dsh-quote-overlay
      aria-hidden="true"
      role="presentation"
      style={{ position: 'fixed', top: 0, left: 0, width: 0, height: 0, zIndex: 899 }}
    >
      {badges.map((badge) => (
        <span
          key={badge.id}
          data-dsh-quote-badge-anchor={badge.id}
          onMouseEnter={() => onHover(badge.id)}
          onMouseLeave={() => onHover(null)}
          onClick={() => onSelect(badge.id)}
          style={{ position: 'absolute', top: badge.top, left: badge.left, cursor: 'pointer' }}
        >
          <QuoteBadge label={String(badge.index + 1)} state="anchored" emphasis={activeItemId === badge.id} />
        </span>
      ))}
    </div>,
    document.body,
  )
}
