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

interface SelectionSessionSnapshot {
  readonly sessionId?: unknown
  readonly chat?: { readonly nodes?: { get(key: string): unknown } }
}

interface SelectionSessionFace extends SnapshotStore<SelectionSessionSnapshot> {}

/** Narrow host boundary consumed by the selection controller. */
export interface SelectionSessions {
  readonly list?: SnapshotStore<{ readonly current?: string }>
  readonly presentation?: {
    readonly state?: SnapshotStore<{ readonly visible?: readonly string[]; readonly focused?: string }>
  }
  scope?(sessionId: string): unknown
  sessionOf?(scope: unknown): SelectionSessionFace | undefined
}

type SelectionSource = 'pane' | 'presentation-single' | 'stock-current'

interface ActiveSelection {
  readonly selection: ConversationSelection
  readonly dom: ConversationRangeCapture
  readonly source: SelectionSource
  readonly face: SelectionSessionFace
}

export interface SelectionControllerSnapshot {
  readonly selection: ConversationSelection | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function validatedNode(face: SelectionSessionFace, sessionId: string, dom: ConversationRangeCapture): SelectionNode | null {
  let snapshot: SelectionSessionSnapshot
  try {
    snapshot = face.getSnapshot()
  } catch {
    return null
  }
  if (snapshot.sessionId !== undefined && snapshot.sessionId !== sessionId) return null
  let raw: unknown
  try {
    raw = snapshot.chat?.nodes?.get(dom.nodeKey)
  } catch {
    return null
  }
  const node = asRecord(raw) as SelectionNode | null
  if (node === null || node.key !== dom.nodeKey || node.kind !== dom.nodeKind || node.visibility !== 'visible') return null
  if (dom.nodeKind !== 'user' && dom.nodeKind !== 'context' && dom.nodeKind !== 'assistant-step') return null
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
  readonly #document: Document
  readonly #window: Window
  readonly #listeners = new Set<() => void>()
  readonly #globalDisposers: Array<() => void> = []
  #faceDisposer: (() => void) | undefined
  #active: ActiveSelection | null = null
  #snapshot: SelectionControllerSnapshot = { selection: null }
  #disposed = false

  constructor(sessions: SelectionSessions, rootDocument: Document = document) {
    this.#sessions = sessions
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
    const scope = this.#sessions.scope?.(source.sessionId)
    const face = scope === undefined ? undefined : this.#sessions.sessionOf?.(scope)
    if (face === undefined) {
      this.clear()
      return null
    }
    const node = validatedNode(face, source.sessionId, dom)
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
    const node = validatedNode(active.face, active.selection.parentSessionId, nextDom)
    return node !== null && node.anchorSeq === active.selection.atSeq
  }

  #publish(selection: ConversationSelection | null): void {
    if (this.#snapshot.selection === selection) return
    this.#snapshot = { selection }
    for (const listener of [...this.#listeners]) listener()
  }
}
