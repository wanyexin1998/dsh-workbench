# DSH Workbench 0.2 product contract

`release-contract.json` is the machine-readable source of truth.

## Invariants

1. Workbench renders stock Harness Conversation only under explicit `SessionProvider(sessionId)` bindings.
2. Split Pane requires Session Presentation protocol 2 and fails closed when the interface is missing or incompatible.
3. At most two Panes are visible. `visible` owns stable spatial membership; `focused` owns interaction routing.
4. Ordinary navigation replaces the focused Pane. Open Beside inserts beside focus when capacity permits; at capacity it replaces focus.
5. Closing a Pane retains the durable Session and focuses the right neighbor, then the left neighbor.
6. Releasing the last capacity-two request collapses around the focused Session.
7. Workbench adds no Host filesystem, subprocess, credential, or arbitrary network capability, except the single chat-preset seeding write defined below.
8. Without Panel Compatibility and an explicit provider adapter, Workbench changes no third-party panel behavior.
9. Selection actions bind to the capture-time Pane and Session identity. They never re-read global focus/current after an async boundary and never fall back to the document's first conversation.
10. Fresh chat and forked side chat are different Session substrates. A zero-tool chat Session never substitutes for a forked child, and a forked child retains the parent's tools and approval flow.

## Pane behavior

| Action | Required result |
| --- | --- |
| Ordinary Session click | Replace the focused Pane |
| Ctrl/Command-click | Open Beside; replace focus when already at two Panes |
| Workbench Ask at two Panes | Confirm first, then replace only the non-source Pane; reject if the captured source is no longer visible |
| Pointer interaction inside a Pane | Focus it without reordering |
| Close Pane | Retire its client scope; retain the durable Session |
| Divider drag | Persist `dsh.ui.sessionPanes.splitRatio`, clamped to 0.30–0.70 |
| Narrow viewport | Show only focus while keeping the other Pane mounted |
| Shared Workspace | Show a non-blocking Same Workspace Warning |

## Workbench Ask

| Action | Session and input contract | Stock Harness | Presentation protocol 2 |
| --- | --- | --- | --- |
| `Primary+Shift+C` | Reuse the newest same-local-day blank `chat` Session in the resolved Workspace, otherwise create one with `agentPreset: chat` | Open in place and show one degradation notice | Open beside while preserving the captured source Pane |
| Add to conversation | Aggregate a capture-time selection reference in the source composer; mark the passage in place and open a note card beside it; preserve ordinary draft; send only through the normal input path | Available | Available |
| More details | Fork at the selected node's `anchorSeq`; send one logged boundary + the quoted passage as plain text + localized explanation request in the child | Hidden | Available |
| Ask in side chat | Fork identically; insert one side-chat reference into an empty ordinary draft; do not submit until the user does | Hidden | Available |

- Workspace resolution prefers a Workspace titled `chat`, then the Workspace containing the captured source Session. Workbench does not create a Workspace automatically.
- Same-day blank reuse requires `blank === true`, `agentPreset === 'chat'`, membership in the resolved Workspace, and the newest local-calendar-day timestamp.
- A legal selection is non-empty, at most 16 KiB UTF-8, and contained in one settled, model-visible business row. Cross-message, cross-Pane, streaming, interactive-control, stale, or ambiguous selections fail closed.
- `parentSessionId`, node identity, `anchorSeq`, normalized visible-text offsets, and selection rectangle are frozen at capture. Mutating actions revalidate the same Session snapshot before proceeding.
- Add-to-conversation and side-chat draft references are source-owned codecs. Missing owners, stale draft revisions, or serialization failures block submission rather than degrading to untracked plain text.
- A side child inherits the parent cwd, model target, preset, Workspace, lineage, tools, and approval behavior. Its boundary says inherited history is reference-only and that the current task begins after the boundary.
- Closing a side Pane retains the Session. If fork/create succeeds and a later Pane/input operation fails, Workbench reports the retained Session id and never deletes it automatically.
- More Details never steers or interrupts the parent and writes no side-chat question into the parent log. Ask in side chat produces no model call before explicit user submission.
- **What the model receives is prose, not markup.** A quote is serialized as a localized heading, the quoted text with a `│ ` gutter on every line, and the user's note on a `↳ ` line. No XML-ish wrapper, no session id, node key, sequence number or character offset reaches the model, and the quoted text is not HTML-escaped — those identifiers exist to re-anchor the quote in the UI, nothing downstream ever read them, and putting them in front of the reader and the model was cost with no consumer.
- **A quote may carry one user-written note, and that note is model-visible.** It is stored in the composer draft's selection aggregate, so it lives and dies with the draft: clearing the draft discards it, sending consumes it. It is not written to the Host filesystem.
- **The in-place marking never mutates the host Conversation.** Bands are painted by handing the browser a `Range` through the CSS Custom Highlight API; badges, note cards, and the quote list are React portals on `document.body` inside zero-sized positioned containers. Workbench inserts no node, attribute, class, or inline style into host-rendered message DOM, and the marking layer intercepts no pointer event the host would otherwise receive. There is no fallback painter: on a runtime without the API the band is simply absent and every other part of the feature is unaffected.
- **A quote whose passage has left the conversation is `detached`, not dropped.** Its band and badge disappear, its row stays in the quote list, and it is still serialized into the message. Anchor state never gates whether a quote is sent — only whether it can be shown.

## Panel compatibility

- `session.pane.right` and `session.pane.bottom` render inside each explicit SessionProvider.
- Providers own open state, size, active tabs, and internal controls.
- Focus changes only route commands; they do not mount, open, close, or unmount panels.
- Both Panes may display independent right and bottom panels simultaneously.
- Better Sidebar support requires the exact 0.16.1 downstream commit and Pane protocol 1 in `release-contract.json`.
- Unknown overlays require their own explicit versioned adapter; private DOM inference is forbidden.

## Chat preset seeding

The one sanctioned exception to invariant 7:

- The Host entry seeds the bundled `chat` agent preset (zero tools, conversation-only) into `$DSH_HOME/.agent-presets/chat/` at composition time.
- Create-only: an existing `chat/` directory is never modified or overwritten.
- A sibling marker (`.agent-presets/.workbench-chat-seeded`) records that seeding happened; deleting the preset directory is treated as user intent and Workbench never re-creates it.
- Seeding failures degrade to a console warning and never block Host composition.
- No other filesystem, subprocess, credential, or network capability is added.

## Out of scope for 0.2

- Three or more Panes, Pane Grid, or Pane Swap
- Persisting multi-Pane membership across reload
- Automatic installation or updating of Better Sidebar
- Republishing upstream-named Harness or Better Sidebar npm packages
- A protocol-1 carrier or automatic installer
