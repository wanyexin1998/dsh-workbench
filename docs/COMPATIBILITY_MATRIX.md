# Compatibility matrix

| Component | Required source | Capability | Status |
| --- | --- | --- | --- |
| Workbench `0.2.0-rc.1` | Harness fork `53015a6f` | Session Presentation protocol 2 | Supported source preview |
| Workbench `0.2.0-rc.1` | Stock Harness `0.1.1-rc.2` | protocol 2 absent | Split Pane fails closed |
| Panel Compatibility `0.1.0-rc.1` | Better Sidebar fork `91e772a` | Pane protocol 1 | Supported optional adapter |
| Panel Compatibility absent | Any panel provider | n/a | Core Workbench remains functional |
| Panel Compatibility + stock Better Sidebar 0.16.1 | Pane protocol absent | no attachment | Better Sidebar retains its global behavior |

Exact repository URLs, branches, commits, and versions are machine-readable in [`release-contract.json`](../release-contract.json).

Neither downstream fork is republished under the upstream npm namespace.

## Distribution status

| Path | Status |
| --- | --- |
| Stock-Harness general plugin (`file:` TGZ + `dsh plugin add`) | Installer commands documented; ships as a downloadable GitHub Release asset starting with `v0.2.0-rc.2`, not yet published. Today (`0.2.0-rc.1`, `source-preview`) there is no signed Release TGZ — use the source-build path in [`docs/INSTALL.md`](INSTALL.md). |
| Split-pane bootstrap installer (`.ps1` / `.sh`) | Scripts exist on this branch at `scripts/bootstrap/dsh-workbench-bootstrap.ps1` and `.sh`, with their own node:test suite (`scripts/bootstrap/bootstrap.test.mjs`); they ship as immutable GitHub Release assets (hashes recorded in `SHA256SUMS`) starting with `v0.2.0-rc.2`, not yet published. |
| npm / GitHub Packages | None. Not published, not planned for `rc.2`. |

## Platform support

| Platform | Status |
| --- | --- |
| Windows | Targeted for `v0.2.0-rc.2` isolated end-to-end verification (stock plugin install, read-only-home degradation, bootstrap end-to-end). Not yet run. |
| macOS | Targeted for `v0.2.0-rc.2` isolated end-to-end verification, exercised through a real user channel. Not yet run. |
| Linux | Unverified. No Workbench end-to-end evidence exists on Linux; support is not claimed until it is. |

Platform claims here track [`plans/260827-workbench-v2/tasks.md`](../plans/260827-workbench-v2/tasks.md) §8 (decision record) and the A5 task row. A platform is only listed as supported once its cold-environment install, upgrade, uninstall, and non-interference-with-official-Harness checks have actually run.
