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
  focusedPaneScope, locateConversationRoot, locateScrollport, quoteBand, type QuoteBand,
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

/**
 * 当前**打开**的那一条引用（标签 / 卡片）的几何。
 *
 * 它由 B 段（测量帧）顺手算出来 —— 那一段本来就已经在量末行矩形和行矩形，
 * 多带一个字段是零成本。浮层的滚动跟随因此完全挂在既有的 `viewTick` 上：
 * **不新增任何观察器**（新增 ResizeObserver / MutationObserver / scroll 监听
 * 会直接推翻上一轮"滚动只重量、不重解析"的成果）。
 */
export interface QuoteOpenAnchor {
  readonly itemId: string
  /** 引用末行的上下缘（视口坐标）。 */
  readonly top: number
  readonly bottom: number
  /** 正文列左缘 —— 浮层左对齐到它。 */
  readonly rowLeft: number
  readonly band: QuoteBand
  /** 末行与可见带有交集。标签靠它决定隐不隐藏；卡片**不看**它（正在打字的
   * 浮层不许因为滚动而消失，见设计 §3.3）。 */
  readonly inBand: boolean
}

export interface QuoteAnchorSnapshot {
  readonly states: ReadonlyMap<string, QuoteAnchorState>
  readonly badges: readonly QuoteBadgePlacement[]
  readonly openAnchor: QuoteOpenAnchor | null
}

const EMPTY_SNAPSHOT: QuoteAnchorSnapshot = { states: new Map(), badges: [], openAnchor: null }

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
  readonly tinted: readonly Range[]
}

/**
 * 两次 publish 的内容一不一样。比的是 Range **对象身份**：滚动帧里
 * `anchorsRef` 一动不动，同一批 Range 会被原样重新收集一遍，身份相等正好
 * 表达"内容没变"。重解析一定造新 Range，身份必然不等。
 */
function sameRangeList(a: readonly Range[], b: readonly Range[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

function samePublication(
  previous: PublishedQuotes | null, owner: string, store: QuoteHighlightRegistry,
  ranges: readonly Range[], active: readonly Range[], tinted: readonly Range[],
): boolean {
  // 一次都还没发过时必须发：本图层"我这份是空的"也是一条要说出口的话（另一侧
  // 有 owner 在同一个 registry 里合并），省掉它就成了"沉默 = 未知"。
  if (previous === null) return false
  if (previous.owner !== owner || previous.store !== store) return false
  // ranges / active 是真判据。tinted 这一条**目前是冗余的**，留着是防御性的：
  // `tinted` 与 `range` 在解析期由同一个 anchor 对象一次造好
  // （quote-highlight.ts:77 `{ row, range, tinted: tintableSubRanges(...) }`），
  // 而这里两个数组又走同一个循环、同一批 `continue`，所以"ranges 逐个同一"必然
  // 蕴含"tinted 逐个同一" —— 它永远改变不了返回值。**因此它也无法被测试杀死**，
  // 别为它去写一条测不出差别的用例。只有当哪天 tinted 改成在测量帧里现算、不再
  // 挂在 anchor 上时，这一条才会重新变成真判据。
  //
  // 另：漏掉它并不会"退回每帧一次 new Highlight()"——少一个 && 只会让去重更松、
  // 发布更少，不会更多。
  return sameRangeList(previous.ranges, ranges)
    && sameRangeList(previous.active, active)
    && sameRangeList(previous.tinted, tinted)
}

function sameOpenAnchor(a: QuoteOpenAnchor | null, b: QuoteOpenAnchor | null): boolean {
  if (a === null || b === null) return a === b
  return a.itemId === b.itemId && a.top === b.top && a.bottom === b.bottom
    && a.rowLeft === b.rowLeft && a.inBand === b.inBand
    && a.band.top === b.band.top && a.band.bottom === b.band.bottom
    && a.band.left === b.band.left && a.band.right === b.band.right
}

function sameSnapshot(a: QuoteAnchorSnapshot, b: QuoteAnchorSnapshot): boolean {
  if (a.states.size !== b.states.size || a.badges.length !== b.badges.length) return false
  // openAnchor 也必须比。漏掉它 = 每个滚动帧都产出一个新快照对象 → 每帧重渲染，
  // 再与卡片自己的尺寸测量 useLayoutEffect 互相激发。
  if (!sameOpenAnchor(a.openAnchor, b.openAnchor)) return false
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
  /** 当前打开了标签 / 卡片的那一条。只影响 `snapshot.openAnchor`，不影响高亮。 */
  readonly openItemId?: string | null
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
  items, revision, sessionId, activeItemId, openItemId = null, ownerId, registry,
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
    const tinted: Range[] = []
    let openAnchor: QuoteOpenAnchor | null = null
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
      // 子 Range 在解析期就造好了，这里只收集 —— 现造会让对象身份每帧都变。
      tinted.push(...anchor.tinted)
      const line = lastLineRect(anchor.range)
      // 量不出来 ≠ 不在视野内。滚动容器没找到 / 带子还没布局 / Range 拿不到
      // 客户区矩形，说的都是"这一帧不知道它在哪"，报成 offscreen 会让屏读用户
      // 听到一句假话（色带其实可能就在眼前）。
      if (!measurable || line === null) {
        states.set(resolved.id, 'unmeasured')
        continue
      }
      if (resolved.id === openItemId) {
        openAnchor = {
          itemId: resolved.id,
          top: line.top,
          bottom: line.bottom,
          rowLeft: anchor.row.getBoundingClientRect().left,
          band: band!,
          inBand: line.bottom > band!.top && line.top < band!.bottom,
        }
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
    if (!samePublication(publishedRef.current, ownerId, store, ranges, active, tinted)) {
      publishedRef.current = { owner: ownerId, store, ranges, active, tinted }
      store.publish(ownerId, { ranges, active, tinted })
    }
    const next: QuoteAnchorSnapshot = { states, badges, openAnchor }
    setSnapshot((previous) => (sameSnapshot(previous, next) ? previous : next))
  }, [viewTick, activeItemId, openItemId, sessionId, store, ownerId])

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
 * 实心蓝 + 白字（参考图形态）。用的是 **static** 层的 `deepseek-600`，不是
 * alias 层的 `state-business-primary`：
 *   * `state-business-primary` 实心 + `label-primary-foreground` 在浅色下是
 *     #4176e6/#fff = **4.23:1**，过 3:1（UI 组件）但过不了正文的 4.5:1；深色下
 *     更糟——那一层的 `label-primary-foreground` 是近黑的 #0f1115，会画成
 *     蓝底黑字。
 *   * 这里用到的两个 static token（`deepseek-600` / `neutral-bluish-00`）在
 *     `body` 与 `body[data-ds-dark-theme]` 两个块里**逐字节相同**，所以
 *     "static 不随主题翻转"在它们身上的含义是「两个主题下是同一个颜色」——
 *     可以用，只是浅深两套都得各审一遍。（这条**不能**推广到整层：
 *     `--dsw-static-neutral-bluish-60` 浅 rgb(245,246,247) / 深 rgb(249,250,251)
 *     就是不同的，换 static token 时要逐个核。）
 *
 * 数字（白 / #4868b2）恒 **5.39:1**，两套主题都过 4.5:1，且与表面无关——徽标底
 * 不透明。表面相关的是徽标**外边界**（WCAG 1.4.11，要 3:1），而这一轮同一个组件
 * 进了**四个**表面，光靠徽标底撑不住：
 *
 *   徽标底 #4868b2 对表面             浅            深
 *   正文层      bg-base              5.39 #ffffff  3.39 #151517
 *   代码块      markdown-code-block  5.15 #f9fafb  3.20 #1b1b1c
 *   标签        note-tag 底（见下）   4.52 #ebebec  1.65 #484a4c   ✗
 *   引用列表行  bg-layer-3           5.39 #ffffff  2.25 #353638   ✗
 *
 * （上一版注释把浅色代码块记成 4.10:1。`markdown-code-block` 浅色是
 * `neutral-bluish-50` #f9fafb，实算 5.15:1——记低了不改变结论，数值在此更正。
 * 「标签」这一行也不再是 `bg-layer-3`：批注标签去掉了实心描边，改成填充色
 * 把自己从原文里托出来，底色是 `color-mix(bg-layer-3 90%, label-primary 10%)`
 * ——浅 #ebebec、深 #484a4c，定义与推导见 selection-actions.tsx 的
 * `QUOTE_NOTE_SURFACE`。「引用列表行」的 `bg-layer-3` 没有变。）
 *
 * 补的是一圈 1px 实心描边，取随主题翻的 `label-secondary`（浅 #61666b /
 * 深 #cfd3d6）。上一版描边只给「标签、引用列表行」算了 hover/pressed 叠加层，
 * 「正文层 / 代码块」只算了静息态——但四个表面这一轮**都**进了同一个组件，
 * 少算的两个表面没资格被默认成安全。补全之后，四表面 × 双主题 × 三态
 * （静息 / hover 6% / pressed 10%，深色叠加层是白色 8%/14%，见下方
 * business-primary 那条的实测合成）完整表：
 *
 *   描边对表面（浅｜深）        静息          ＋hover        ＋pressed
 *   正文层 bg-base             5.80｜12.11    5.21｜9.81     4.84｜8.04
 *   代码块 markdown-code-block 5.55｜11.43    4.99｜9.10     4.63｜7.44
 *   标签 note-tag 底           4.87｜5.91     不适用          不适用
 *   列表 bg-layer-3            5.80｜8.03     5.21｜6.26     4.84｜5.18
 *
 * 「标签」只有静息一档：批注标签自己的底是静态填充色，不像列表行那样有
 * hover/pressed 的交互态背景（它的可点提示只是 `cursor:pointer` 与 `title`），
 * 所以没有 hover/pressed 列可算，也不需要算——`bg-layer-3` 那一路的
 * hover/pressed 现在只描述「列表」。
 *
 * 最低 **4.63:1**——浅色代码块面 × pressed（`#f9fafb` 叠 10% 的
 * `rgba(38,49,72,.1)` ≈ `#e4e6e9`）。上一版把「标签/列表面 pressed 4.82:1」
 * 记成全表最低：那其实只是「算过 hover/pressed 的两个表面」里的最低，代码块面
 * 从没被算过 pressed 就被默认成安全了。真正的最低比它还低，但依然过 3:1，
 * 结论没变。**不能**改用 `state-business-primary` 当描边：它在深色 pressed
 * 叠加层上（rgba(255,255,255,.14) 合到 #353638 = #515254）只有 2.94:1，差最后
 * 一格。半透明 token 同样不行——`background-clip` 默认 border-box，描边合成的是
 * **徽标自己的底**，不是外面的表面。描边两态都是 1px，只有线型与颜色变，
 * 盒子尺寸恒定。
 *
 * emphasis 必须是**双层环**：`#4176e6` 的环画在 `#4868b2` 的徽标底上只有
 * 1.27:1，等于没画。内环取页面色把徽标与外环隔开，外环才有东西可比：
 *   内环(bg-base) / 徽标底   浅 5.39:1  深 3.39:1
 *   外环(business-primary) / 页面  浅 4.23:1  深 6.86:1
 * 静息态写**同样结构**但两层都透明——盒子尺寸恒定，emphasis 切换零布局位移
 * （沿用旧实现的 box-shadow 技巧）。emphasis **只**出现在正文层（标签与引用
 * 列表两处都传 `emphasis={false}`），所以内环取 `bg-base` 才成立；哪天让它出现
 * 在 bg-layer-3 上，这两行要重新审。
 *
 * `detached` 保留原来的虚线外观：它只出现在引用列表里（正文侧本来就不画），
 * 那里需要一眼看出「这条的原文没了」。
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
        // 静息态的实心描边就是 1.4.11 的那条边界（深色 bg-layer-3 上徽标底只有
        // 2.25:1，撑不起来）；detached 换成虚线 + 更浅的 tertiary，两态都是 1px。
        border: detached
          ? '1px dashed var(--dsw-alias-label-tertiary, #81858c)'
          : '1px solid var(--dsw-alias-label-secondary, #61666b)',
        // 两层环的结构在静息/强调两态里完全一致，只有颜色变 —— 盒子尺寸恒定。
        boxShadow: detached
          ? 'none'
          : emphasis
            ? '0 0 0 2px var(--dsw-alias-bg-base, #fff), 0 0 0 4px var(--dsw-alias-state-business-primary, #4176e6)'
            : '0 0 0 2px transparent, 0 0 0 4px transparent',
        background: detached ? 'transparent' : 'var(--dsw-static-deepseek-600, #4868b2)',
        color: detached
          ? 'var(--dsw-alias-label-secondary, #61666b)'
          : 'var(--dsw-static-neutral-bluish-00, #fff)',
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
 * zIndex 897 是这一族浮层的最底层（897 徽标 / 898 标签 / 899 卡片与引用列表 /
 * 900 划词工具条），全部压在宿主 100/101 档之上、1000 档模态之下
 * （层级考据见 selection-actions.tsx 的 zIndex 注释）。16px 的蓝点绝不该画在
 * 卡片上面，所以徽标从 899 降到 897。
 */
export function QuoteBadgeLayer({ badges, activeItemId, onHover, onSelect }: QuoteBadgeLayerProps) {
  if (typeof document === 'undefined' || badges.length === 0) return null
  return createPortal(
    <div
      data-dsh-quote-overlay
      aria-hidden="true"
      role="presentation"
      style={{ position: 'fixed', top: 0, left: 0, width: 0, height: 0, zIndex: 897 }}
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
