# Compatibility matrix

| Component | Required source | Capability | Status |
| --- | --- | --- | --- |
| Workbench `0.2.0-rc.4` | Harness fork `c5a387cd` (`rc4/presentation-on-0.1.2`, the current pin) | Session Presentation protocol 2 | Supported source preview |
| Workbench `0.2.0-rc.4` | Harness fork `c5a387cd` | `ctx.layout.toggleSettings()` | Open Settings registers as a toggle: the same chord opens and dismisses |
| Workbench `0.2.0-rc.4` | Harness fork `1a8cf5ba` (`fix/plugin-spec-quoting`, the `v0.2.0-rc.2` pin; the `v0.2.0-rc.3` pin `82de604a` already carried the toggle verb) | `ctx.layout.openSettings()` only | Open Settings registers open-only and is labelled "Open settings" |
| Workbench `0.2.0-rc.4` | Stock Harness `0.1.2-rc.1` | protocol 2 absent | Split Pane fails closed |
| Workbench `0.2.0-rc.4` | Stock Harness `0.1.2-rc.1` | neither Settings verb | The Open Settings action is not registered at all |
| Panel Compatibility `0.1.0-rc.2` | Better Sidebar fork `1685770` | Pane protocol 1 + actions protocol 1 | Supported optional adapter |
| Panel Compatibility absent | Any panel provider | n/a | Core Workbench remains functional |
| Panel Compatibility + stock Better Sidebar 0.16.1 | Pane protocol absent | no attachment | Better Sidebar retains its global behavior |

Exact repository URLs, branches, commits, and versions are machine-readable in [`release-contract.json`](../release-contract.json).

Neither downstream fork is republished under the upstream npm namespace.

## Distribution status

| Path | Status |
| --- | --- |
| Stock-Harness general plugin (`file:` TGZ + `dsh plugin add`) | Ships as a downloadable, SHA256-verified GitHub Release asset as of `v0.2.0-rc.4` (not GPG-signed). See [`docs/INSTALL.md`](INSTALL.md) § Quick Install. The source-build path in the same document remains available as an audit alternative. |
| Split-pane bootstrap installer (`.ps1` / `.sh`) | Ships as an immutable, SHA256-verified GitHub Release asset as of `v0.2.0-rc.4` (hashes recorded in `SHA256SUMS`). Source lives at `scripts/bootstrap/dsh-workbench-bootstrap.ps1` and `.sh`, with its own node:test suite (`scripts/bootstrap/bootstrap.test.mjs`). |
| npm / GitHub Packages | None. Not published, and not planned — the distribution model is source plus SHA256-verified Release artifacts. |

## Platform support

| Platform | Status |
| --- | --- |
| Windows | Split-pane bootstrap: isolated end-to-end verification complete, **against the `v0.2.0-rc.4` installer, which pins Harness `c5a387cd`**. The published `dsh-workbench-bootstrap.ps1`, downloaded from the release and verified against the published `SHA256SUMS`, run against a clean target with a deliberately space-containing path and no `-TgzSha256` argument, reported `state: installed` / exit 0. Confirmed independently afterwards: detached HEAD at the pinned commit with a clean worktree, the downloaded TGZ digest equal to the published one, a self-relative launcher, and an untouched real `~/.dsh`. Launched from that launcher, the client boot graph carries `@wanyexin1998/dsh-workbench`, the console is clean, and Settings shows the Workbench's own shortcut section. **This run cloned from GitHub directly**, unlike the `v0.2.0-rc.2` run which fell back to a local mirror after transport resets, so GitHub reachability is evidenced here; one attempt did fail on a reset first, and the installer failed closed with a valid result JSON and exit 1. **Split Pane itself was not exercised**: the isolated home has no configured model, so no second session could be created, and quote-badge placement against the host's turn rail is unevidenced for the same reason. The Settings chord is evidenced as registered, not as working — the automation surface could not deliver the keypress. |
| macOS | No isolated end-to-end run has ever happened, for any release. |
| Linux | Unverified. No Workbench end-to-end evidence exists on Linux; support is not claimed until it is. |

### Outstanding verification

These have been carried across two releases without running. They are listed here as open work,
not as a plan attached to a version that already shipped:

- Split Pane exercised in a browser: a second pane opened by Ctrl/Command-click, and quote-badge
  placement against the host's turn rail. Both need a configured model in the isolated home.
- Stock-Harness general-plugin install, on any platform.
- Read-only-`$DSH_HOME` degradation.
- macOS isolated end-to-end, exercised through a real user channel.

Platform claims here track [`plans/260827-workbench-v2/tasks.md`](../plans/260827-workbench-v2/tasks.md) §8 (decision record) and the A5 task row. A platform is only listed as supported once its cold-environment install, upgrade, uninstall, and non-interference-with-official-Harness checks have actually run.
