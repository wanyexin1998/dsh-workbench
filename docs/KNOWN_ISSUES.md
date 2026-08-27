# Known issues

- The source preview requires a pinned downstream Harness fork; stock `0.1.1-rc.2` does not expose Presentation protocol 2.
- Multi-Pane membership is process-local. Reload restores one Pane.
- The product limit is two visible Panes. A third Session replaces the focused Pane.
- Narrow viewports display only the focused Pane while retaining the other tree in memory.
- Open Beside applies to listed Sessions, not addressed subagent children.
- Better Sidebar Pane support requires the optional pinned fork. Unknown global overlays are never moved by DOM heuristics.
- No signed Workbench GitHub Release is published yet, and npm publication is not planned. Split-pane bootstrap/installer scripts (`scripts/bootstrap/dsh-workbench-bootstrap.ps1` / `.sh`) exist on this branch and are intended to ship as Release assets starting with `v0.2.0-rc.2`; until that Release is published, `docs/INSTALL.md` § Advanced: source build is the only path that works today — obtain and approve a full 40-character Workbench commit through an independent trusted channel before source installation.
- Windows and macOS are the platforms targeted for `v0.2.0-rc.2` isolated end-to-end verification; neither has completed it yet. Linux remains unverified and unsupported — no Workbench end-to-end evidence exists for it. See [`docs/COMPATIBILITY_MATRIX.md`](COMPATIBILITY_MATRIX.md).
- GitHub Actions are disabled. Maintainers and contributors must attach local `pnpm release:check` evidence to changes.
