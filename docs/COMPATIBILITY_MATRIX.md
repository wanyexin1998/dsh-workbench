# Compatibility matrix

| Component | Required source | Capability | Status |
| --- | --- | --- | --- |
| Workbench `0.2.0-rc.6` | Harness fork `c5a387cd` (`rc4/presentation-on-0.1.2`, the current pin) | Session Presentation protocol 2 | Supported source preview |
| Workbench `0.2.0-rc.6` | Harness fork `c5a387cd` | `ctx.layout.toggleSettings()` | Open Settings registers as a toggle: the same chord opens and dismisses |
| Workbench `0.2.0-rc.6` | Harness fork `1a8cf5ba` (`fix/plugin-spec-quoting`, the `v0.2.0-rc.2` pin; the `v0.2.0-rc.3` pin `82de604a` already carried the toggle verb) | `ctx.layout.openSettings()` only | Open Settings registers open-only and is labelled "Open settings" |
| Workbench `0.2.0-rc.6` | Stock Harness `0.1.2-rc.1` | protocol 2 absent | Split Pane fails closed |
| Workbench `0.2.0-rc.6` | Stock Harness `0.1.2-rc.1` | neither Settings verb | The Open Settings action is not registered at all |
| Panel Compatibility `0.1.0-rc.4` | Better Sidebar fork `1685770` | Pane protocol 1 + actions protocol 1 | **Incompatible — do not install.** The fork was built against the previous upstream baseline and imports an export deleted in the pinned one; the plugin loader fails the whole tree and the harness does not boot. Pane-local panels are unavailable until a rebuilt fork is pinned. |
| Panel Compatibility absent | Any panel provider | n/a | Core Workbench remains functional |
| Panel Compatibility + stock Better Sidebar 0.16.1 | Pane protocol absent | no attachment | Better Sidebar retains its global behavior. **This is the supported configuration on `0.2.0-rc.6`**, the pinned fork row above being unusable. |

Exact repository URLs, branches, commits, and versions are machine-readable in [`release-contract.json`](../release-contract.json).

Neither downstream fork is republished under the upstream npm namespace.

## Distribution status

| Path | Status |
| --- | --- |
| Stock-Harness general plugin (`file:` TGZ + `dsh plugin add`) | Ships as a downloadable, SHA256-verified GitHub Release asset as of `v0.2.0-rc.6` (not GPG-signed). See [`docs/INSTALL.md`](INSTALL.md) § Quick Install. The source-build path in the same document remains available as an audit alternative. |
| Split-pane bootstrap installer (`.ps1` / `.sh`) | Ships as an immutable, SHA256-verified GitHub Release asset as of `v0.2.0-rc.6` (hashes recorded in `SHA256SUMS`). Source lives at `scripts/bootstrap/dsh-workbench-bootstrap.ps1` and `.sh`, with its own node:test suite (`scripts/bootstrap/bootstrap.test.mjs`). |
| npm / GitHub Packages | None. Not published, and not planned — the distribution model is source plus SHA256-verified Release artifacts. |

## Platform support

| Platform | Status |
| --- | --- |
| Windows | Split-pane bootstrap: isolated end-to-end verification complete, **against the withdrawn `v0.2.0-rc.4` installer, which pinned Harness `c5a387cd` — the same pin this release carries**. The published `dsh-workbench-bootstrap.ps1`, downloaded from the release and verified against the published `SHA256SUMS`, run against a clean target with a deliberately space-containing path and no `-TgzSha256` argument, reported `state: installed` / exit 0. Confirmed independently afterwards: detached HEAD at the pinned commit with a clean worktree, the downloaded TGZ digest equal to the published one, a self-relative launcher, and an untouched real `~/.dsh`. Launched from that launcher, the client boot graph carries `@wanyexin1998/dsh-workbench`, the console is clean, and Settings shows the Workbench's own shortcut section. **This run cloned from GitHub directly**, unlike the `v0.2.0-rc.2` run which fell back to a local mirror after transport resets, so GitHub reachability is evidenced here; one attempt did fail on a reset first, and the installer failed closed with a valid result JSON and exit 1. **Split Pane was not exercised in this isolated run** — that home has no configured model — and its automation surface could not deliver a keypress. Both gaps were closed separately in `0.2.0-rc.6`, on a real `~/.dsh` running this same pinned fork: Ctrl-click produced two `[data-session-pane]`, the quote badge cleared the host's turn rail by 145px in a 1440px viewport, and the Settings chord toggled Settings when pressed. That run exercised the chord at a user-overridden binding, so `Primary+,` as a **shipped default** is still unexercised. |
| macOS | No isolated end-to-end run has ever happened, for any release. |
| Linux | Unverified. No Workbench end-to-end evidence exists on Linux; support is not claimed until it is. |

### Outstanding verification

`0.2.0-rc.6` closed the browser half of the first item by driving it on a real `~/.dsh`. What is left
is listed here as open work, not as a plan attached to a version that already shipped:

- Stock-Harness general-plugin install, on any platform. `0.2.0-rc.6` installed the TGZ into a real
  profile, but on the pinned fork, not on stock Harness.
- Read-only-`$DSH_HOME` degradation.
- macOS isolated end-to-end, exercised through a real user channel.
- Split Pane inside the **isolated bootstrap home** specifically — still blocked on configuring a
  model there.
- `Primary+,` as a shipped **default** chord. `0.2.0-rc.6` verified the Settings toggle at a
  user-overridden binding and verified default-chord dispatch separately with `Primary+/`; the two
  have never been true at once on one machine.
- Pane-local panels, end to end. **Blocked, not merely unrun**: no Better Sidebar commit compatible
  with the pinned Harness baseline exists. See [`docs/KNOWN_ISSUES.md`](KNOWN_ISSUES.md).
- Automated coverage for drag-select → selection toolbar. `0.2.0-rc.6` verified it by hand in a
  browser; `e2e/harness-web/` still holds carriers that nothing in `pnpm release:check` runs.

Platform claims here track [`plans/260827-workbench-v2/tasks.md`](../plans/260827-workbench-v2/tasks.md) §8 (decision record) and the A5 task row. A platform is only listed as supported once its cold-environment install, upgrade, uninstall, and non-interference-with-official-Harness checks have actually run.
