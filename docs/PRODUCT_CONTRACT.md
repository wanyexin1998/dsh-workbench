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

## Pane behavior

| Action | Required result |
| --- | --- |
| Ordinary Session click | Replace the focused Pane |
| Ctrl/Command-click | Open Beside; replace focus when already at two Panes |
| Pointer interaction inside a Pane | Focus it without reordering |
| Close Pane | Retire its client scope; retain the durable Session |
| Divider drag | Persist `dsh.ui.sessionPanes.splitRatio`, clamped to 0.30–0.70 |
| Narrow viewport | Show only focus while keeping the other Pane mounted |
| Shared Workspace | Show a non-blocking Same Workspace Warning |

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
