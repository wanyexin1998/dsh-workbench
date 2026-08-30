# Fresh chat and forked side chat coexist

## Status

Accepted for Workbench Ask v1.

## Context

A clean, zero-tool conversation and a question about selected conversation history have different trust and context boundaries. Treating either one as a fallback for the other would make the Pane label, inherited tools, approval behavior, and recorded lineage misleading.

## Decision

The feature family is named **Workbench Ask / 随手问** and has two non-substitutable Session substrates:

- **Fresh chat** creates a Session with the seeded `chat` preset. It inherits no parent conversation context and has no tools. It belongs to a workspace named `chat` when one exists, otherwise to the current workspace. `Primary+Shift+C` opens it beside the focused Pane in Edition; stock Harness switches to the new chat Session and shows the frozen one-time degradation notice. The same local-day most recent blank chat Session is reused instead of creating another blank Session.
- **Forked side chat** is created only from a valid [`ConversationSelection`](../../packages/dsh-workbench/src/native-ux/client/selection-contract.ts). It forks `parentSessionId` at the selection's `atSeq`, inherits the parent workspace, model, preset, tools, approval flow, and completed history prefix, and opens in the second native Pane. "More details" auto-sends the localized lightweight, non-modifying explanation request; "Ask in side chat" opens with the selection reference and an editable empty draft. The boundary request does not remove inherited tools or approval requirements.

"Add to conversation" does not create either substrate. It adds the selection reference to the composer owned by the captured `parentSessionId` and remains available on stock Harness. Stock Harness capability-gates the two forked-side-chat actions off; a fresh chat never silently replaces them.

Both Session substrates reuse the stock Conversation under an explicit `SessionProvider(sessionId)`. No floating conversation renderer is built. Edition uses one shared beside-open capacity policy: open beside when only the source Pane is visible; when two Panes are visible, replace only the non-source Pane after confirmation; when the captured source Pane is no longer visible, fail without guessing. Closing a side child's Pane retains the child Session. A successfully created Session is also retained and reported if Pane opening later fails.

These rules preserve the six frozen product decisions:

| Decision | Frozen result |
| --- | --- |
| D1 | Retire the floating window; open chat in the second native Pane. |
| D2 | On stock Harness, switch to a new chat Session and show the one-time degradation notice. |
| D3 | Retain a side child after its Pane closes. |
| D4 | Inherit approval behavior; "More details" asks for a lightweight, non-modifying explanation. |
| D5 | Name the feature family Workbench Ask / 随手问. |
| D6 | Reuse the most recent blank chat Session from the same local day. |

## Consequences

- The Pane preset label remains the user-visible trust boundary: chat means zero tools; other presets retain their normal capabilities and approvals.
- Parent logs are not steered by side-chat questions. Child context and questions use existing model-visible input/reference paths; no hidden prompt or new Session event is introduced.
- Fresh chat creation and forked side-chat creation can share presentation capacity code without sharing Session semantics.
- Closing or presentation failure never silently deletes a created Session.
