# Known issues

- The source preview requires a pinned downstream Harness fork; stock `0.1.1-rc.2` does not expose Presentation protocol 2.
- Multi-Pane membership is process-local. Reload restores one Pane.
- The product limit is two visible Panes. A third Session replaces the focused Pane.
- Narrow viewports display only the focused Pane while retaining the other tree in memory.
- Open Beside applies to listed Sessions, not addressed subagent children.
- Better Sidebar Pane support requires the optional pinned fork. Unknown global overlays are never moved by DOM heuristics.
- The Workbench `v0.2.0-rc.2` GitHub Release is published with SHA256-verified (not GPG-signed) TGZ and bootstrap-script assets; npm publication is not planned. `docs/INSTALL.md` § Quick Install now works directly. `docs/INSTALL.md` § Advanced: source build remains available for anyone who wants to obtain and approve a full 40-character Workbench commit through an independent trusted channel and build from source themselves.
- Windows has completed `v0.2.0-rc.2` isolated end-to-end verification for the Split Pane bootstrap installer (`state: installed`, exit 0, the unmodified script run against a clean, deliberately space-containing target). That run's `git clone` was substituted with a local mirror of the same repository after the real GitHub remote failed with transport resets; the installer still verified the checkout against its embedded 40-character commit hash, so installer correctness and checkout integrity are proven, but GitHub reachability from that machine at that time is not. See [`docs/COMPATIBILITY_MATRIX.md`](COMPATIBILITY_MATRIX.md) for the full breakdown, including the general-plugin and read-only-`$DSH_HOME` scenarios that have not yet run. macOS has not had an isolated end-to-end run. Linux remains unverified and unsupported — no Workbench end-to-end evidence exists for it.
- GitHub Actions are disabled. Maintainers and contributors must attach local `pnpm release:check` evidence to changes.
