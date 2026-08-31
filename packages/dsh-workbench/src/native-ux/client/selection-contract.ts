/** Session identifiers are opaque values supplied by Harness. */
export type SessionId = string

/** Capture-time viewport rectangle used to place the selection toolbar. */
export interface SelectionRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * A zero-based UTF-16 code-unit offset into one verified business row's
 * normalized visible-text projection (ADR-0009).
 */
export type NormalizedVisibleTextOffset = number

/** Maximum UTF-8 payload accepted from one browser selection. */
export const MAX_SELECTION_BYTES = 16 * 1024

/**
 * Immutable identity and text captured from one settled, model-visible
 * business row. Consumers must revalidate it before mutating a composer or
 * forking a Session; they must not replace `parentSessionId` with later focus.
 */
export interface ConversationSelection {
  /** Captured synchronously from the source Pane (or a controlled fallback). */
  readonly parentSessionId: SessionId
  /** Business-node identity verified against the captured Session snapshot. */
  readonly nodeKey: string
  readonly nodeKind: string
  /** The selected business node's `anchorSeq`, used to locate a completed turn. */
  readonly atSeq: number
  /** Exact normalized row-text slice at `[startOffset, endOffset)`. */
  readonly text: string
  readonly startOffset: NormalizedVisibleTextOffset
  readonly endOffset: NormalizedVisibleTextOffset
  readonly rect: SelectionRect
}

/** The three frozen selection verbs; presentation and stale errors stay internal. */
export interface SelectionActions {
  addToConversation(selection: ConversationSelection, comment?: string): void
  moreDetails(selection: ConversationSelection): Promise<SessionId>
  askInSideChat(selection: ConversationSelection): Promise<SessionId>
}
