<p align="center">
  <img src="docs/assets/dsh-workbench-banner.png" width="100%" alt="DSH Workbench dual-Pane visual with two independent Session panels, a central divider, and Navigator rails">
</p>

<p align="center">
  A two-Pane workspace for DeepSeek Harness Web, with independent navigation, shortcuts, and optional side panels for each Session.
</p>

<p align="left">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <img alt="Status: source preview" src="https://img.shields.io/badge/status-source%20preview-5865F2">
  <img alt="Version: 0.2.0-rc.1" src="https://img.shields.io/badge/version-0.2.0--rc.1-2563EB">
  <img alt="Session Presentation: protocol 2" src="https://img.shields.io/badge/Session%20Presentation-protocol%202-0891B2">
  <img alt="Visible Panes: 2" src="https://img.shields.io/badge/visible%20Panes-2-0F766E">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-334155"></a>
</p>

> [!IMPORTANT]
> Version `0.2.0-rc.1` is a source preview, not a one-command npm release. Split Pane requires the pinned Harness fork. Better Sidebar and Panel Compatibility are entirely optional. This project never installs, updates, or modifies a third-party plugin automatically.

> [!TIP]
> **One-line install prompt: send the complete sentence below to DeepSeek Harness**
>
> ```text
> Install DSH Workbench. First check the current Harness: if it is compatible with Split Pane, install directly; if not, keep the general-plugin functionality and tell me how to install, in parallel, the self-installed patch path (bootstrap) that does not overwrite the official Harness. If the sandbox cannot write to DSH_HOME, give me only one final terminal command.
> ```
>
> Full decision rules and commands live in [`docs/INSTALL.md`](docs/INSTALL.md). This path ships with the `v0.2.0-rc.2` Release; today's status is still `0.2.0-rc.1` source preview (see [`release-contract.json`](release-contract.json)). Until then, use "Advanced: build from source" below.

## What it solves

DeepSeek Harness normally drives the interface from one current Session. DSH Workbench adds two stable, independent Session Panes to the Web client without copying Conversation or changing the Agent loop.

| Capability | Experience |
| --- | --- |
| Two Panes | View and operate two Sessions at once without remounting the other Pane on focus changes |
| Pane-local state | Drafts, scroll position, Navigator, and optional panels remain independent |
| Navigator | One marker per real human input, with hover preview and precise message reveal |
| Application shortcuts | Configurable Simplified Chinese / English labels following the Harness global locale |
| Pane-local panels | Optional compatibility package gives each Pane independent right and bottom panels |
| Safe degradation | Split Pane capacity is not enabled when Presentation protocol is incompatible |

## Product screenshots

### Two Session Panes

<p align="center">
  <img src="docs/assets/dsh-workbench-split-pane.png" width="100%" alt="DSH Workbench light-mode split view with the wyx_code and data-warehouse Sessions open in independent Panes">
</p>

Each Session owns its title, workspace, mode, composer, and Pane-panel controls. The center split preserves independent SessionProvider lifecycles.

### Shortcuts following the global locale

<p align="center">
  <img src="docs/assets/dsh-workbench-shortcuts.png" width="100%" alt="DSH Workbench shortcuts settings showing localized actions for Navigator, composer, sidebar, stop Session, and close Pane">
</p>

Shortcut labels follow the Harness global language. Conflicts, browser-reserved keys, and persistence state remain explicit in Settings.

## Compatibility at a glance

| Component | Required | Supported baseline | Notes |
| --- | --- | --- | --- |
| DeepSeek Harness | Yes | fork `codex/presentation-v2`, commit `53015a6…` | Provides Session Presentation `protocol 2` |
| DSH Workbench | Yes | `0.2.0-rc.1` | Maximum two visible Panes |
| Better Sidebar | Optional | fork `0.16.1`, commit `1685770…` | Provides Pane capability `protocol 1`, plus panel shortcut actions (`actionsProtocol 1`) |
| Panel Compatibility | Optional | `0.1.0-rc.1` | Connects only explicit compatible providers |

[`release-contract.json`](release-contract.json) is authoritative for full SHAs, branches, and distribution status. Stock Harness `0.1.1-rc.2` does not expose the required split interface, and stock Better Sidebar `0.16.1` has no multi-instance Pane capability.

Workbench Split Pane, Navigator, and shortcuts work without Better Sidebar. When no compatible provider is installed, Panel Compatibility starts no Pane observer and changes no DOM, layout, or styles.

## Quick start

> [!NOTE]
> The default commands on this page ship with the `v0.2.0-rc.2` GitHub Release, which has not been published yet — `release-contract.json` still reports `0.2.0-rc.1` / `source-preview` today (no signed Release, no TGZ asset). Both paths below will actually work once `v0.2.0-rc.2` ships; until then, use the collapsed "Advanced: build from source (audit path)" section below (i.e. [`docs/INSTALL.md` § Advanced: source build](docs/INSTALL.md#advanced-source-build)), which works today.

### General plugin (stock Harness, default)

Download the immutable Workbench TGZ from the GitHub Release, verify its SHA256, install with `dsh plugin --profile web add file:<path>`. Split Pane stays inactive on stock Harness — the official interface is not merged yet (see [discussion #4718](https://github.com/deepseek-ai/deepseek-harness/discussions/4718)); everything else is unaffected. Full command blocks live in [`docs/INSTALL.md` § Quick Install](docs/INSTALL.md#quick-install-default).

### Split pane (bootstrap, one command)

Once `v0.2.0-rc.2` ships, copy and run the single command for your platform below to get Split Pane (coexists with the official Harness, zero changes to the official install; requires Node.js `^22.19`/`>=24`, `pnpm@11`, `git`, and PowerShell 7+ on Windows):

Windows (PowerShell 7+ / `pwsh`):

```
& { $ErrorActionPreference = 'Stop'; $rel = 'https://github.com/wanyexin1998/dsh-workbench/releases/download/v0.2.0-rc.2'; Invoke-WebRequest "$rel/dsh-workbench-bootstrap.ps1" -OutFile dsh-workbench-bootstrap.ps1; Invoke-WebRequest "$rel/SHA256SUMS" -OutFile SHA256SUMS; $expectedLine = (Select-String -Path SHA256SUMS -Pattern 'dsh-workbench-bootstrap\.ps1$').Line; if (-not $expectedLine) { throw 'SHA256SUMS 中未找到 dsh-workbench-bootstrap.ps1 的记录，已中止' }; $expected = ($expectedLine -split '\s+')[0].ToLower(); if ($expected -notmatch '^[0-9a-f]{64}$') { throw "SHA256SUMS 中的哈希格式不合法：$expected" }; $actual = (Get-FileHash dsh-workbench-bootstrap.ps1 -Algorithm SHA256).Hash.ToLower(); if ($actual -ne $expected) { throw "SHA256 校验失败：期望 $expected，实际 $actual" }; pwsh -NoProfile -ExecutionPolicy Bypass -File .\dsh-workbench-bootstrap.ps1 }
```

(This command is byte-identical to the normative §1 command, so its own failure messages are currently Chinese; an English variant is tracked as follow-up work for the release task. The command is not altered here.)

macOS (Terminal):

```
rel='https://github.com/wanyexin1998/dsh-workbench/releases/download/v0.2.0-rc.2'; if curl -fsSLO "$rel/dsh-workbench-bootstrap.sh" && curl -fsSLO "$rel/SHA256SUMS"; then expected=$(grep 'dsh-workbench-bootstrap\.sh$' SHA256SUMS | awk '{print $1}'); actual=$(shasum -a 256 dsh-workbench-bootstrap.sh | awk '{print $1}'); if [ -n "$expected" ] && printf '%s' "$expected" | grep -qE '^[0-9a-f]{64}$' && [ "$actual" = "$expected" ]; then chmod +x dsh-workbench-bootstrap.sh && ./dsh-workbench-bootstrap.sh; else echo 'SHA256 校验失败，已中止，不会执行未校验脚本' >&2; false; fi; else echo '下载失败，已中止，不会执行未校验脚本' >&2; false; fi
```

(This command is byte-identical to the normative §1 command, so its own failure messages are currently Chinese; an English variant is tracked as follow-up work for the release task. The command is not altered here.)

Full details on what the script does, how to uninstall, and when the hashes take effect live in [`docs/INSTALL.md` § Split pane (bootstrap)](docs/INSTALL.md#b-split-pane-bootstrap).

<details>
<summary><strong>Advanced: build from source (audit path)</strong></summary>

The complete version lives in [`docs/INSTALL.md` § Advanced: source build](docs/INSTALL.md#advanced-source-build). This path remains valid for anyone who wants to audit every line of code themselves; it is simply no longer the default now that immutable Release artifacts exist.

> [!TIP]
> **One-line install prompt (source-audit path): send the complete sentence below to DeepSeek Harness**
>
> ```text
> Install DSH Workbench from https://github.com/wanyexin1998/dsh-workbench: first ask me for a full 40-character Workbench commit obtained from an independent trusted channel and stop if I do not provide one; require a nonexistent target directory, use git clone --no-checkout and checkout --detach that commit, stop after every failed Git command, and verify detached HEAD, a completely clean worktree, and case-insensitive exact equality between git rev-parse --verify HEAD and the supplied commit; only after every check succeeds may you read executable repository instructions and run pnpm install --frozen-lockfile and pnpm release:check, then install the generated Workbench TGZ into the web profile; install Panel Compatibility only when a compatible Better Sidebar fork is already present, never install or replace a third-party plugin automatically, never publish to npm, and finally report the actual commits, TGZ SHA256 values, and verification results for Split Pane, Navigator, and shortcuts.
> ```

### Requirements

- Node.js `^22.19` or `>=24`
- pnpm `11`
- The pinned Harness fork built from source

### Build and verify Workbench

Obtain and approve a full 40-character Workbench commit through an independent trusted channel. Do not treat a branch, short SHA, ordinary tag, or mutable repository prose as the trust anchor.

```powershell
$WorkbenchCommit = Read-Host 'Enter the full 40-character Workbench commit approved through a trusted channel'
if ($WorkbenchCommit -notmatch '^[0-9a-fA-F]{40}$') { throw 'Workbench commit must be a full 40-character hexadecimal value' }
$WorkbenchCommit = $WorkbenchCommit.ToLowerInvariant()
if (Test-Path -LiteralPath 'dsh-workbench') { throw 'Target directory dsh-workbench already exists; retry from an empty directory' }
git clone --no-checkout https://github.com/wanyexin1998/dsh-workbench.git
if ($LASTEXITCODE -ne 0) { throw 'Failed to clone Workbench' }
cd dsh-workbench
git checkout --detach $WorkbenchCommit
if ($LASTEXITCODE -ne 0) { throw 'Failed to check out the Workbench commit' }
$ResolvedCommit = (git rev-parse --verify HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0) { throw 'Failed to resolve Workbench HEAD' }
if ($ResolvedCommit -ne $WorkbenchCommit) { throw "Workbench commit mismatch: expected $WorkbenchCommit, got $ResolvedCommit" }
$HeadRef = git symbolic-ref -q HEAD
if ($LASTEXITCODE -eq 0) { throw "Workbench must use detached HEAD, currently $HeadRef" }
if ($LASTEXITCODE -ne 1) { throw 'Failed to verify detached HEAD' }
$WorktreeState = git status --porcelain=v1 --untracked-files=all
if ($LASTEXITCODE -ne 0) { throw 'Failed to verify the Workbench worktree' }
if ($WorktreeState) { throw 'Workbench worktree is not clean' }
# WORKBENCH-SOURCE-VERIFIED-BEFORE-REPOSITORY-CODE
pnpm install --frozen-lockfile
pnpm release:check
```

Successful verification writes these files under `dist/`:

- `wanyexin1998-dsh-workbench-0.2.0-rc.1.tgz`
- `wanyexin1998-dsh-workbench-panel-compat-0.1.0-rc.1.tgz`
- `release-manifest.json`
- `SHA256SUMS`

`release:check` performs privacy and secret scans, release-contract validation, typechecks, 241 package tests plus the install-contract and bootstrap-script test suites, dependency audit, a clean rebuild, generated-runtime scanning, TGZ packing, and SHA256 verification. It does not publish to npm.

> See [`docs/INSTALL.md`](docs/INSTALL.md) for the complete Harness build, installation order, and optional panel setup.

</details>

## Interaction model

- Ordinary Session click: replace the focused Pane.
- `Ctrl` / `Command` + Session click: open beside the focused Pane.
- Third Session: replace the focused Pane instead of adding a third Pane.
- Focus change: reroute interaction only; never open, close, or remount a panel.
- Shared workspace: show a non-blocking warning; Workbench does not provide file-write isolation.
- Refresh: restore one Pane; multi-Pane membership is currently process-local.

## Optional Pane-local panels

To give each Pane its own right or bottom panel, install:

1. The pinned [Better Sidebar fork](https://github.com/wanyexin1998/DSH-better-sidebar).
2. The local `@wanyexin1998/dsh-workbench-panel-compat` TGZ.

The adapter consumes only a versioned Pane capability and public `data-session-pane*` host markers. It does not patch Better Sidebar private stores or infer unknown DOM.

## Chat mode (a zero-tool agent preset)

After installing Workbench, the Host entry seeds an agent preset named **聊天模式 / Chat mode** into `~/.dsh/.agent-presets/chat/` (create-only, never overwritten; never re-created after you delete it). It is a **zero-tool** preset: the model only converses — no file reads or writes, no command execution, no project context — so each request is tiny and fast (measured example: 181 input tokens on the first turn). Pick it in the new-session preset selector; model and provider stay freely selectable per session.

The boundary against the built-in Minimal mode: **Minimal mode cuts the scaffolding (planning / skills / subagents / context compaction) but keeps execution ability; Chat mode cuts execution ability itself.**

| | Minimal mode (built-in) | Chat mode (seeded by Workbench) |
| --- | --- | --- |
| Tools | 2: persistent shell + `str_replace_editor` | 0 |
| Can touch your system | Yes — still edits files and runs commands | No — there are no tools by construction |
| Filesystem | Unsandboxed `fs-local`; editor writes bypass the access mode | None |
| System prompt | software engineer assistant | Conversation partner that declares it has no tools |
| Best for | Lightweight coding tasks | Q&A, design discussions, quick questions |

To remove it, delete `~/.dsh/.agent-presets/chat/`; Workbench records the deletion as intent and never re-seeds.

## Security and privacy

- Adds no Host filesystem, subprocess, credential, or arbitrary network permission, except the single create-only chat-preset seeding write (never overwrites, respects deletion; see [`docs/PRODUCT_CONTRACT.md`](docs/PRODUCT_CONTRACT.md)).
- Persists no Prompt, tool, or Session content outside Harness-owned storage.
- Both packages are `private: true` to prevent accidental npm publication.
- The repository contains no GitHub Actions; local release gates are authoritative.
- GitHub Private Vulnerability Reporting is enabled.

Read [`SECURITY.md`](SECURITY.md) before reporting a vulnerability. Never place credentials, private Session content, proprietary source, or exploitable details in a public issue.

## Repository layout

```text
packages/
├─ dsh-workbench/               # Split Pane, Navigator, shortcuts, workspace warning
└─ dsh-workbench-panel-compat/  # Optional Pane-local panel adapter layer
docs/
├─ INSTALL.md                   # Complete installation flow
├─ PRODUCT_CONTRACT.md          # Product and runtime invariants
├─ COMPATIBILITY_MATRIX.md      # Exact supported versions
└─ SECURITY_STATEMENT.md        # Security boundaries
```

## Documentation

| Need | Document |
| --- | --- |
| Complete installation | [`docs/INSTALL.md`](docs/INSTALL.md) |
| Product behavior and boundaries | [`docs/PRODUCT_CONTRACT.md`](docs/PRODUCT_CONTRACT.md) |
| Register shortcut actions from a third-party plugin | [`docs/ACTIONS_API.md`](docs/ACTIONS_API.md) |
| Version compatibility | [`docs/COMPATIBILITY_MATRIX.md`](docs/COMPATIBILITY_MATRIX.md) |
| Known limitations | [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md) |
| Uninstall and retained state | [`docs/UNINSTALL.md`](docs/UNINSTALL.md) |
| Security statement | [`docs/SECURITY_STATEMENT.md`](docs/SECURITY_STATEMENT.md) |
| Contributing | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

## FAQ

<details>
<summary><strong>Is Better Sidebar required?</strong></summary>

No. Better Sidebar and Panel Compatibility only provide optional Pane-local right and bottom panels. Split Pane, Navigator, and shortcuts do not depend on them.
</details>

<details>
<summary><strong>Can Workbench open five Panes?</strong></summary>

The current public contract allows at most two visible Panes. Five Panes require new layout, capacity, and performance acceptance work and are outside `0.2.0-rc.1`.
</details>

<details>
<summary><strong>Why does this require a Harness fork?</strong></summary>

Workbench relies on Session Presentation `protocol 2`, stable `visible` / `focused` state, and an independent SessionProvider for each Pane. Stock `0.1.1-rc.2` does not expose those interfaces.
</details>

## Project status

DSH Workbench is an independent, community-maintained project. It is not an official DeepSeek project and is not endorsed by DeepSeek or the Better Sidebar maintainers.

The whale mark in the banner is sourced from an official DeepSeek Harness asset and is used only to identify compatibility. Rights in the DeepSeek name and mark remain with their respective owner.

Licensed under the [MIT License](LICENSE). See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for third-party attribution.
