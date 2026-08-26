# Known issues

- The source preview requires a pinned downstream Harness fork; stock `0.1.1-rc.2` does not expose Presentation protocol 2.
- Multi-Pane membership is process-local. Reload restores one Pane.
- The product limit is two visible Panes. A third Session replaces the focused Pane.
- Narrow viewports display only the focused Pane while retaining the other tree in memory.
- Open Beside applies to listed Sessions, not addressed subagent children.
- Better Sidebar Pane support requires the optional pinned fork. Unknown global overlays are never moved by DOM heuristics.
- No automatic installer or npm release exists. Users must build and verify local TGZ artifacts.
- GitHub Actions are disabled. Maintainers and contributors must attach local `pnpm release:check` evidence to changes.
