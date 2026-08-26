# Source-preview installation

This preview uses pinned source revisions. Workbench does not automatically install third-party plugins.

## 1. Build the Harness fork

```powershell
git clone https://github.com/wanyexin1998/deepseek-harness.git
cd deepseek-harness
git switch codex/presentation-v2
git checkout 53015a6f39710dac52ed08f05aca0c6bad7444ac
pnpm install --frozen-lockfile
pnpm build
```

Do not publish the resulting `@deepseek-ai/*` packages. They retain upstream names solely so the fork can be built and tested as a coherent source tree.

## 2. Build Workbench artifacts

Before cloning, obtain and approve a full 40-character Workbench commit through an independent trusted channel. A branch, short SHA, ordinary tag, or repository-controlled document is not an independent trust anchor.

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
# SOURCE-VERIFIED-BEFORE-REPOSITORY-CODE
pnpm install --frozen-lockfile
pnpm release:check
```

The two TGZ files and `SHA256SUMS` are written under `dist/`.

The bundle step requires a committed clean worktree, rebuilds both packages, scans generated runtime, and records that source commit in `release-manifest.json` before packing.

Install the Workbench TGZ into the Web profile:

```powershell
dsh plugin --profile web add file:C:\absolute\path\to\dist\wanyexin1998-dsh-workbench-0.2.0-rc.1.tgz
```

The Split Pane module fails closed unless `sessions.presentation.protocol === 2`.

## 3. Optional Pane panels

Workbench does not require Better Sidebar. To enable independent right and bottom panels in each Pane:

1. Build [wanyexin1998/DSH-better-sidebar](https://github.com/wanyexin1998/DSH-better-sidebar) at commit `91e772a09e5f66a14c36036f69adb4d866f06ac3`.
2. Install that local fork into the same profile.
3. Install `dist/wanyexin1998-dsh-workbench-panel-compat-0.1.0-rc.1.tgz`.

The compatibility package does not download, install, update, or remove Better Sidebar. Stock Better Sidebar without Pane protocol 1 remains on its original global path.

## 4. Verify

- Ctrl/Command-click a listed Session opens it beside the focused Pane.
- Ordinary click replaces the focused Pane.
- Both Panes preserve independent drafts, scroll state, Navigator, and optional panels.
- Refresh restores one Pane; multi-Pane membership is process-local by design.
