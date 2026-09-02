// Adapter layer — the ONLY module allowed to touch conversation DOM
// structure (ADR-0001). Everything here is replaceable when the upstream
// ConversationNavigation service + overlay seat land (issue #1).
import type { ContentBlockView, InputNodeView } from '../core/derive-index.js'

export const SCROLLPORT_SELECTOR = '[data-conversation-scroll]'
export const ANCHOR_SELECTOR = '[data-chat-anchor-key]'
export const COMPOSER_SELECTOR = '[data-composer-seat]'
export const SESSION_PANE_SELECTOR = '[data-session-pane]'
export const CHAT_FLOW_SELECTOR = '[data-chat-flow]'
export const BUSINESS_ROW_SELECTOR = '[data-chat-anchor-key][data-chat-flow-key]'
export const SELECTION_CONTROL_SELECTOR = [
  'a[href]', 'button', 'input', 'textarea', 'select', 'option',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]', '[role="link"]', '[role="menuitem"]',
  '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="tab"]',
].join(',')
/** Matches the editable node inside one composer seat — textarea, plain
 * text input, or a contenteditable variant. Shared by composer-focus (L0)
 * and the W2 host-command composer-insert mapping. */
export const COMPOSER_EDITABLE_SELECTOR =
  'textarea, input[type="text"], [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'

/**
 * Resolve the DOM scope for one focused session's pane, falling back to
 * `document` when there is no focused session id or no pane element carries
 * a matching `[data-session-pane]`. Pure DOM lookup — deliberately decoupled
 * from `HarnessServices`/`focusedSessionId` (harness-adapter.ts) so this
 * adapter module never needs to know about the ctx/services boundary,
 * matching ADR-0001 ("the ONLY module allowed to touch conversation DOM
 * structure"). Callers resolve the session id first (harness-adapter.ts's
 * `focusedSessionId`) and pass the plain string in here.
 */
export function focusedPaneScope(focusedSessionId: string | undefined, root: ParentNode = document): ParentNode {
  if (focusedSessionId === undefined) return root
  for (const pane of Array.from(root.querySelectorAll<HTMLElement>(SESSION_PANE_SELECTOR))) {
    if (pane.dataset.sessionPane === focusedSessionId) return pane
  }
  return root
}

/** Locate the editable composer element inside one DOM scope (a pane, or
 * `document` for the fallback case), or `null` when no composer seat /
 * editable child is present in that scope. */
export function locateComposerInput(scope: ParentNode): HTMLElement | null {
  const seat = scope.querySelector(COMPOSER_SELECTOR)
  const target = seat?.querySelector(COMPOSER_EDITABLE_SELECTOR)
  return target instanceof HTMLElement ? target : null
}

/** DOM-only selection facts. Session identity and node state are verified by selection-controller. */
export interface ConversationRangeCapture {
  readonly row: HTMLElement
  readonly range: Range
  readonly focusScope: ParentNode
  readonly paneSessionId: string | undefined
  readonly nodeKey: string
  readonly nodeKind: string
  readonly text: string
  readonly startOffset: number
  readonly endOffset: number
  readonly rect: { x: number; y: number; width: number; height: number }
}

function elementAt(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement
}

function normalizedVisibleText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** 这一层自己藏没藏起来 —— **不看**祖先。 */
function selfIsVisible(element: Element, view: Window | null): boolean {
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return false
  const style = view?.getComputedStyle(element)
  return style?.display !== 'none' && style?.visibility !== 'hidden' && style?.visibility !== 'collapse'
}

/**
 * `element` 到 `boundary`（含）这一路上有没有被藏起来；走到顶都没碰到
 * `boundary` = 它根本不在里面，同样是 false。
 *
 * `memo` 是**一次遍历之内**的答案表，只在边界固定时有效（`eligibleTextNodes`
 * 的边界恒为 row）。没有它，一行里每个文本节点都要把自己到 row 的整条祖先链
 * 重走一遍 `getComputedStyle`，而代码块里**每个 shiki token 都是一个文本节点**、
 * 整条链被成百上千个 token 共用 —— 那是这一族函数里最贵的一步。
 *
 * 实测（jsdom，一条 400 个文本节点的行 = 40 段正文 + 40 行 × 6 token 的代码块，
 * 数的是一次 `resolveQuoteAnchor` 里 `getComputedStyle` 的调用次数，确定性指标）：
 *   本函数 + `insideRowControl` + `insidePaintedSurface` 三张表一起上
 *   4083 次 → 1089 次；墙钟中位数 530ms → 300ms。
 * 表的生命周期只有这一次遍历，所以不存在"DOM 变了缓存没失效"这回事。
 */
function elementIsVisible(element: Element, boundary: Element, memo?: Map<Element, boolean>): boolean {
  const view = element.ownerDocument.defaultView
  // chain 里的每一层都是"自己没藏起来、且还没走到 boundary"，所以它们的答案
  // 与最终 answer 逐字相同 —— 一次填完，下一个文本节点直接命中。
  const chain: Element[] = []
  let answer: boolean | null = null
  let current: Element | null = element
  while (current !== null) {
    const cached = memo?.get(current)
    if (cached !== undefined) { answer = cached; break }
    chain.push(current)
    if (!selfIsVisible(current, view)) { answer = false; break }
    if (current === boundary) { answer = true; break }
    current = current.parentElement
  }
  const resolved = answer ?? false
  if (memo !== undefined) for (const link of chain) memo.set(link, resolved)
  return resolved
}

/**
 * 这个元素在不在**本行内部**的某个控件里（控件内的文字一律不可选）。
 *
 * 手写这条向上走的链，而不是 `element.closest(SELECTION_CONTROL_SELECTOR)`：
 * `closest` 每次都要拿那串 14 个选择器在整条祖先链上逐层匹配一遍，而一行里
 * 上千个文本节点共用同一条链。带 memo 的走法把它压成"每个元素一次 `matches`"。
 *
 * 走到 `row`（含）就停：`row` 之上的匹配落在行外面，原来的判据
 * （`control !== null && row.contains(control)`）对它恒为 false，与"没有控件"
 * 等价，继续往上走只是白花钱。
 */
function insideRowControl(element: Element, row: HTMLElement, memo: Map<Element, boolean>): boolean {
  const chain: Element[] = []
  let answer: boolean | null = null
  let current: Element | null = element
  while (current !== null) {
    const cached = memo.get(current)
    if (cached !== undefined) { answer = cached; break }
    chain.push(current)
    if (current.matches(SELECTION_CONTROL_SELECTOR)) { answer = true; break }
    if (current === row) { answer = false; break }
    current = current.parentElement
  }
  const resolved = answer ?? false
  for (const link of chain) memo.set(link, resolved)
  return resolved
}

function eligibleTextNodes(row: HTMLElement): Text[] {
  const nodes: Text[] = []
  const showText = row.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4
  const walker = row.ownerDocument.createTreeWalker(row, showText)
  // 两张表都只活到本次遍历结束。同一个父元素通常挂着好几个文本节点，代码块里
  // 更是整条祖先链被成百上千个 token 共用。
  const visible = new Map<Element, boolean>()
  const controlled = new Map<Element, boolean>()
  let current = walker.nextNode()
  while (current !== null) {
    if (current instanceof Text) {
      const parent = current.parentElement
      if (parent !== null && !insideRowControl(parent, row, controlled)
        && elementIsVisible(parent, row, visible)) nodes.push(current)
    }
    current = walker.nextNode()
  }
  return nodes
}

function intersectsControl(range: Range, row: HTMLElement): boolean {
  for (const control of Array.from(row.querySelectorAll(SELECTION_CONTROL_SELECTOR))) {
    try {
      if (range.intersectsNode(control)) return true
    } catch {
      return true
    }
  }
  return false
}

function rowIsStreaming(row: HTMLElement): boolean {
  if (row.getAttribute('data-streaming') === 'true') return true
  return row.querySelector('[data-streaming="true"]') !== null
}

/**
 * Resolve a browser Range inside one verified business row. This function is
 * deliberately strict: unsupported DOM endpoints fail closed instead of
 * guessing offsets or falling back to the document's first conversation.
 */
export function captureConversationRange(range: Range, maxBytes: number): ConversationRangeCapture | null {
  if (range.collapsed || !(range.startContainer instanceof Text) || !(range.endContainer instanceof Text)) return null
  const startElement = elementAt(range.startContainer)
  const endElement = elementAt(range.endContainer)
  const startRow = startElement?.closest<HTMLElement>(BUSINESS_ROW_SELECTOR) ?? null
  const endRow = endElement?.closest<HTMLElement>(BUSINESS_ROW_SELECTOR) ?? null
  if (startRow === null || startRow !== endRow || !startRow.isConnected || rowIsStreaming(startRow)) return null

  const startFlow = startElement?.closest<HTMLElement>(CHAT_FLOW_SELECTOR) ?? null
  const endFlow = endElement?.closest<HTMLElement>(CHAT_FLOW_SELECTOR) ?? null
  if (startFlow === null || startFlow !== endFlow || intersectsControl(range, startRow)) return null

  const startPane = startElement?.closest<HTMLElement>(SESSION_PANE_SELECTOR) ?? null
  const endPane = endElement?.closest<HTMLElement>(SESSION_PANE_SELECTOR) ?? null
  if (startPane !== endPane) return null
  const paneSessionId = startPane?.dataset.sessionPane
  if (startPane !== null && (paneSessionId === undefined || paneSessionId.length === 0)) return null

  const nodeKey = startRow.dataset.chatFlowKey
  const nodeKind = startRow.dataset.chatFlowKind
  if (nodeKey === undefined || nodeKey.length === 0 || nodeKind === undefined || nodeKind.length === 0) return null
  if (!elementIsVisible(startRow, startRow)) return null

  const nodes = eligibleTextNodes(startRow)
  const startIndex = nodes.indexOf(range.startContainer)
  const endIndex = nodes.indexOf(range.endContainer)
  if (startIndex < 0 || endIndex < startIndex) return null
  if (range.startOffset < 0 || range.startOffset > range.startContainer.data.length) return null
  if (range.endOffset < 0 || range.endOffset > range.endContainer.data.length) return null

  let cursor = 0
  let startOffset = -1
  let endOffset = -1
  let rowText = ''
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!
    const normalized = normalizedVisibleText(node.data)
    if (index === startIndex) startOffset = cursor + normalizedVisibleText(node.data.slice(0, range.startOffset)).length
    if (index === endIndex) endOffset = cursor + normalizedVisibleText(node.data.slice(0, range.endOffset)).length
    rowText += normalized
    cursor += normalized.length
  }
  if (startOffset < 0 || endOffset <= startOffset) return null
  const text = rowText.slice(startOffset, endOffset)
  if (new TextEncoder().encode(text).byteLength > maxBytes) return null

  const rect = typeof range.getBoundingClientRect === 'function'
    ? range.getBoundingClientRect()
    : { x: 0, y: 0, width: 0, height: 0 }
  const focusScope = startPane ?? startRow.closest<HTMLElement>('.ConversationRoot_root[data-phase]') ?? startFlow
  return {
    row: startRow,
    range: range.cloneRange(),
    focusScope,
    paneSessionId,
    nodeKey,
    nodeKind,
    text,
    startOffset,
    endOffset,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  }
}

/**
 * 归一化偏移 → 该文本节点内的**原始**（未归一化）偏移。
 *
 * `normalizedVisibleText` 把 `\r\n` 折成一个 `\n`，所以含 CR 的节点里两套坐标
 * 会错位；逐字符走一遍是唯一能对上的办法（节点通常只有几十个字符，代价可忽略）。
 * 落在 `\r\n` 中间的归一化偏移返回较小的那个原始偏移——`captureConversationRange`
 * 对 raw 2 和 raw 3 会算出同一个归一化值，两者往返等价。
 */
function rawOffsetIn(data: string, normalizedOffset: number): number {
  let normalized = 0
  let raw = 0
  while (normalized < normalizedOffset && raw < data.length) {
    raw += data[raw] === '\r' && data[raw + 1] === '\n' ? 2 : 1
    normalized += 1
  }
  return raw
}

interface RowTextPoint {
  readonly node: Text
  readonly offset: number
}

/**
 * 把一个行内归一化偏移落回 (文本节点, 原始偏移)。
 *
 * 两端用不同的半开区间，边界才不会二义：起点取 `[cursor, cursor+len)`（落在
 * 两节点交界处时归到**后**一个节点的 0），终点取 `(cursor, cursor+len]`（交界
 * 处归到**前**一个节点的末尾）。这正好复现 `captureConversationRange` 的累加
 * 结果——它对这两种落点算出的归一化偏移完全相同，所以往返是恒等的。
 */
function locateRowPoint(nodes: readonly Text[], target: number, edge: 'start' | 'end'): RowTextPoint | null {
  let cursor = 0
  for (const node of nodes) {
    const length = normalizedVisibleText(node.data).length
    if (length > 0) {
      const hit = edge === 'start'
        ? target >= cursor && target < cursor + length
        : target > cursor && target <= cursor + length
      if (hit) return { node, offset: rawOffsetIn(node.data, target - cursor) }
    }
    cursor += length
  }
  return null
}

/**
 * `captureConversationRange` 的逆函数：从身份（行 + 归一化偏移区间）重建一条
 * 新的 DOM Range。
 *
 * 为什么必须重建而不是持有旧 Range：宿主每次重渲染替换文本节点，旧 Range 的
 * 两端会按 DOM 规范上移到父元素，于是 `startContainer.isConnected` **依然是
 * `true`**（父元素还连着），但 `collapsed` 变成 `true`、`toString()` 变成空串。
 * 拿 `isConnected` 当存活判据会一路骗到底，所以已入坞的引用一律不持有 Range，
 * 每次重绘都从身份现场重解析。
 *
 * 偏移坐标系必须与捕获端完全一致，所以这里复用同一组 `eligibleTextNodes` +
 * `normalizedVisibleText`，不另起一套遍历——否则控件/不可见节点的取舍一旦
 * 分叉，偏移就会整体漂移。
 */
export function resolveRowRange(row: HTMLElement, startOffset: number, endOffset: number): Range | null {
  // 只留这一条入口校验。`startOffset < 0` / `endOffset <= startOffset` 都试过，
  // 但它们杀不动：负偏移在 locateRowPoint 里落不到任何节点（`target >= cursor`
  // 直接失败），倒置/相等的区间又会被下面的 `range.collapsed` 拦住 —— 变异实测
  // 把这两条删掉，测试一条都不红。留着就是不可验证的重复。非整数偏移是唯一
  // 真会漏过去的输入：rawOffsetIn 会在半个字符处停下并静默产出一条 Range。
  if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset)) return null
  const nodes = eligibleTextNodes(row)
  const start = locateRowPoint(nodes, startOffset, 'start')
  const end = locateRowPoint(nodes, endOffset, 'end')
  if (start === null || end === null) return null
  const range = row.ownerDocument.createRange()
  try {
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
  } catch {
    return null
  }
  return range.collapsed ? null : range
}

/* ── 底色分流 ──────────────────────────────────────────────────────────── */

/**
 * 这个元素自己画不画背景。
 *
 * `background-color` 的 alpha > 0，或者有 `background-image`（渐变也算），
 * 都表示"这块文字坐在一块自备的底色上"。解析不出来的写法（具名色、hex——
 * 计算值里不会出现，但引擎/测试替身可能给）一律**当作有底色**：多留一块不铺，
 * 比错铺一块安全。
 */
function paintsOwnBackground(style: CSSStyleDeclaration): boolean {
  const image = style.backgroundImage
  if (image !== '' && image !== 'none') return true
  const color = style.backgroundColor.trim()
  if (color === '' || color === 'transparent') return false
  const match = /^rgba?\(([^)]*)\)$/.exec(color)
  if (match === null) return true
  // `rgba(0, 0, 0, 0)` 与 `rgb(0 0 0 / 0%)` 两种写法都要认。
  const parts = match[1]!.replace(/[,/]/g, ' ').trim().split(/\s+/)
  if (parts.length < 4) return true
  return Number.parseFloat(parts[3]!) !== 0
}

/**
 * 从 `node` 向上走到 `row`（含）为止，有没有任何一层自己画背景。
 *
 * `memo` 与 `elementIsVisible` 那张表同理，只活一次遍历：代码块里每个 shiki
 * token 都是一个文本节点，而它们共用同一条祖先链（token span → 行 span → pre），
 * 不缓存就是把同一串 `getComputedStyle` 按 token 数重放一遍。
 */
function insidePaintedSurface(node: Node, row: HTMLElement, memo: Map<Element, boolean>): boolean {
  const view = row.ownerDocument.defaultView
  if (view === null || view === undefined) return true
  // chain 里的每一层都是"自己不画背景、且还没走到 row"，答案与 resolved 相同。
  const chain: Element[] = []
  let answer: boolean | null = null
  let current: Element | null = elementAt(node)
  while (current !== null) {
    const cached = memo.get(current)
    if (cached !== undefined) { answer = cached; break }
    chain.push(current)
    if (paintsOwnBackground(view.getComputedStyle(current))) { answer = true; break }
    if (current === row) { answer = false; break }
    current = current.parentElement
  }
  const resolved = answer ?? false
  for (const link of chain) memo.set(link, resolved)
  return resolved
}

/**
 * 把一条引用 Range 拆成「可以安全铺底色」的子 Range。
 *
 * 为什么需要它：`::highlight()` 的 `background-color` **盖掉元素自己的背景**，
 * 而宿主里有一整族「自带背景、文字颜色是照那块背景调的」表面——代码块里的
 * shiki 语法色、ReadBlock、DiffBlock 的增删行。给它们铺一层淡蓝，文字就掉到
 * 一个谁也没审过的底色上（实测数据见 QUOTE_HIGHLIGHT_CSS 的注释）。
 *
 * 拆分判据是**元素自己画不画背景**，而不是一串 `pre, code, [data-read] …`
 * 选择器：后者漏一个就回归，而且那是把宿主私有结构抄进样式表。判据由
 * `getComputedStyle` 现场读出，宿主新增哪种自绘表面都自动落在正确一侧。
 *
 * 宿主 DOM 全程只读：TreeWalker 遍历 + getComputedStyle + createRange。
 *
 * **它是本行的第三遍 `eligibleTextNodes`。** 一次 `resolveQuoteAnchor` 里，
 * `resolveRowRange`、`captureConversationRange`、这里各扫一遍同一行，三份结果
 * 逐字相同。真正的复用缝在 `resolveQuoteAnchor`（quote-highlight.ts）——它是唯一
 * 同时看得见这三步的地方，把节点表算一次往下传即可，这三个函数各加一个可选参数
 * 就够；也只有那里能保证三步之间 DOM 没动过。在这一层用模块级缓存做不到那个
 * 保证（没有可靠的失效信号），所以不做。
 *
 * 眼下的代价由上面那三张 memo 表压住：整条流水线的 `getComputedStyle` 从
 * 4083 次降到 1089 次，比加上底色**之前**的两遍（2721 次）还低 60%。
 * 真去掉第三遍还能再省约三分之一，那是一次独立的、跨文件的改动。
 */
export function tintableSubRanges(range: Range, row: HTMLElement): Range[] {
  const doc = row.ownerDocument
  const painted = new Map<Element, boolean>()
  const out: Range[] = []
  let start: { node: Text; offset: number } | null = null
  let end: { node: Text; offset: number } | null = null
  const flush = () => {
    if (start === null || end === null) return
    const sub = doc.createRange()
    try {
      sub.setStart(start.node, start.offset)
      sub.setEnd(end.node, end.offset)
      if (!sub.collapsed) out.push(sub)
    } catch {
      // 端点不可用就丢掉这一段：少铺一块底色，不是错误。
    }
    start = null
    end = null
  }
  for (const node of eligibleTextNodes(row)) {
    let touches = false
    try {
      touches = range.intersectsNode(node)
    } catch {
      touches = false
    }
    if (!touches) {
      flush()
      continue
    }
    const from = node === range.startContainer ? range.startOffset : 0
    const to = node === range.endContainer ? range.endOffset : node.length
    if (to <= from) {
      flush()
      continue
    }
    if (insidePaintedSurface(node, row, painted)) {
      flush()
      continue
    }
    start ??= { node, offset: from }
    end = { node, offset: to }
  }
  flush()
  return out
}

/**
 * Write text into a composer input the React-controlled way (adapter,
 * tracked in issue #1 proposal 4 alongside `focusComposer` — no public
 * composer/draft-write API exists in the harness rc; the one public API this
 * repo did find, `dsh-client-ui-conversation`'s `SessionInput.setDraft`, only
 * writes the draft text with no "focus the composer" verb of its own, so it
 * would still need this same DOM marker for focus anyway — not currently a
 * live consumer of this function, but kept here as the sanctioned adapter
 * seam (ADR-0001) for the next feature that needs to write into the composer).
 *
 * Assigning `.value` directly is a no-op from React's perspective: React
 * replaces the DOM property's own setter with a tracked one so it can
 * detect the change; a plain assignment through the *original* prototype
 * setter still lands the browser-visible value, but React's fiber never
 * learns about it, and the next render can stomp the typed text right back
 * to whatever React thinks the value still is. Grabbing the prototype's
 * *native* setter (before React's override) and calling it directly writes
 * the DOM value bypassing that tracked shortcut, then dispatching a real
 * `input` event is what actually notifies React's synthetic-event listener
 * — the same signal a real keystroke produces. `contenteditable` has no
 * `.value` at all, so `textContent` + the same `input` event is the
 * parallel path for that shape.
 */
export function setComposerValue(target: HTMLElement, text: string): void {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    setter?.call(target, text)
  } else {
    target.textContent = text
  }
  target.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Locate the conversation scrollport within one pane-owned DOM scope. */
export function locateScrollport(root: ParentNode = document): HTMLElement | null {
  const el = root.querySelector(SCROLLPORT_SELECTOR)
  return el instanceof HTMLElement ? el : null
}

export interface ScrollportRect {
  top: number
  bottom: number
  right: number
  height: number
}

export function scrollportRect(scrollport: HTMLElement): ScrollportRect {
  const rect = scrollport.getBoundingClientRect()
  return { top: rect.top, bottom: rect.bottom, right: rect.right, height: Math.max(0, rect.bottom - rect.top) }
}

/**
 * Right inset for a fixed-position rail: distance from the viewport's
 * right edge to the rail, kept clear of the system scrollbar gutter
 * (offsetWidth - clientWidth measures the classic scrollbar width).
 */
export function railInset(scrollport: HTMLElement, rect: { right: number }, baseInset: number): number {
  const scrollbarWidth = Math.max(0, scrollport.offsetWidth - scrollport.clientWidth)
  return window.innerWidth - rect.right + scrollbarWidth + baseInset
}

/** 引用徽标的可见带：滚动容器的视口矩形，右缘已让开滚动条槽（同 `railInset`
 * 的 `offsetWidth - clientWidth` 量法）。徽标绝对定位在这条带子里，带外的行
 * 不画徽标（`offscreen`）。 */
export interface QuoteBand {
  readonly top: number
  readonly bottom: number
  /** 左缘。徽标只需要右缘（它永远靠右），但标签/卡片是有宽度的盒子，
   * 水平钳制两侧都要用，所以带子必须把左缘也说出来。 */
  readonly left: number
  readonly right: number
}

export function quoteBand(scrollport: HTMLElement): QuoteBand {
  const rect = scrollport.getBoundingClientRect()
  const scrollbarWidth = Math.max(0, scrollport.offsetWidth - scrollport.clientWidth)
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right - scrollbarWidth }
}

/**
 * Normalize a render-layer node (harness shape is `unknown`) to the core
 * `InputNodeView` the projection consumes. Render-layer ChatNodes carry their
 * domain payload under `.data` (ChatNodeDataMap); tolerate both shapes
 * defensively. Single narrowing point for the harness node boundary.
 */
export function normalizeInputNode(node: unknown): InputNodeView | null {
  if (typeof node !== 'object' || node === null) return null
  const n = node as Record<string, unknown>
  if (typeof n.kind !== 'string' || typeof n.key !== 'string') return null
  const data = (typeof n.data === 'object' && n.data !== null ? n.data : n) as Record<string, unknown>
  return {
    kind: n.kind,
    key: n.key,
    seq: typeof data.seq === 'number' ? data.seq : 0,
    time: typeof data.time === 'number' ? data.time : undefined,
    content: (Array.isArray(data.content) ? data.content : []) as readonly ContentBlockView[],
  }
}

/**
 * Conversation root for scoping the MutationObserver (sdk-facts.md:
 * `div.ConversationRoot_root[data-phase]`). Null on hosts without the
 * marker — the caller falls back to document.body.
 */
export function locateConversationRoot(root: ParentNode = document): HTMLElement | null {
  const fromScrollport = locateScrollport(root)?.closest<HTMLElement>('.ConversationRoot_root[data-phase]')
  if (fromScrollport) return fromScrollport
  return root.querySelector<HTMLElement>('.ConversationRoot_root[data-phase]') ?? null
}

/** Static presence of the conversation DOM anchors the navigator depends on. */
export interface ConversationDomCapabilities {
  scrollport: boolean
  anchors: boolean
  composer: boolean
}

/** One-shot presence probe for the capability report (GA-030). Pure DOM read,
 * confined to the adapter (ADR-0001). */
export function detectConversationDom(root: ParentNode = document): ConversationDomCapabilities {
  return {
    scrollport: locateScrollport(root) !== null,
    anchors: root.querySelector(ANCHOR_SELECTOR) !== null,
    composer: root.querySelector(COMPOSER_SELECTOR) !== null,
  }
}

export interface HumanAnchorElement {
  key: string
  element: HTMLElement
}

/**
 * GA-032 (Roadmap §9A.7): human-anchor element cache. Structural changes
 * refresh a coalesced (queueMicrotask-merged) snapshot, so the scroll
 * handler only reads cached elements and never re-queries the full DOM
 * per frame.
 */
export function createHumanAnchorCache(scrollport: HTMLElement) {
  let anchors: HumanAnchorElement[] = []
  let refreshQueued = false

  const refresh = () => {
    refreshQueued = false
    anchors = []
    for (const row of Array.from(scrollport.querySelectorAll(ANCHOR_SELECTOR))) {
      const el = row as HTMLElement
      const kind = el.dataset.chatFlowKind
      const key = el.dataset.chatAnchorKey
      if ((kind === 'user' || kind === 'steering') && key !== undefined) {
        anchors.push({ key, element: el })
      }
    }
  }

  const queueRefresh = () => {
    if (refreshQueued) return
    refreshQueued = true
    queueMicrotask(refresh)
  }

  refresh()
  const observer = new MutationObserver(queueRefresh)
  observer.observe(scrollport, { childList: true, subtree: true })

  return {
    snapshot: () => anchors,
    dispose: () => observer.disconnect(),
  }
}

/** Cached anchor elements → rect list for active-tracking (DOM order kept). */
export function anchorRectsFromCache(anchors: readonly HumanAnchorElement[]): Array<{ key: string; top: number }> {
  const rects: Array<{ key: string; top: number }> = []
  for (const anchor of anchors) {
    if (!anchor.element.isConnected) continue
    rects.push({ key: anchor.key, top: anchor.element.getBoundingClientRect().top })
  }
  return rects
}

/** Anchor lookup for reveal (exact dataset match, scoped). */
export function findAnchor(scrollport: HTMLElement, nodeKey: string): HTMLElement | null {
  for (const row of Array.from(scrollport.querySelectorAll(ANCHOR_SELECTOR))) {
    const el = row as HTMLElement
    if (el.dataset.chatAnchorKey === nodeKey) return el
  }
  return null
}

/**
 * Business-row lookup by the identity `captureConversationRange` records.
 *
 * 刻意不是 `findAnchor`：那个比的是 `data-chat-anchor-key`，而选区身份里的
 * `nodeKey` 来自 `data-chat-flow-key`（`captureConversationRange:140`）。两个
 * 属性在宿主里不保证相等，混用会解析到别的行。
 */
export function findBusinessRow(scope: ParentNode, nodeKey: string): HTMLElement | null {
  for (const candidate of Array.from(scope.querySelectorAll<HTMLElement>(BUSINESS_ROW_SELECTOR))) {
    if (candidate.dataset.chatFlowKey === nodeKey) return candidate
  }
  return null
}

/**
 * Inject the reveal-highlight stylesheet once (harness has no CSS seam
 * for plugin styles; a scoped <style> tag is the adapter-level trade).
 */
let highlightCssInjected = false
export function ensureHighlightStyles(): void {
  if (highlightCssInjected) return
  highlightCssInjected = true
  const style = document.createElement('style')
  style.setAttribute('data-dsh-nux-styles', 'reveal-highlight')
  style.textContent =
    '[data-dsh-nux-reveal]{outline:2px solid var(--dsw-alias-brand-primary,#4f7cff);outline-offset:2px;border-radius:4px;transition:outline-color .15s ease}'
  document.head.appendChild(style)
}

/**
 * CSS Custom Highlight 注册表里的两个条目名。它们同时出现在注入的样式表
 * （`::highlight(...)` 选择器）和 `CSS.highlights.set(name, ...)` 里，所以
 * 名字必须与样式表同源——放在这里，样式表旁边。
 */
export const QUOTE_HIGHLIGHT_NAME = 'dsh-nux-quote'
export const QUOTE_HIGHLIGHT_ACTIVE_NAME = 'dsh-nux-quote-active'
/** 第三个条目：**只**铺淡蓝底色，且只发布不落在自绘背景里的子 Range
 * （`tintableSubRanges`）。与上面两条设的是不相交的属性，叠加没有冲突。 */
export const QUOTE_HIGHLIGHT_TINT_NAME = 'dsh-nux-quote-tint'

/**
 * 就地高亮的样式：下划线（全部引用）+ 淡蓝底色（**只**铺在自己不画背景的
 * 文字上，见 `tintableSubRanges` 与下面第三个条目）。
 *
 * 下划线用 `state-business-primary`——浅 4.23:1 / 深 6.86:1（对 `bg-base`），
 * 两套主题都远过 3:1，它是高亮的可辨识载体（也是 WCAG 1.4.1 "不仅靠颜色"
 * 里那个形状线索）。
 *
 * 为什么把底色去掉。`::highlight()` 的 `background-color` **盖掉元素自己的
 * 背景**，而宿主里有一整族「自带背景、文字颜色是照那块背景调的」表面：代码块
 * （`markdown-code-block`，浅 #f9fafb / 深 #1b1b1c）里的 shiki 语法色、
 * ReadBlock 的行、DiffBlock 的增删行……选区并不排除 `pre`/`code`，一旦色带铺
 * 上去，这些文字就掉到一个谁也没审过的底色上。实测（shiki 取宿主
 * `ui-theme/src/styles/shiki.css` 的真值，底色取 `state-business-tertiary`）：
 *   深色 token constant  #4dabf7  代码块 6.95:1 → 色带 4.13:1  掉破 4.5
 *          function      #b197fc  代码块 7.13:1 → 色带 4.24:1  掉破 4.5
 *   浅色 token link      #1971c2  代码块 4.80:1 → 色带 4.26:1  掉破 4.5
 *          （浅色其余 token 在代码块自己的底色上就已经不到 4.5:1——
 *            constant 4.02 / keyword 4.42 / string 3.30 …… 我们修不好它，
 *            但也绝不能再往下压：色带把它们又各降约 0.4。）
 *   DiffBlock 深色 state-error-primary 5.23:1 → 3.11:1、success 7.55:1 → 4.49:1
 * 这不是「代码块特例」，是「凡宿主自带背景的表面都中招」。所以不写一串
 * `pre / code / [data-read] / [data-diff] …` 的抑制选择器（漏一个就回归，而且
 * 那是把宿主私有结构抄进样式表）。
 *
 * 底色回来了，但走的是**按元素自己画不画背景分流**这条路（`tintableSubRanges`）：
 * 判据现场从 `getComputedStyle` 读，宿主新增哪种自绘表面都自动落在正确一侧，
 * 上面那一串回归按构造消失。底色只发给第三个条目名，前两条一个字都没动。
 *
 * base/active 两态的区分仍然只在下划线粗细（2px / 3px）——底色不随 active 变，
 * 所以条目名是 3 个而不是 4 个。
 *
 * 不写 `color`：正文颜色交给宿主，我们既不铺底也不改字色，文字对比度恒等于
 * 宿主自己的基线。
 *
 * `::highlight()` 没有盒模型——`border-radius` / `padding` 会被完全忽略
 * （Chrome 151 实测），圆角徽标只能另走绝对定位。换行选区由浏览器自己拆成
 * 每行一条下划线，不需要我们算矩形。
 */
const QUOTE_HIGHLIGHT_CSS = [
  `::highlight(${QUOTE_HIGHLIGHT_NAME}){`,
  'text-decoration-line:underline;',
  'text-decoration-color:var(--dsw-alias-state-business-primary,#4176e6);',
  'text-decoration-thickness:2px;',
  'text-underline-offset:2px}',
  `::highlight(${QUOTE_HIGHLIGHT_ACTIVE_NAME}){`,
  'text-decoration-line:underline;',
  'text-decoration-color:var(--dsw-alias-state-business-primary,#4176e6);',
  'text-decoration-thickness:3px;',
  'text-underline-offset:2px}',
  // 淡蓝底。**只**发给不落在自绘背景里的子 Range（`tintableSubRanges`），
  // 所以上面那段「凡宿主自带背景的表面都中招」的回归按构造不会发生：代码块 /
  // Diff / 行内 code 里的文字根本不在这个条目里。
  // 对比度（底色 state-business-tertiary 浅 #e4edfd / 深 #34415b）：
  //   label-primary 正文 / 底色    浅 16.05:1  深 9.79:1   （要 4.5）
  //   label-secondary / 底色       浅  4.92:1  深 6.79:1   （要 4.5）
  // 底色对页面 bg-base 只有 1.19 / 1.78 —— 它是装饰，可辨识载体仍是上面那条
  // 4.23 / 6.86 的下划线（也是 WCAG 1.4.1「不仅靠颜色」的形状线索），所以两者
  // 必须同时存在，底色不能取代下划线。
  `::highlight(${QUOTE_HIGHLIGHT_TINT_NAME}){`,
  'background-color:var(--dsw-alias-state-business-tertiary,#e4edfd)}',
  // 引用区评论框的 placeholder 色。`::placeholder` 和 `::highlight()` 一样是
  // 伪元素，没有内联等价物 —— 这是本包保持纯内联样式的唯一两处例外，两者共用
  // 同一张已注入的样式表。UA 默认的 placeholder 色在浅色主题下过不了 4.5:1
  // （placeholder 是真文字），label-secondary 浅 5.79:1 / 深 10.43:1。
  // `opacity:1` 是给 Firefox 的：它默认给 placeholder 叠一层透明度。
  // 选择器只命中我们自己渲染的输入框（`data-dsh-quote-comment`），不碰宿主。
  '[data-dsh-quote-comment]::placeholder{color:var(--dsw-alias-label-secondary,#61666b);opacity:1}',
].join('')

/**
 * Inject the quote-highlight stylesheet once. Same trade as
 * `ensureHighlightStyles` above (harness has no CSS seam for plugin styles);
 * `::highlight()` 规则**只能**来自样式表——高亮的绘制参数不在元素上，没有
 * 内联等价物，这是本包唯一一处内联样式做不到的视觉。
 */
let quoteHighlightCssInjected = false
export function ensureQuoteHighlightStyles(): void {
  if (quoteHighlightCssInjected) return
  quoteHighlightCssInjected = true
  const style = document.createElement('style')
  style.setAttribute('data-dsh-nux-styles', 'quote-highlight')
  style.textContent = QUOTE_HIGHLIGHT_CSS
  document.head.appendChild(style)
}
