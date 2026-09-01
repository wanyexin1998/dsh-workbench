// 就地高亮的**非侵入**绘制层。
//
// 硬约束（AGENTS.md）：宿主 Conversation 只能在显式 SessionProvider 下复用，
// 「never copy it or patch private DOM/store state」。所以这里一个宿主节点都
// 不碰——不包 <span>、不改 innerHTML、不写属性。唯一交给浏览器的东西是
// Range 对象本身（CSS Custom Highlight API），色带由渲染引擎自己画在文字下方，
// DOM 树完全不变。
//
// 选它而不是覆盖层矩形的理由（Chrome 151 / Edge 152 实测）：
//   * 更新代价为零——滚动、重排、缩放、换行全由浏览器重绘；覆盖层要每帧
//     N×getClientRects()，多行选区 N 个色块，还得自己接 scroll/ResizeObserver/rAF；
//   * 原生绘制在文字**下方**，正文颜色不受影响；覆盖层盖在文字上，半透明糊字、
//     mix-blend-mode 又得按主题在 darken/lighten 之间切；
//   * 规范定义自定义高亮在 ::selection **之下**，用户新拉的选区照常可见。
// 覆盖层唯一赢的一项是圆角（::highlight() 没有盒模型），而徽标本来就要绝对
// 定位，圆角在徽标那边拿回来。

import {
  BUSINESS_ROW_SELECTOR, QUOTE_HIGHLIGHT_ACTIVE_NAME, QUOTE_HIGHLIGHT_NAME,
  QUOTE_HIGHLIGHT_TINT_NAME, captureConversationRange, findBusinessRow, resolveRowRange,
  tintableSubRanges, type QuoteBand,
} from './conversation-dom.js'
import { MAX_SELECTION_BYTES } from './selection-contract.js'
import type { SelectionAggregateItem } from './selection-reference.js'

/**
 * 一条引用相对当前 DOM 的四态。
 *   anchored   复核全过，且末行落在滚动容器的可见带内
 *   offscreen  复核过，但末行**确实**滚出了可见带（色带还在，滚过去自然看见；
 *              正文徽标隐藏）
 *   unmeasured 复核全过，只是这一帧量不出几何：滚动容器还没找到 / 还没布局
 *              （带高为 0），或 Range 拿不到客户区矩形。它**不是** offscreen ——
 *              "量不出来"和"滚出视口"是两回事，把前者报成后者等于对屏读用户
 *              念一句假的「原文当前不在视野内」。
 *   detached   行不在了，或复核不通过（含原文被编辑过）
 *
 * `detached` **不**代表引用失效：发送时序列化的是捕获时冻结的 `item.text`，
 * 与 DOM 死活无关。fail-closed 管的是改变状态的动作，不管装饰。
 */
export type QuoteAnchorState = 'anchored' | 'offscreen' | 'unmeasured' | 'detached'

export interface QuoteAnchor {
  readonly row: HTMLElement
  readonly range: Range
  /**
   * 可以铺底色的子 Range（`tintableSubRanges`）。**在解析期一次造好**，
   * 测量帧只收集不重建 —— 否则每帧都是新对象，`samePublication` 的身份判据
   * 立刻失效，滚动时又变回每帧一次 `new Highlight()`。
   */
  readonly tinted: readonly Range[]
}

/**
 * 从草稿里的引用身份现场重解析出一条 Range，并交给**现有的判官**复核。
 *
 * 这里刻意不写第二套校验：解析出的候选 Range 直接喂回
 * `captureConversationRange`，于是 `rowIsStreaming` / `elementIsVisible` /
 * `intersectsControl` / 控件不可选这些既有规则全部自动继承，和
 * `SelectionController#validateActive` 是同一个判官的两个调用点。
 *
 * pane 归属用与 `#validateActive` 完全相同的写法（`!== undefined &&
 * !== parentSessionId`）：宿主没有 `[data-session-pane]` 时不存在"画进别的
 * Pane"这件事，而一旦有 pane 且不匹配就必须拒绝（ADR-0009）。
 */
export function resolveQuoteAnchor(item: SelectionAggregateItem, scope: ParentNode): QuoteAnchor | null {
  const row = findBusinessRow(scope, item.nodeKey)
  if (row === null) return null
  const range = resolveRowRange(row, item.startOffset, item.endOffset)
  if (range === null) return null
  const capture = captureConversationRange(range, MAX_SELECTION_BYTES)
  if (capture === null) return null
  if (capture.nodeKey !== item.nodeKey || capture.nodeKind !== item.nodeKind) return null
  if (capture.startOffset !== item.startOffset || capture.endOffset !== item.endOffset) return null
  // 原文被编辑过时偏移还在、文本已变 —— 绝不重新吸附到别的片段，宁可不画。
  if (capture.text !== item.text) return null
  if (capture.paneSessionId !== undefined && capture.paneSessionId !== item.parentSessionId) return null
  return { row: capture.row, range, tinted: tintableSubRanges(range, capture.row) }
}

/* ── 重解析闸门 ────────────────────────────────────────────────────────── */

function nodeListTouchesBusinessRow(nodes: NodeList): boolean {
  for (const node of Array.from(nodes)) {
    if (!(node instanceof Element)) continue
    if (node.matches(BUSINESS_ROW_SELECTOR) || node.querySelector(BUSINESS_ROW_SELECTOR) !== null) return true
  }
  return false
}

function insideAnchoredRow(target: Node, rows: readonly HTMLElement[]): boolean {
  for (const row of rows) {
    if (row === target || row.contains(target)) return true
  }
  return false
}

/**
 * 这一批 MutationRecord 里有没有**可能影响已锚定引用**的变更。
 *
 * 观察器挂在整个会话根上，`{childList, characterData, subtree}` 会把流式输出的
 * 每一帧都送进来（模型每吐一个 token 就是一条 characterData）。不过滤地直通
 * 重解析 = 每帧对每条引用跑一遍 `eligibleTextNodes`（每个文本节点一次
 * `getComputedStyle`），这是这套图层里最贵的一步。
 *
 * 判据（保守但够窄）：
 *   childList     加/删的节点里出现（或包含）业务行 → 相关。行的出现与消失是
 *                 detached ⇄ anchored 的唯一来源（虚拟化换出换入、历史重载、
 *                 Pane 切换、新消息落地），必须放行。
 *   其余（含 characterData）→ 只有发生在**已锚定行内部**的变更才相关。
 *
 * 流式那条洪流正好整段落在判据之外：引用只能指向 settled 行
 * （`captureConversationRange` 拒绝 `rowIsStreaming`），正在流式的那一行永远
 * 不是已锚定行，它内部的 characterData / childList 一条都进不来。
 *
 * 一条引用都没锚定住时（`rows` 为空）仍然放行业务行级别的增删——否则
 * detached 的条目再也等不到"行回来了"的那一刻。
 */
export function quoteMutationsMatter(
  records: readonly MutationRecord[],
  rows: readonly HTMLElement[],
): boolean {
  for (const record of records) {
    if (record.type === 'childList'
      && (nodeListTouchesBusinessRow(record.addedNodes) || nodeListTouchesBusinessRow(record.removedNodes))) {
      return true
    }
    if (insideAnchoredRow(record.target, rows)) return true
  }
  return false
}

/* ── 绘制缝 ────────────────────────────────────────────────────────────── */

/** 注入式画笔。真实实现打到 `CSS.highlights`；测试注入假体，断言"发布了哪几条
 * Range"，不需要浏览器。 */
export interface QuoteHighlightPainter {
  set(name: string, ranges: readonly Range[], priority: number): void
  delete(name: string): void
}

interface HighlightLike {
  priority: number
}

interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): unknown
  delete(name: string): unknown
}

type HighlightConstructor = new (...ranges: Range[]) => HighlightLike

/**
 * 能力探测。`typeof view.CSS` 这一段是必需的：jsdom 里 `window.CSS` 整个不
 * 存在，裸写 `CSS.highlights` 会抛。
 */
export function supportsHighlightApi(): boolean {
  return cssHighlightPainter() !== null
}

export function cssHighlightPainter(): QuoteHighlightPainter | null {
  const view = globalThis as unknown as {
    CSS?: { highlights?: HighlightRegistryLike }
    Highlight?: HighlightConstructor
  }
  const registry = view.CSS?.highlights
  const Ctor = view.Highlight
  if (registry === undefined || registry === null || typeof Ctor !== 'function') return null
  return {
    set(name, ranges, priority) {
      const highlight = new Ctor(...ranges)
      highlight.priority = priority
      registry.set(name, highlight)
    },
    delete(name) {
      registry.delete(name)
    },
  }
}

export interface QuotePublication {
  readonly ranges: readonly Range[]
  readonly active: readonly Range[]
  /** 只铺底色那一份。`ranges` 的子集（按覆盖的文字算），不是它的别名。 */
  readonly tinted: readonly Range[]
}

/**
 * **单一全局所有者。** `CSS.highlights` 是 document 级注册表，而
 * `::highlight(name)` 没有通配选择器——两个 Pane 各自 `set()` 会互相覆盖，
 * 且补不回来。所以各 session 的图层只往这里 publish/withdraw 自己那份，由
 * registry 合并后对每个条目名各做**一次** `set`。
 */
export interface QuoteHighlightRegistry {
  publish(ownerId: string, publication: QuotePublication): void
  withdraw(ownerId: string): void
  /** 当前有多少个所有者在发布（测试与诊断用）。 */
  readonly size: number
}

export function createQuoteHighlightRegistry(painter: QuoteHighlightPainter | null): QuoteHighlightRegistry {
  const owners = new Map<string, QuotePublication>()
  const flush = () => {
    if (painter === null) return
    const ranges: Range[] = []
    const active: Range[] = []
    const tinted: Range[] = []
    for (const publication of owners.values()) {
      ranges.push(...publication.ranges)
      active.push(...publication.active)
      tinted.push(...publication.tinted)
    }
    if (ranges.length === 0) painter.delete(QUOTE_HIGHLIGHT_NAME)
    else painter.set(QUOTE_HIGHLIGHT_NAME, ranges, 0)
    // emphasis 走第二个条目 + priority 1，叠在基础色带之上。
    if (active.length === 0) painter.delete(QUOTE_HIGHLIGHT_ACTIVE_NAME)
    else painter.set(QUOTE_HIGHLIGHT_ACTIVE_NAME, active, 1)
    // 底色走第三个条目 + priority 0：它与下划线设的是不相交的属性，谁在上都一样。
    if (tinted.length === 0) painter.delete(QUOTE_HIGHLIGHT_TINT_NAME)
    else painter.set(QUOTE_HIGHLIGHT_TINT_NAME, tinted, 0)
  }
  return {
    publish(ownerId, publication) {
      owners.set(ownerId, publication)
      flush()
    },
    withdraw(ownerId) {
      if (owners.delete(ownerId)) flush()
    },
    get size() {
      return owners.size
    },
  }
}

// 惰性单例：模块加载时不去碰 globalThis，免得 import 顺序影响探测结果。
let sharedRegistry: QuoteHighlightRegistry | null = null

export function defaultQuoteHighlightRegistry(): QuoteHighlightRegistry {
  sharedRegistry ??= createQuoteHighlightRegistry(cssHighlightPainter())
  return sharedRegistry
}

/* ── 徽标几何（纯函数） ─────────────────────────────────────────────────── */

export const QUOTE_BADGE_HEIGHT = 16
export const QUOTE_BADGE_MIN_WIDTH = 16
/** 徽标与正文列右缘、以及徽标彼此之间的留白。 */
const QUOTE_BADGE_GAP = 4
/** 徽标与可见带右缘之间的留白（滚动条槽已由 `quoteBand` 扣掉）。 */
const QUOTE_BADGE_EDGE_INSET = 4
/** 避让重叠时最多挪几次。挪满还撞就收下最后一个位置——错开一点也远好过
 * 逐字节重合（那是"一个徽标完全消失"）。 */
const QUOTE_BADGE_MAX_SHIFTS = 8

/** 徽标宽度：一位数是正圆，多位数按 11px/600 字宽外扩。定位要先知道宽度才能
 * 右对齐，所以这里给的是与内联样式（minWidth 16 + padding 0 4px）一致的估算。 */
export function quoteBadgeWidth(label: string): number {
  return Math.max(QUOTE_BADGE_MIN_WIDTH, 8 + label.length * 7)
}

export interface QuoteBadgePoint {
  readonly top: number
  readonly left: number
}

/** 本帧已经放好的一枚徽标。避让只需要盒子，不需要知道它属于谁。 */
export interface QuoteBadgeBox extends QuoteBadgePoint {
  readonly width: number
  readonly height: number
}

/**
 * 带子量到了没有。高度为 0 的带子说的是"滚动容器还没布局"，不是"滚出视口"，
 * 两个调用点都要按这个区分走（`QuoteAnchorState.unmeasured`）。
 */
export function quoteBandIsMeasured(band: QuoteBand | null): band is QuoteBand {
  return band !== null && band.bottom > band.top
}

function collidesWithTaken(
  point: QuoteBadgePoint,
  badge: { readonly width: number; readonly height: number },
  taken: readonly QuoteBadgeBox[],
): boolean {
  for (const box of taken) {
    if (point.left < box.left + box.width + QUOTE_BADGE_GAP
      && box.left < point.left + badge.width + QUOTE_BADGE_GAP
      && point.top < box.top + box.height
      && box.top < point.top + badge.height) return true
  }
  return false
}

/**
 * 徽标落点：正文列**之外**的外侧留白；放不下才退回引用末行的实际末端。
 *
 * 为什么不能钉在行右缘（本函数的前一版是 `rowRect.right - inset - width`）：
 * 宿主 `.flowItem` 只有 `min-width: 0`，没有右内边距，行右缘**就是**正文列
 * 边界。引用结束在段落中间时（最常见），末行是一整行排到列边界的正文，钉在
 * 那里的徽标直接盖住最后一两个字。旧注释里"停在行尾留白永不遮挡"只在"引用
 * 末行恰好也是段落末行"时成立。中文排版下这条尤其致命：中文行内没有词间
 * 空格，满行的行末一定是一个真实字形，没有任何可借的留白；英文 ragged-right
 * 至少常常还剩几十像素。
 *
 * 规则（取第一个成立的）：
 *   1. 外侧留白 `rowRect.right + GAP`，要求整枚徽标仍落在可见带内。列外没有
 *      正文，**结构上**不可能遮挡。宿主这里的外侧留白恒 ≥ 32px
 *      （`.scroll` 的 `padding: 16px calc(--dsh-composer-side-clearance + 16px)`，
 *      clearance = 16px），装得下 16px 徽标 + 两侧各 4px，所以这一档在本宿主
 *      是常态；副产品与旧版一致：多条引用的徽标自然排成右侧一列。
 *   2. 引用末端 `lastRect.right + GAP`（钳进可见带）。只有正文列一直顶到滚动
 *      容器边缘、外侧根本没有留白的宿主才会走到这里。此时遮挡不可避免，而
 *      "紧跟引用末尾"是脚注语义本来的位置、代价也最小：引用收在行尾/段尾时
 *      一个字都不盖（中文段落末行通常离列边界还远），收在行中时也只盖紧挨
 *      引用末尾的一两个字，而不是读者换行时视线落点的行末。
 *
 * `taken` 是本帧已放好的徽标盒子。两条引用的末行落在**同一视觉行**时落点会
 * 逐字节相同、一个把另一个整个盖掉，所以放好之前先避让：同一行上先往右排
 * （外侧留白是空的），排不下再整体上移一层（往下会压住下一行的落点）。
 *
 * 返回 `null` = 该行整个不在可见带内（`offscreen`）。这时**不画**徽标，也不把
 * 它钳到带子边缘——钳住的徽标是在撒谎，指着一个不在那儿的位置。行与带子有
 * 交集时才钳，那属于"行只露出一点"的正常情形。
 */
export function placeQuoteBadge(
  lastRect: { readonly top: number; readonly bottom: number; readonly right: number },
  rowRect: { readonly right: number },
  band: QuoteBand,
  badge: { readonly width: number; readonly height: number },
  taken: readonly QuoteBadgeBox[] = [],
): QuoteBadgePoint | null {
  if (!quoteBandIsMeasured(band)) return null
  if (lastRect.bottom <= band.top || lastRect.top >= band.bottom) return null
  const centred = lastRect.top + (lastRect.bottom - lastRect.top - badge.height) / 2
  const top = Math.min(Math.max(centred, band.top), Math.max(band.top, band.bottom - badge.height))
  const rightBound = band.right - QUOTE_BADGE_EDGE_INSET
  const outside = rowRect.right + QUOTE_BADGE_GAP
  const left = outside + badge.width <= rightBound
    ? outside
    : Math.min(lastRect.right + QUOTE_BADGE_GAP, rightBound - badge.width)
  return avoidTakenBadges({ top, left }, badge, band, taken)
}

function avoidTakenBadges(
  point: QuoteBadgePoint,
  badge: { readonly width: number; readonly height: number },
  band: QuoteBand,
  taken: readonly QuoteBadgeBox[],
): QuoteBadgePoint {
  const rightBound = band.right - QUOTE_BADGE_EDGE_INSET
  let current = point
  for (let shift = 0; shift < QUOTE_BADGE_MAX_SHIFTS; shift += 1) {
    if (!collidesWithTaken(current, badge, taken)) return current
    const nextLeft = current.left + badge.width + QUOTE_BADGE_GAP
    if (nextLeft + badge.width <= rightBound) {
      current = { top: current.top, left: nextLeft }
      continue
    }
    const nextTop = current.top - (badge.height + 2)
    if (nextTop < band.top) return current
    current = { top: nextTop, left: point.left }
  }
  return current
}

/* ── 胶囊 / 卡片几何（纯函数） ──────────────────────────────────────────── */

/** 浮层与引用末行之间、以及与可见带边缘之间的最小间隙。 */
const QUOTE_CARD_GAP = 6

export interface QuoteCardPlacement {
  readonly top: number
  readonly left: number
  /** true = 下方塞不下，整块翻到引用上方。 */
  readonly above: boolean
}

/**
 * 胶囊 / 评论卡片的落点。
 *
 * 与 `placeSelectionToolbar` **刻意分开**，不是重复：那个首选**上方**、水平
 * 居中并靠 `translateX(-50%)` 落位；这里首选**下方**（截图里卡片从被引用段落
 * 向下展开）、左缘对齐正文列左缘。两条规则都相反，改那一个会动到它现有的 5
 * 条测试，而两个函数各自都只有十几行。
 *
 * 钳制的优先级与 `placeSelectionToolbar` 一致：**先保证可见**。带子矮到上下
 * 都塞不下时宁可压住引用原文，也不能让卡片整块滚出可见带——用户看不到正在
 * 打字的输入框，比输入框贴着原文糟糕得多。带子量不出来（高 ≤ 0）时不钳，
 * 与 `placeSelectionToolbar` 的 `viewport.height > 0` 门槛同形。
 */
export function placeQuoteCard(
  lastRect: { readonly top: number; readonly bottom: number },
  rowRect: { readonly left: number },
  size: { readonly width: number; readonly height: number },
  band: QuoteBand,
): QuoteCardPlacement {
  const below = lastRect.bottom + QUOTE_CARD_GAP
  const aboveTop = lastRect.top - QUOTE_CARD_GAP - size.height
  const measured = band.bottom > band.top
  // 下方塞得下就用下方；塞不下才看上方；两边都塞不下仍取下方，再由钳制兜住。
  // 带子量不出来时**一律**用下方：一条高为 0 的带子说"还没布局"，拿它当
  // "下方没空间"的证据，会让卡片在首帧就无缘无故翻到原文上方去。
  const above = measured
    && below + size.height > band.bottom - QUOTE_CARD_GAP
    && aboveTop >= band.top + QUOTE_CARD_GAP
  const rawTop = above ? aboveTop : below
  const top = measured
    ? Math.min(Math.max(rawTop, band.top), Math.max(band.top, band.bottom - size.height))
    : rawTop
  const wide = band.right > band.left
  const left = wide
    ? Math.min(Math.max(rowRect.left, band.left), Math.max(band.left, band.right - size.width))
    : rowRect.left
  return { top, left, above }
}

/**
 * 末行矩形。取 `getClientRects()` 的**最后一条**是脚注语义——"引用到此为止，
 * 编号在后"。`right` 是引用文字**真正的末端**（徽标落点第 2 档要它），与行
 * 容器的右缘是两回事。jsdom 里 `Range.getClientRects` 根本不存在（覆盖层方案
 * 在这点上并无可测性优势），所以必须探测后再调；探测不到 = 几何未知
 * （`unmeasured`），不是"不在视野内"。
 */
export function lastLineRect(
  range: Range,
): { readonly top: number; readonly bottom: number; readonly right: number } | null {
  if (typeof range.getClientRects !== 'function') return null
  const rects = range.getClientRects()
  const last = rects.length > 0 ? rects[rects.length - 1] : undefined
  return last === undefined ? null : { top: last.top, bottom: last.bottom, right: last.right }
}

/** 无障碍名里的原文摘要：折掉换行、限长、超长补省略号。 */
export function quoteExcerpt(text: string, limit = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}
