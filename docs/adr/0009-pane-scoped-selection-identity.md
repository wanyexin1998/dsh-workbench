# Pane-scoped selection identity

## Status

Accepted for Workbench Ask v1.

## Context

Workbench can render two native Session Panes at once. A selection therefore cannot be paired with a Session by reading the globally focused/current Session or by taking the first conversation flow in document order. Either lookup can combine text from one Pane with the identity or composer of another after focus changes.

Stock Harness does not expose Workbench's `data-session-pane` host marker or Presentation protocol 2. The v1 add-to-conversation action must remain available there without weakening the two-Pane identity rule.

## Decision

Selection source identity is resolved synchronously at capture time and stored in [`ConversationSelection`](../../packages/dsh-workbench/src/native-ux/client/selection-contract.ts). `parentSessionId` remains authoritative for the lifetime of that value; actions never replace it with a later focused/current Session.

Source resolution is ordered and fail-closed:

1. Both Range endpoints must resolve to the same nearest business row carrying `data-chat-anchor-key` and `data-chat-flow-key`, and to the same local `data-chat-flow` root.
2. When a nearest `data-session-pane` marker is present, both endpoints must resolve to the same non-empty marker value. That value is `parentSessionId`.
3. When no endpoint has a Pane marker and Presentation protocol 2 is present, the only fallback is an explicit snapshot with exactly one `visible` Session. Its sole Session id is captured. Zero or two visible Sessions is ambiguous and rejected.
4. When Presentation protocol 2 is absent, the stock-compatible fallback may capture `sessions.list.getSnapshot().current` exactly once. It is accepted only if that Session's snapshot uniquely validates the selected business node as model-visible and settled. This fallback is not used in Edition and is never re-read after capture.
5. Every other case is rejected. In particular, there is no document-first-flow, document-global-composer, or global-focus fallback.

The selected row is verified against the resolved Session snapshot, not trusted from DOM attributes alone. The snapshot must match `nodeKey` and `nodeKind`, show that the node is model-visible and settled, and provide its business `anchorSeq`. The rendered row must still be connected and visible. Capture and every mutating action repeat this identity, visibility, and settled-state validation; a mismatch makes the selection stale.

`atSeq` is the selected business node's `anchorSeq`. It is not a guessed DOM index and it is not a `turn/end` sequence. Forking with that anchor expands the inherited prefix through the first completed `turn/end` whose sequence is greater than or equal to `atSeq`. If no such completed boundary exists, the fork action is rejected.

Offsets use one stock-compatible coordinate space. Eligible visible text nodes inside the verified business row are concatenated in DOM order, with CRLF and CR normalized to LF and no other whitespace or Unicode folding. Text contributed by interactive or control descendants is ineligible; a Range that intersects such content is rejected rather than clipped. `startOffset` and `endOffset` are zero-based UTF-16 code-unit offsets into that normalized row text, and `selection.text` must equal its `[startOffset, endOffset)` slice.

## Reference implementation boundary

The fixed reference is [`AHGGG/dsh-side-chat` at `e7cd447d97825a944b3d83e2a34488485dc1f088`](https://github.com/AHGGG/dsh-side-chat/tree/e7cd447d97825a944b3d83e2a34488485dc1f088), licensed under MIT. Its action split, selection-validation categories, structured composer reference, and completed-turn fork behavior may inform Workbench tests and algorithms.

Workbench must not adopt the reference's global current-Session lookup, document-first conversation lookup, global composer targeting, or custom Conversation renderer. This decision and its accompanying interface copy no third-party implementation code. If a later change copies or substantially adapts reference code, that change must identify the copied scope and add the required MIT notice before release.

## Consequences

- Focus changes after capture cannot reroute an action to another Pane.
- Ambiguous or stale selections fail instead of guessing a Session.
- Stock Harness retains the add-to-conversation path through a controlled capture-time fallback.
- Normalized row offsets make the captured text independently revalidatable before composer or fork mutations.
