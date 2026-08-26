# Presentation protocol 2 uses `visible + focused`

## Status

Accepted for Workbench 0.2.

## Decision

Harness SessionRuntime owns a versioned Presentation face. `visible` is the stable left-to-right Session membership list; `focused` identifies interaction ownership. `open`, `focus`, `close`, and effect-lifetime `requestCapacity` are the only public actions.

Protocol 2 permits capacity one or two. Workbench requests two. Releasing the request collapses around focus; focus changes never reorder or remount a Pane.

Each Pane renders stock Conversation, `session.pane.right`, and `session.pane.bottom` under an explicit SessionProvider. Panel providers own their state and dimensions.

The project does not distribute a companion carrier or patch user installations. Source-preview compatibility is pinned to independently maintained forks.

## Consequences

- A third Session replaces the focused Pane.
- Conversation, panel, draft, scroll, and stream state remain independent per Pane.
- Reload restores a single persisted Session.
- Plugins without explicit adapters retain their original behavior.
