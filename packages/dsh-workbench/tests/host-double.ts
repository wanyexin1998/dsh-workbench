// 按**真实宿主的形状**造的共享替身。
//
// 存在的理由是两次同型回归：rc.4 的 inject 与 rc.5 的 chat 节点表。两次都是
// **替身比真宿主宽松**，于是 663 个测试在一个开机即坏的构建上满分。规矩因此是
// 反过来的：替身只提供真宿主提供的东西，**多一个少一个都让测试红**。
//
// 每个形状都钉着 0.1.2-rc.1 的契约出处（`c5a387cd` 那份检出）。改这些常量前
// 先去读那份契约，不要按印象改。

/**
 * `SessionSnapshot` 的**全部**字段名，逐字抄自
 * `@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/snapshot.d.ts:58-81`。
 *
 * 那份契约的第一行是：
 * “Session-owned observable state **excluding Conversation target data**”。
 * 所以这里**没有** `chat`——rc.5 就死在插件仍然读 `snapshot.chat.nodes` 上。
 * 谁再想往会话面上塞 chat，会先撞到 {@link hostSessionSnapshot} 的断言。
 */
export const SESSION_SNAPSHOT_KEYS = [
  'sessionId', 'queue', 'pendingSubmissions', 'running', 'subagent', 'removed',
  'openState', 'openError', 'hasMore', 'loadingOlder', 'promptError', 'blank',
  'lastAgentError', 'promptAttempted', 'awaitingFirstTurn',
] as const

export type HostSessionSnapshotKey = typeof SESSION_SNAPSHOT_KEYS[number]
export type HostSessionSnapshot = Record<HostSessionSnapshotKey, unknown>

/**
 * 造一份形状与真宿主逐字相同的会话快照。
 * @param sessionId - 会话标识。
 * @param overrides - 只能覆盖 {@link SESSION_SNAPSHOT_KEYS} 里的字段；
 *   传一个宿主没有的字段直接抛——这正是本文件存在的理由。
 * @returns 恰好 15 个键的会话快照。
 */
export function hostSessionSnapshot(
  sessionId: string,
  overrides: Partial<HostSessionSnapshot> = {},
): HostSessionSnapshot {
  for (const key of Object.keys(overrides)) {
    if (!(SESSION_SNAPSHOT_KEYS as readonly string[]).includes(key)) {
      throw new Error(`host-double: "${key}" is not a field of the 0.1.2-rc.1 SessionSnapshot`)
    }
  }
  return {
    sessionId,
    queue: [],
    pendingSubmissions: [],
    running: false,
    subagent: null,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    promptAttempted: false,
    awaitingFirstTurn: false,
    ...overrides,
  }
}

/**
 * 一个 chat 节点，形状按 `ChatConversationViewNode`
 * （`ui-chat/src/client/contract/chat-nodes.ts:8-13` 继承
 * `ui-conversation/.../contract/conversation.ts:127-133` 的
 * `{ key, kind, id, target, data }`，再加 `anchorSeq / location / visibility`）。
 */
export interface HostChatNode {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly target: 'chat'
  readonly anchorSeq: number
  readonly visibility: 'visible' | 'hidden'
  readonly location: { readonly kind: string }
  readonly data: unknown
}

/**
 * 造一个 chat 节点。
 * @param key - 稳定的 Conversation Context key（DOM 上就是 `data-chat-flow-key`，
 *   见 `ui-chat/src/client/chat/ChatNodeSeat.tsx:129`）。
 * @param kind - 渲染 kind（DOM 上是 `data-chat-flow-kind`，同文件 :130）。
 * @param overrides - 覆盖任意字段；同样只认真实字段名。
 * @returns 一个节点。
 */
export function hostChatNode(
  key: string,
  kind = 'user',
  overrides: Partial<HostChatNode> = {},
): HostChatNode {
  const base: HostChatNode = {
    key,
    kind,
    id: key,
    target: 'chat',
    anchorSeq: 42,
    visibility: 'visible',
    location: { kind: 'turn' },
    data: kind === 'assistant-step' ? { status: 'settled', turn: 1, step: 0 } : {},
  }
  for (const field of Object.keys(overrides)) {
    if (!(field in base)) {
      throw new Error(`host-double: "${field}" is not a field of ChatConversationViewNode`)
    }
  }
  return { ...base, ...overrides }
}

/** 一个会话的 chat 节点表 + 它的发布信号，测试用它推动失效。 */
export interface HostChatStore {
  /** 覆写一个 key 上的节点（传 undefined 表示这个 key 不在了）。 */
  set(key: string, node: HostChatNode | undefined): void
  /** 向订阅者发一次「快照变了」——对应 BoundConversation 的 flush 发布。 */
  publish(): void
  /** 当前订阅者数量，用于断言解绑。 */
  listenerCount(): number
}

/**
 * `uiConversation` 服务的替身，形状照抄
 * `ui-conversation/src/client/conversation/assembly.ts` 的
 * `UiConversation.binding()` 与 `BoundConversation.target()`。
 *
 * 两条真宿主的行为被刻意保留，因为插件必须扛得住它们：
 * 1. **未知会话时 `binding()` 抛**（assembly.ts:213
 *    `uiConversation.binding: unknown session "…"`），不是返回 undefined。
 * 2. **目标未激活时 `target('chat').getSnapshot()` 返回 `undefined`**
 *    （同文件 :67 `getSnapshot: () => views.get(target)`），不是返回空快照。
 */
export interface HostUiConversationDouble {
  binding(sessionId: string): {
    target(name: 'chat'): {
      getSnapshot(): { readonly nodes: { get(key: string): HostChatNode | undefined } } | undefined
      subscribe(listener: () => void): () => void
    }
  }
  /** 每个会话的节点表句柄，测试直接操纵。 */
  readonly stores: ReadonlyMap<string, HostChatStore>
}

/**
 * 造一个 uiConversation 替身。
 * @param sessions - 会话 id → 初始节点列表。列在这里的会话才「在册」，
 *   其余的 `binding()` 会抛，与真宿主一致。
 * @param options.chatTargetAbsent - 模拟宿主没装 ui-chat：`binding()` 正常，
 *   但 `target('chat').getSnapshot()` 恒为 `undefined`。这正是 rc.5 在真宿主上
 *   的处境（节点表搬走了，插件读到的是空），也是本回归唯一的端到端判据。
 * @returns 替身与它的节点表句柄。
 */
export function hostUiConversation(
  sessions: Record<string, readonly HostChatNode[]>,
  options: { chatTargetAbsent?: boolean } = {},
): HostUiConversationDouble {
  const stores = new Map<string, HostChatStore>()
  const nodes = new Map<string, Map<string, HostChatNode>>()
  const listeners = new Map<string, Set<() => void>>()
  for (const [sessionId, initial] of Object.entries(sessions)) {
    nodes.set(sessionId, new Map(initial.map(entry => [entry.key, entry])))
    listeners.set(sessionId, new Set())
    stores.set(sessionId, {
      set: (key, node) => {
        const table = nodes.get(sessionId)
        if (table === undefined) return
        if (node === undefined) table.delete(key)
        else table.set(key, node)
      },
      publish: () => {
        for (const listener of [...(listeners.get(sessionId) ?? [])]) listener()
      },
      listenerCount: () => listeners.get(sessionId)?.size ?? 0,
    })
  }
  return {
    stores,
    binding: (sessionId: string) => {
      const table = nodes.get(sessionId)
      if (table === undefined) throw new Error(`uiConversation.binding: unknown session "${sessionId}"`)
      const bucket = listeners.get(sessionId) as Set<() => void>
      return {
        target: () => ({
          getSnapshot: () => options.chatTargetAbsent === true
            ? undefined
            : { nodes: { get: (key: string) => table.get(key) } },
          subscribe: (listener: () => void) => {
            bucket.add(listener)
            return () => { bucket.delete(listener) }
          },
        }),
      }
    },
  }
}
