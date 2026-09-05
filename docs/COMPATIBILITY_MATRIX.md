# Compatibility matrix

| Component | Required source | Capability | Status |
| --- | --- | --- | --- |
| Workbench `0.2.0-rc.3` | Harness fork `82de604a` (`feat/toggle-settings-verb`, the current pin) | Session Presentation protocol 2 | Supported source preview |
| Workbench `0.2.0-rc.3` | Harness fork `82de604a` | `ctx.layout.toggleSettings()` | Open Settings registers as a toggle: the same chord opens and dismisses |
| Workbench `0.2.0-rc.3` | Harness fork `1a8cf5ba` (`fix/plugin-spec-quoting`, the `v0.2.0-rc.2` pin) | `ctx.layout.openSettings()` only | Open Settings registers open-only and is labelled "Open settings" |
| Workbench `0.2.0-rc.3` | Stock Harness `0.1.1-rc.2` | protocol 2 absent | Split Pane fails closed |
| Workbench `0.2.0-rc.3` | Stock Harness `0.1.1-rc.2` | neither Settings verb | The Open Settings action is not registered at all |
| Panel Compatibility `0.1.0-rc.1` | Better Sidebar fork `1685770` | Pane protocol 1 + actions protocol 1 | Supported optional adapter |
| Panel Compatibility absent | Any panel provider | n/a | Core Workbench remains functional |
| Panel Compatibility + stock Better Sidebar 0.16.1 | Pane protocol absent | no attachment | Better Sidebar retains its global behavior |

Exact repository URLs, branches, commits, and versions are machine-readable in [`release-contract.json`](../release-contract.json).

Neither downstream fork is republished under the upstream npm namespace.

## Distribution status

| Path | Status |
| --- | --- |
| Stock-Harness general plugin (`file:` TGZ + `dsh plugin add`) | Ships as a downloadable, SHA256-verified GitHub Release asset as of `v0.2.0-rc.3` (not GPG-signed). See [`docs/INSTALL.md`](INSTALL.md) § Quick Install. The source-build path in the same document remains available as an audit alternative. |
| Split-pane bootstrap installer (`.ps1` / `.sh`) | Ships as an immutable, SHA256-verified GitHub Release asset as of `v0.2.0-rc.3` (hashes recorded in `SHA256SUMS`). Source lives at `scripts/bootstrap/dsh-workbench-bootstrap.ps1` and `.sh`, with its own node:test suite (`scripts/bootstrap/bootstrap.test.mjs`). |
| npm / GitHub Packages | None. Not published, and not planned — the distribution model is source plus SHA256-verified Release artifacts. |

## Platform support

| Platform | Status |
| --- | --- |
| Windows | Split-pane bootstrap: isolated end-to-end verification complete, **against the `v0.2.0-rc.2` installer, which pinned Harness `1a8cf5ba`**. The unmodified `dsh-workbench-bootstrap.ps1`, run against a clean target with a deliberately space-containing path and no `-TgzSha256` argument, reported `state: installed` / exit 0; detached HEAD at the pinned Harness commit, profile-dependency/bundle registration, the materialized package, the installer's own load probe, a working self-relative launcher, and an untouched real `~/.dsh` profile were all independently confirmed afterward. That run's `git clone` was pointed at a local bare mirror of the same repository (via `url.<base>.insteadOf`, scoped to one process) after two attempts failed on GitHub transport resets; the installer still verified the checkout against its embedded 40-character commit hash, so content authenticity is proven, but GitHub reachability from that machine at that time is not evidenced. **The `v0.2.0-rc.3` installer, which pins `82de604a`, has not been re-run end to end.** Its diff against the verified one is the version, release URL, TGZ digest, and Harness commit constants; that is a small diff, but "small diff" is not evidence. |
| macOS | No isolated end-to-end run has ever happened, for any release. |
| Linux | Unverified. No Workbench end-to-end evidence exists on Linux; support is not claimed until it is. |

### Outstanding verification

These have been carried across two releases without running. They are listed here as open work,
not as a plan attached to a version that already shipped:

- Stock-Harness general-plugin install, on any platform.
- Read-only-`$DSH_HOME` degradation.
- macOS isolated end-to-end, exercised through a real user channel.
- Windows isolated end-to-end **re-run against the `82de604a` pin**.

Platform claims here track [`plans/260827-workbench-v2/tasks.md`](../plans/260827-workbench-v2/tasks.md) §8 (decision record) and the A5 task row. A platform is only listed as supported once its cold-environment install, upgrade, uninstall, and non-interference-with-official-Harness checks have actually run.
