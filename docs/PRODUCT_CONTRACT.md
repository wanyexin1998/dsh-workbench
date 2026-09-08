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

- Turn navigation is the host's own `TurnNavigator`, mounted inside each `ChatView` — one rail per Pane, including turns the Pane has not loaded yet. Workbench renders no conversation rail of its own and keeps a fixed reserve at the scroll container's right edge so quote badges and note cards never land underneath it.

## Workbench Ask

| Action | Session and input contract | Stock Harness | Presentation protocol 2 |
| --- | --- | --- | --- |
| `Primary+Shift+C` | Reuse the newest same-local-day blank `chat` Session in the resolved Workspace, otherwise create one with `agentPreset: chat` | Open in place and show one degradation notice | Open beside while preserving the captured source Pane |
| Add to conversation | Aggregate a capture-time selection reference in the source composer; mark the passage in place and open a note card beside it; preserve ordinary draft; send only through the normal input path | Available | Available |
| More details | Fork at the selected node's `anchorSeq`; send one logged boundary + the quoted passage as plain text + localized explanation request in the child | Hidden | Available |
| Ask in side chat | Fork identically; insert one side-chat reference into an empty ordinary draft; do not submit until the user does | Hidden | Available |

- Workspace resolution prefers a Workspace titled `chat`, then the Workspace containing the captured source Session, then the Workspace with the newest `updatedAt` — the host's last-mutation instant, which counts a retitle or a mounted Session, not only conversation activity. That last tier is what answers from the zero-Pane home state, where nothing is focused and no source Session exists to ask about. Resolution yields nothing at all only when there are no Workspaces, or none carries a parseable `updatedAt`; Workbench does not create a Workspace automatically.
- Same-day blank reuse requires `blank === true`, an `agentPreset` of `chat` in the Session's projection values, membership in the resolved Workspace, and the newest local-calendar-day timestamp.
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
- Better Sidebar support requires the exact 0.16.1 downstream commit and Pane protocol 1 in `release-contract.json`. **No commit currently satisfies both.** The pinned `1685770…` was built against upstream `0.1.1-rc.1` and does not load on the `0.1.2-rc.1` baseline this release pins — it prevents the harness from booting rather than degrading. Until a rebuilt fork is pinned, this section defines a contract with no live provider, and the bullets above describe behaviour nothing exercises.
- Unknown overlays require their own explicit versioned adapter; private DOM inference is forbidden.

## Chat preset seeding

The one sanctioned exception to invariant 7:

- The Host entry seeds the bundled `chat` agent preset (zero tools, conversation-only) into `$DSH_HOME/.agent-presets/chat/` at composition time.
- Create-only at the file level: an existing file is never modified or overwritten.
- One repair is in scope, and only one: a `chat/` directory that does not contain
  the `agent.cordis.yml` the Harness mounts is not a preset, it is an occupied id
  that fails every Session create against it (`agent-preset/invalid`). Workbench
  writes the missing file — and only the missing file — so the id becomes usable
  again. This is not a re-creation of a deleted preset; see the marker rule below,
  which is unchanged.
- A sibling marker (`.agent-presets/.workbench-chat-seeded`) records that seeding happened; deleting the preset directory is treated as user intent and Workbench never re-creates it.
- Seeding failures degrade to a console warning and never block Host composition.
- No other filesystem, subprocess, credential, or network capability is added.

## Out of scope for 0.2

- Three or more Panes, Pane Grid, or Pane Swap
- Persisting multi-Pane membership across reload
- Automatic installation or updating of Better Sidebar
- Republishing upstream-named Harness or Better Sidebar npm packages
- A protocol-1 carrier or automatic installer
