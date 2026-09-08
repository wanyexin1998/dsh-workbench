import { captureConversationRange, locateComposerInput, type ConversationRangeCapture } from './conversation-dom.js'
import { MAX_SELECTION_BYTES, type ConversationSelection } from './selection-contract.js'

interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe?(listener: () => void): () => void
}

interface SelectionNode {
  readonly key?: unknown
  readonly kind?: unknown
  readonly anchorSeq?: unknown
  readonly visibility?: unknown
  readonly data?: unknown
}

/**
 * 一个会话的 chat 节点表快照。
 *
 * **它不再是会话面上的一个字段。** 0.1.2-rc.1 把 chat 那半边从 `ui-conversation`
 * 拆进了 `@deepseek-ai/dsh-client-ui-chat`，节点表现在是那个包发布到 Conversation
 * `chat` 目标上的快照（`ui-chat/src/client/contract/snapshot.ts` 的
 * `ChatSnapshot.nodes: ChatNodeStore`）。会话快照本身只剩 15 个生命周期字段，
 * 契约头一行就写着 "Session-owned observable state **excluding Conversation
 * target data**"（`dsh-api-session-controller/.../contract/snapshot.d.ts:1`）。
 *
 * 这里只声明真正读的那一个方法：`ChatNodeStore.get(key)`（同文件 :38）。
 */
interface SelectionChatSnapshot {
  readonly nodes?: { get(key: string): unknown }
}

/** 一个会话的 chat 节点面：`uiConversation.binding(id).target('chat')` 的观察面。 */
export interface SelectionChatFace extends SnapshotStore<SelectionChatSnapshot | undefined> {}

/**
 * 从 sessionId 解析到该会话 chat 节点面的窄口。
 *
 * 与 `SelectionSessions` 分开是刻意的：会话服务是宿主的对象，直接透传；
 * 这一条是插件自己按 `uiConversation` 组装出来的适配层（见 harness-adapter.ts
 * 的 `chatNodeSource`），两者的生命周期与失败模式都不同。
 */
export interface SelectionChatSource {
  /** @returns 该会话的 chat 面；宿主没装 ui-chat / 会话不在册时返回 undefined。 */
  face(sessionId: string): SelectionChatFace | undefined
}

/** Narrow host boundary consumed by the selection controller. */
export interface SelectionSessions {
  readonly list?: SnapshotStore<{ readonly current?: string }>
  readonly presentation?: {
    readonly state?: SnapshotStore<{ readonly visible?: readonly string[]; readonly focused?: string }>
  }
  scope?(sessionId: string): unknown
}

type SelectionSource = 'pane' | 'presentation-single' | 'stock-current'

interface ActiveSelection {
  readonly selection: ConversationSelection
  readonly dom: ConversationRangeCapture
  readonly source: SelectionSource
  readonly face: SelectionChatFace
}

export interface SelectionControllerSnapshot {
  readonly selection: ConversationSelection | null
}

/** 诊断回调：默认 console.warn，测试注入自己的。 */
export type SelectionDiagnostic = (message: string) => void

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

/**
 * 可划词的正文行 kind。
 *
 * `steering` 与 `user` 是同一件东西的两个状态：同一条
 * `user/message` 事件，被 agent 中途认领了就成 `steering`，没被认领就是
 * `user`（`ui-chat/src/client/conversation-nodes/message.ts:62-77`，同一个
 * definition 的两个分支，`chatNode(context, state.kind, state.seq, state)`
 * 造出来的 anchorSeq / visibility / location 完全同形）。宿主用**同一个组件**
 * 渲染它们（`register-node-renderers.ts:19-22`，两次 `UserMessageNodeView`；
 * `MessageItem.tsx:275` 的签名就是 `ChatNodeViewProps<'user' | 'steering'>`），
 * DOM 契约也同形。漏掉它意味着插话消息划不了词，而用户看到的是
 * 一模一样的一行正文——“有时能划有时不能”比彻底不能更难排查。
 *
 * 删掉的那些 kind（`turn-tail` / `turn-process` / `command` / `compaction` /
 * `system-prompt` / `unknown` 等）不是正文，是控件行与元信息行，引用它们
 * 对模型没意义。
 */
const SELECTABLE_NODE_KINDS: ReadonlySet<string> = new Set(['user', 'steering', 'context', 'assistant-step'])

/**
 * 判官。fail-closed：任何一条不过就 `null`，划词层安静降级。
 *
 * `diagnostic` 是 rc.5 的直接教训：这条路径上「面缺失」和「面搬家」原来表现
 * 完全一样——都是静默 `return null`。上游把节点表搬进 ui-chat 之后，每一次划词
 * 都被否决，浏览器控制台干净、服务端日志干净，排查花了几个小时。现在「面在
 * 但没有 nodes」会打一条日志（由调用方按 key 去重，不刷屏）；「节点查不到」
 * 不打——后者在虚拟化换出、历史未加载时是正常的。
 *
 * 原来这里还有一条 `snapshot.sessionId !== sessionId` 的复核。它不是被顺手删掉
 * 的：chat 快照上没有 sessionId 这个字段，而面本身现在是**按 sessionId 解析出来
 * 的**（`SelectionChatSource.face(sessionId)`），会话归属由构造方式保证，不再需要
 * 一条读值的复核。
 */
function validatedNode(
  face: SelectionChatFace,
  dom: ConversationRangeCapture,
  diagnostic: SelectionDiagnostic,
): SelectionNode | null {
  let snapshot: SelectionChatSnapshot | undefined
  try {
    snapshot = face.getSnapshot()
  } catch {
    return null
  }
  if (snapshot === undefined || typeof snapshot.nodes?.get !== 'function') {
    diagnostic('[dsh-workbench] selection rejected: the chat target published no node store'
      + ' — the host chat face moved or is absent')
    return null
  }
  let raw: unknown
  try {
    raw = snapshot.nodes.get(dom.nodeKey)
  } catch {
    return null
  }
  const node = asRecord(raw) as SelectionNode | null
  if (node === null || node.key !== dom.nodeKey || node.kind !== dom.nodeKind || node.visibility !== 'visible') return null
  if (!SELECTABLE_NODE_KINDS.has(dom.nodeKind)) return null
  if (dom.nodeKind === 'assistant-step' && asRecord(node.data)?.status !== 'settled') return null
  if (typeof node.anchorSeq !== 'number' || !Number.isSafeInteger(node.anchorSeq) || node.anchorSeq < 0) return null
  return node
}

function sameDomSelection(left: ConversationRangeCapture, right: ConversationRangeCapture): boolean {
  return left.row === right.row &&
    left.paneSessionId === right.paneSessionId &&
    left.nodeKey === right.nodeKey &&
    left.nodeKind === right.nodeKind &&
    left.text === right.text &&
    left.startOffset === right.startOffset &&
    left.endOffset === right.endOffset
}

/**
 * Owns selection capture and all transient listeners. Session focus is read
 * only during the controlled stock capture fallback; later action routing is
 * always the frozen `parentSessionId`.
 */
export class SelectionController {
  readonly #sessions: SelectionSessions
  readonly #chat: SelectionChatSource
  readonly #diagnostic: SelectionDiagnostic
  /** 每条诊断只打一次；见 {@link validatedNode} 的说明。 */
  readonly #warned = new Set<string>()
  readonly #document: Document
  readonly #window: Window
  readonly #listeners = new Set<() => void>()
  readonly #globalDisposers: Array<() => void> = []
  #faceDisposer: (() => void) | undefined
  #active: ActiveSelection | null = null
  #snapshot: SelectionControllerSnapshot = { selection: null }
  #disposed = false

  /**
   * @param sessions - 宿主会话服务的窄面（list / presentation / scope）。
   * @param chat - chat 节点面的解析器；由 harness-adapter 按 `uiConversation` 组装。
   * @param rootDocument - 监听 selectionchange 的文档，测试注入。
   * @param diagnostic - 诊断出口，默认 console.warn。
   */
  constructor(
    sessions: SelectionSessions,
    chat: SelectionChatSource,
    rootDocument: Document = document,
    diagnostic: SelectionDiagnostic = message => { console.warn(message) },
  ) {
    this.#sessions = sessions
    this.#chat = chat
    this.#diagnostic = (message: string) => {
      if (this.#warned.has(message)) return
      this.#warned.add(message)
      diagnostic(message)
    }
    this.#document = rootDocument
    this.#window = rootDocument.defaultView ?? window

    const onSelectionChange = () => {
      const selection = this.#document.getSelection()
      if (selection === null || selection.rangeCount !== 1) {
        this.clear()
        return
      }
      this.captureRange(selection.getRangeAt(0))
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') this.clear()
    }
    const clearTransient = () => this.clear()
    this.#document.addEventListener('selectionchange', onSelectionChange)
    this.#document.addEventListener('keydown', onEscape)
    this.#document.addEventListener('scroll', clearTransient, true)
    this.#window.addEventListener('resize', clearTransient)
    this.#globalDisposers.push(
      () => this.#document.removeEventListener('selectionchange', onSelectionChange),
      () => this.#document.removeEventListener('keydown', onEscape),
      () => this.#document.removeEventListener('scroll', clearTransient, true),
      () => this.#window.removeEventListener('resize', clearTransient),
    )

    const listDispose = sessions.list?.subscribe?.(() => {
      if (this.#active?.source !== 'stock-current') return
      let current: string | undefined
      try {
        current = sessions.list?.getSnapshot().current
      } catch {
        this.clear()
        return
      }
      if (current !== this.#active.selection.parentSessionId) this.clear()
    })
    if (listDispose !== undefined) this.#globalDisposers.push(listDispose)

    const presentationDispose = sessions.presentation?.state?.subscribe?.(() => {
      if (this.#active === null || this.#active.source === 'stock-current') return
      let visible: readonly string[] | undefined
      try {
        visible = sessions.presentation?.state?.getSnapshot().visible
      } catch {
        this.clear()
        return
      }
      if (!Array.isArray(visible) || !visible.includes(this.#active.selection.parentSessionId)) this.clear()
    })
    if (presentationDispose !== undefined) this.#globalDisposers.push(presentationDispose)
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getSnapshot = (): SelectionControllerSnapshot => this.#snapshot

  captureRange(range: Range): ConversationSelection | null {
    if (this.#disposed) return null
    const dom = captureConversationRange(range, MAX_SELECTION_BYTES)
    if (dom === null) {
      this.clear()
      return null
    }
    const source = this.#resolveSource(dom)
    if (source === null) {
      this.clear()
      return null
    }
    let face: SelectionChatFace | undefined
    try {
      face = this.#chat.face(source.sessionId)
    } catch {
      face = undefined
    }
    if (face === undefined) {
      this.#diagnostic('[dsh-workbench] selection rejected: no chat face for the source session'
        + ' — the host has no ui-chat conversation target')
      this.clear()
      return null
    }
    const node = validatedNode(face, dom, this.#diagnostic)
    if (node === null) {
      this.clear()
      return null
    }
    const selection: ConversationSelection = {
      parentSessionId: source.sessionId,
      nodeKey: dom.nodeKey,
      nodeKind: dom.nodeKind,
      atSeq: node.anchorSeq as number,
      text: dom.text,
      startOffset: dom.startOffset,
      endOffset: dom.endOffset,
      rect: dom.rect,
    }
    this.#faceDisposer?.()
    this.#active = { selection, dom, source: source.kind, face }
    let unsubscribe: () => void = () => {}
    const placeholder = () => unsubscribe()
    this.#faceDisposer = placeholder
    const actualUnsubscribe = face.subscribe?.(() => {
      if (this.#active === null) return
      if (!this.#validateActive(this.#active)) this.clear()
    })
    if (actualUnsubscribe === undefined) {
      if (this.#faceDisposer === placeholder) this.#faceDisposer = undefined
    } else {
      unsubscribe = actualUnsubscribe
      // Snapshot stores are allowed to call back synchronously from
      // subscribe(). If that invalidated the capture, clear() ran against the
      // placeholder; release the actual subscription as soon as it arrives.
      if (this.#faceDisposer !== placeholder) actualUnsubscribe()
    }
    if (this.#active?.selection !== selection) return null
    this.#publish(selection)
    return selection
  }

  /** Revalidate against the frozen Session; never consult current/focused. */
  revalidate(selection: ConversationSelection): ConversationSelection | null {
    const active = this.#active
    if (active === null || active.selection !== selection || !this.#validateActive(active)) return null
    return active.selection
  }

  focusSourceComposer(): void {
    const active = this.#active
    if (active === null) return
    locateComposerInput(active.dom.focusScope)?.focus()
  }

  clear(): void {
    if (this.#active === null && this.#snapshot.selection === null) return
    this.#faceDisposer?.()
    this.#faceDisposer = undefined
    this.#active = null
    this.#publish(null)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.clear()
    for (const dispose of this.#globalDisposers.splice(0)) dispose()
    this.#listeners.clear()
  }

  #resolveSource(dom: ConversationRangeCapture): { sessionId: string; kind: SelectionSource } | null {
    if (dom.paneSessionId !== undefined) {
      const state = this.#sessions.presentation?.state
      if (state !== undefined) {
        try {
          const visible = state.getSnapshot().visible
          if (!Array.isArray(visible) || !visible.includes(dom.paneSessionId)) return null
        } catch {
          return null
        }
      }
      return { sessionId: dom.paneSessionId, kind: 'pane' }
    }
    const presentation = this.#sessions.presentation
    if (presentation !== undefined) {
      try {
        const visible = presentation.state?.getSnapshot().visible
        if (!Array.isArray(visible) || visible.length !== 1 || typeof visible[0] !== 'string') return null
        return { sessionId: visible[0], kind: 'presentation-single' }
      } catch {
        return null
      }
    }
    try {
      const current = this.#sessions.list?.getSnapshot().current
      return typeof current === 'string' && current.length > 0 ? { sessionId: current, kind: 'stock-current' } : null
    } catch {
      return null
    }
  }

  #validateActive(active: ActiveSelection): boolean {
    const nextDom = captureConversationRange(active.dom.range, MAX_SELECTION_BYTES)
    if (nextDom === null || !sameDomSelection(active.dom, nextDom)) return false
    if (nextDom.paneSessionId !== undefined && nextDom.paneSessionId !== active.selection.parentSessionId) return false
    const node = validatedNode(active.face, nextDom, this.#diagnostic)
    return node !== null && node.anchorSeq === active.selection.atSeq
  }

  #publish(selection: ConversationSelection | null): void {
    if (this.#snapshot.selection === selection) return
    this.#snapshot = { selection }
    for (const listener of [...this.#listeners]) listener()
  }
}
