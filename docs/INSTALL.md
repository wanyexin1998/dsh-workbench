# Source-preview installation

This preview uses pinned source revisions. Workbench does not automatically install third-party plugins. Obtain the user-approved Workbench commit through an independent trusted channel before using any repository-controlled instructions.

## 1. Verify the Workbench source

Do not execute pnpm, Node, editor tasks, or repository scripts until this section succeeds. A branch, short SHA, ordinary tag, or repository-controlled document is not an independent trust anchor.

```powershell
$WorkbenchCommit = Read-Host 'Enter the full 40-character Workbench commit approved through a trusted channel'
if ($WorkbenchCommit -notmatch '^[0-9a-fA-F]{40}$') { throw 'Workbench commit must be a full 40-character hexadecimal value' }
$WorkbenchCommit = $WorkbenchCommit.ToLowerInvariant()
if (Test-Path -LiteralPath 'dsh-workbench') { throw 'Target directory dsh-workbench already exists; retry from an empty directory' }
git clone --no-checkout https://github.com/wanyexin1998/dsh-workbench.git dsh-workbench
if ($LASTEXITCODE -ne 0) { throw 'Failed to clone Workbench' }
git -C dsh-workbench checkout --detach $WorkbenchCommit
if ($LASTEXITCODE -ne 0) { throw 'Failed to check out the Workbench commit' }
$ResolvedCommit = (git -C dsh-workbench rev-parse --verify HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0) { throw 'Failed to resolve Workbench HEAD' }
if ($ResolvedCommit -ne $WorkbenchCommit) { throw "Workbench commit mismatch: expected $WorkbenchCommit, got $ResolvedCommit" }
$HeadRef = git -C dsh-workbench symbolic-ref -q HEAD
if ($LASTEXITCODE -eq 0) { throw "Workbench must use detached HEAD, currently $HeadRef" }
if ($LASTEXITCODE -ne 1) { throw 'Failed to verify detached HEAD' }
$WorktreeState = git -C dsh-workbench status --porcelain=v1 --untracked-files=all
if ($LASTEXITCODE -ne 0) { throw 'Failed to verify the Workbench worktree' }
if ($WorktreeState) { throw 'Workbench worktree is not clean' }
# WORKBENCH-SOURCE-VERIFIED-BEFORE-REPOSITORY-CODE
```

## 2. Verify and build the Harness fork

The following commit is part of the verified Workbench release contract. Do not switch to its mutable branch before building.

```powershell
$HarnessCommit = '53015a6f39710dac52ed08f05aca0c6bad7444ac'
if ($HarnessCommit -notmatch '^[0-9a-f]{40}$') { throw 'Harness commit must be a full 40-character hexadecimal value' }
if (Test-Path -LiteralPath 'deepseek-harness') { throw 'Target directory deepseek-harness already exists; retry from an empty directory' }
git clone --no-checkout https://github.com/wanyexin1998/deepseek-harness.git deepseek-harness
if ($LASTEXITCODE -ne 0) { throw 'Failed to clone the Harness fork' }
git -C deepseek-harness checkout --detach $HarnessCommit
if ($LASTEXITCODE -ne 0) { throw 'Failed to check out the Harness commit' }
$ResolvedHarnessCommit = (git -C deepseek-harness rev-parse --verify HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0) { throw 'Failed to resolve the Harness HEAD' }
if ($ResolvedHarnessCommit -ne $HarnessCommit) { throw "Harness commit mismatch: expected $HarnessCommit, got $ResolvedHarnessCommit" }
$HarnessHeadRef = git -C deepseek-harness symbolic-ref -q HEAD
if ($LASTEXITCODE -eq 0) { throw "Harness must use detached HEAD, currently $HarnessHeadRef" }
if ($LASTEXITCODE -ne 1) { throw 'Failed to verify the Harness detached HEAD' }
$HarnessWorktreeState = git -C deepseek-harness status --porcelain=v1 --untracked-files=all
if ($LASTEXITCODE -ne 0) { throw 'Failed to verify the Harness worktree' }
if ($HarnessWorktreeState) { throw 'Harness worktree is not clean' }
# HARNESS-SOURCE-VERIFIED-BEFORE-REPOSITORY-CODE
Push-Location -LiteralPath 'deepseek-harness' -ErrorAction Stop
try {
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'Harness dependency installation failed' }
  pnpm build
  if ($LASTEXITCODE -ne 0) { throw 'Harness build failed' }
} finally {
  Pop-Location
}
```

Do not publish the resulting `@deepseek-ai/*` packages. They retain upstream names solely so the fork can be built and tested as a coherent source tree.

## 3. Build Workbench artifacts

The Workbench checkout from section 1 is already detached, commit-matched, and clean.

```powershell
Push-Location -LiteralPath 'dsh-workbench' -ErrorAction Stop
try {
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'Workbench dependency installation failed' }
  pnpm release:check
  if ($LASTEXITCODE -ne 0) { throw 'Workbench release checks failed' }
} finally {
  Pop-Location
}
```

The two TGZ files and `SHA256SUMS` are written under `dsh-workbench/dist/`.

The bundle step requires a committed clean worktree, rebuilds both packages, scans generated runtime, validates bundled notices, and records that source commit in `release-manifest.json` before packing.

Install the Workbench TGZ into the Web profile:

```powershell
dsh plugin --profile web add file:C:\absolute\path\to\dsh-workbench\dist\wanyexin1998-dsh-workbench-0.2.0-rc.1.tgz
```

The Split Pane module fails closed unless `sessions.presentation.protocol === 2`.

## 4. Optional Pane panels

Workbench does not require Better Sidebar. Only prepare this checkout if you want independent right and bottom panels in each Pane.

```powershell
$BetterSidebarCommit = '91e772a09e5f66a14c36036f69adb4d866f06ac3'
if ($BetterSidebarCommit -notmatch '^[0-9a-f]{40}$') { throw 'Better Sidebar commit must be a full 40-character hexadecimal value' }
if (Test-Path -LiteralPath 'DSH-better-sidebar') { throw 'Target directory DSH-better-sidebar already exists; retry from an empty directory' }
git clone --no-checkout https://github.com/wanyexin1998/DSH-better-sidebar.git DSH-better-sidebar
if ($LASTEXITCODE -ne 0) { throw 'Failed to clone the Better Sidebar fork' }
git -C DSH-better-sidebar checkout --detach $BetterSidebarCommit
if ($LASTEXITCODE -ne 0) { throw 'Failed to check out the Better Sidebar commit' }
$ResolvedBetterSidebarCommit = (git -C DSH-better-sidebar rev-parse --verify HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0) { throw 'Failed to resolve the Better Sidebar HEAD' }
if ($ResolvedBetterSidebarCommit -ne $BetterSidebarCommit) { throw "Better Sidebar commit mismatch: expected $BetterSidebarCommit, got $ResolvedBetterSidebarCommit" }
$BetterSidebarHeadRef = git -C DSH-better-sidebar symbolic-ref -q HEAD
if ($LASTEXITCODE -eq 0) { throw "Better Sidebar must use detached HEAD, currently $BetterSidebarHeadRef" }
if ($LASTEXITCODE -ne 1) { throw 'Failed to verify the Better Sidebar detached HEAD' }
$BetterSidebarWorktreeState = git -C DSH-better-sidebar status --porcelain=v1 --untracked-files=all
if ($LASTEXITCODE -ne 0) { throw 'Failed to verify the Better Sidebar worktree' }
if ($BetterSidebarWorktreeState) { throw 'Better Sidebar worktree is not clean' }
# BETTER-SIDEBAR-SOURCE-VERIFIED-BEFORE-REPOSITORY-CODE
```

# BETTER-SIDEBAR-INSTRUCTIONS-AFTER-SOURCE-VERIFICATION

After that verification succeeds:

1. Build the verified Better Sidebar checkout using its reviewed local instructions.
2. Install that local fork into the same profile.
3. Install `dsh-workbench/dist/wanyexin1998-dsh-workbench-panel-compat-0.1.0-rc.1.tgz`.

The compatibility package does not download, install, update, or remove Better Sidebar. Stock Better Sidebar without Pane protocol 1 remains on its original global path.

## 5. Verify

- Ctrl/Command-click a listed Session opens it beside the focused Pane.
- Ordinary click replaces the focused Pane.
- Both Panes preserve independent drafts, scroll state, Navigator, and optional panels.
- Refresh restores one Pane; multi-Pane membership is process-local by design.
