# Installation

Workbench does not automatically install third-party plugins. This page has
two paths: **Quick Install** (default) downloads immutable, hash-verified
Release artifacts; **Advanced: source build** keeps the original
commit-verification ceremony for anyone who wants to build and verify every
byte themselves.

<!--
  CONTRACT-CHECK CONSTRAINT — read before editing Quick Install below.
  scripts/release-contract-check.mjs enforces two whole-document invariants
  against this file:
    1. hasNoRepositoryExecutionBefore() scans every line inside a fenced
       code block tagged with the `powershell` language (never a plain,
       untagged fence), counting from the top of this document up to the
       two SOURCE-VERIFIED-BEFORE-REPOSITORY-CODE markers used later in
       Advanced: source build (one for Workbench, one for Harness), and
       fails if any such line starts with one of a short list of tokens
       (`pnpm`, `npm`, `node`, `dsh`, `pwsh`, `&`, ...).
    2. A separate whole-document check requires the first place the four
       letters `pnpm` are immediately followed by a space anywhere in this
       file to land after both of those markers.
  Quick Install therefore deliberately (a) leaves every command block in
  this section untagged — never the `powershell` language tag — and (b)
  always writes `pnpm` with a trailing punctuation mark or backtick right
  after it (`pnpm@11`, `pnpm`'s, `pnpm`-managed) rather than a bare
  trailing space, in every sentence and command here. Breaking either habit
  makes an otherwise-correct edit fail `release:check` even though the
  content itself is correct. Widening these checks to be marker-relative
  instead of whole-document is tracked as an A6 follow-up, not fixed here.
-->

## Quick Install (default)

Two independent paths, matching what your Harness supports. Both start from
an immutable, hash-verified GitHub Release artifact rather than source.

> **Availability:** this path ships with the `v0.2.0-rc.2` GitHub Release,
> which has not been published yet — `release-contract.json` still reports
> `0.2.0-rc.1` / `source-preview` today (no signed Release, no TGZ asset).
> Until `v0.2.0-rc.2` ships, use [Advanced: source build](#advanced-source-build)
> below, which works today.

### (a) General plugin — stock Harness

Works on any stock Harness install. You get Navigator, shortcuts, and every
capability that does not need multi-Session Presentation. Split Pane stays
inactive — the official interface it needs (`sessions.presentation` protocol
2) is not part of stock Harness yet; it is an open proposal, tracked at
[discussion #4718](https://github.com/deepseek-ai/deepseek-harness/discussions/4718).
This is not an install failure, and nothing else is affected.

Three steps, always in this order: download the Workbench release TGZ →
verify its SHA256 against the Release's `SHA256SUMS` → install with
`dsh plugin --profile web add file:<absolute path>`. A `file:` spec with an
absolute path is used rather than a package name because Workbench is not
published to npm (see `plans/260827-workbench-v2/reports/T0.3-dsh-plugin-add.md`
for why `file:` is the right spec shape here).

**Windows (PowerShell 7+ / `pwsh`):**

```
& {
$ErrorActionPreference = 'Stop'
$rel = 'https://github.com/wanyexin1998/dsh-workbench/releases/download/v0.2.0-rc.2'
$tgz = 'wanyexin1998-dsh-workbench-0.2.0-rc.2.tgz'
try {
  Invoke-WebRequest "$rel/$tgz" -OutFile $tgz
  Invoke-WebRequest "$rel/SHA256SUMS" -OutFile SHA256SUMS
} catch {
  throw "Download failed, aborting (no install performed): $_"
}
$expectedLine = (Select-String -Path SHA256SUMS -Pattern ([regex]::Escape($tgz) + '$')).Line
if (-not $expectedLine) { throw 'SHA256 verification failed, aborting (no install performed): SHA256SUMS has no entry for the downloaded TGZ' }
$expected = ($expectedLine -split '\s+')[0].ToLower()
if ($expected -notmatch '^[0-9a-f]{64}$') { throw "SHA256 verification failed, aborting (no install performed): SHA256SUMS hash is not well-formed: $expected" }
$actual = (Get-FileHash $tgz -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "SHA256 verification failed, aborting (no install performed): expected $expected, got $actual" }
dsh plugin --profile web add "file:$PWD\$tgz"
}
```

**macOS (Terminal):**

```
rel='https://github.com/wanyexin1998/dsh-workbench/releases/download/v0.2.0-rc.2'
tgz='wanyexin1998-dsh-workbench-0.2.0-rc.2.tgz'
if curl -fsSLO "$rel/$tgz" && curl -fsSLO "$rel/SHA256SUMS"; then
  expected=$(grep 'wanyexin1998-dsh-workbench-0\.2\.0-rc\.2\.tgz$' SHA256SUMS | awk '{print $1}')
  actual=$(shasum -a 256 "$tgz" | awk '{print $1}')
  if [ -n "$expected" ] && printf '%s' "$expected" | grep -qE '^[0-9a-f]{64}$' && [ "$actual" = "$expected" ]; then
    dsh plugin --profile web add "file:$PWD/$tgz"
  else
    echo 'SHA256 verification failed, aborting (no install performed)' >&2
    false
  fi
else
  echo 'Download failed, aborting (no install performed)' >&2
  false
fi
```

#### Documented completion message

After this install succeeds, the agent reports exactly the sample for the
user's platform below — never both to the same user. Each sample is a
complete, independent script with exactly one command, so a copy always
grabs exactly one command. The two Chinese samples are quoted verbatim from
`plans/260827-workbench-v2/tasks.md` §1 (normative there — do not reword
them). The English samples are this document's own faithful translation,
preserving the same five required elements: (1) Split Pane is inactive and
why, and this is not an install failure; (2) everything else works now; (3)
the bootstrap coexists with the official install with zero changes to it,
its configuration, or session data; (4) it is fully deletable with no
residue; (5) the command is singular and directly copy-paste ready.

**Windows — Chinese (verbatim from tasks.md §1):**

````text
✅ DSH Workbench 已安装完成。Navigator、快捷键等通用功能现在就可以使用。

ℹ️ 分屏（双 Pane）功能当前未激活：你的官方 Harness 还不支持多 Pane 所需的
接口（该接口已作为提案提交官方，进展见
https://github.com/deepseek-ai/deepseek-harness/discussions/4718）。
这不是安装出错，其余功能不受影响。

如果你现在就想用分屏，可以运行下面这一条命令。它会在独立目录里构建一份带补丁的
Harness 副本，与你的官方版并存——不会改动官方安装、配置或任何会话数据；不想要时
删除该目录即可，官方 Harness 不受任何影响：

Windows（需要 PowerShell 7+，即 `pwsh`）：

```
& { $ErrorActionPreference = 'Stop'; $rel = 'https://github.com/wanyexin1998/dsh-workbench/releases/download/v0.2.0-rc.2'; Invoke-WebRequest "$rel/dsh-workbench-bootstrap.ps1" -OutFile dsh-workbench-bootstrap.ps1; Invoke-WebRequest "$rel/SHA256SUMS" -OutFile SHA256SUMS; $expectedLine = (Select-String -Path SHA256SUMS -Pattern 'dsh-workbench-bootstrap\.ps1$').Line; if (-not $expectedLine) { throw 'SHA256SUMS 中未找到 dsh-workbench-bootstrap.ps1 的记录，已中止' }; $expected = ($expectedLine -split '\s+')[0].ToLower(); if ($expected -notmatch '^[0-9a-f]{64}$') { throw "SHA256SUMS 中的哈希格式不合法：$expected" }; $actual = (Get-FileHash dsh-workbench-bootstrap.ps1 -Algorithm SHA256).Hash.ToLower(); if ($actual -ne $expected) { throw "SHA256 校验失败：期望 $expected，实际 $actual" }; pwsh -NoProfile -ExecutionPolicy Bypass -File .\dsh-workbench-bootstrap.ps1 }
```
````

**Windows — English (translation):**

````text
✅ DSH Workbench is installed. Navigator, shortcuts, and the rest of the
general-purpose functionality work now.

ℹ️ Split Pane (dual Pane) is not active yet: your official Harness does not
yet expose the interface multi-Pane needs (this has been filed as a proposal
upstream; track it at
https://github.com/deepseek-ai/deepseek-harness/discussions/4718).
This is not an install error — everything else is unaffected.

If you want Split Pane right now, you can run the single command below. It
builds a patched copy of Harness in an isolated directory, side by side with
your official install — it changes nothing about your official install, its
configuration, or any session data. Delete that directory whenever you no
longer want it; your official Harness is left completely untouched:

Windows (requires PowerShell 7+, i.e. `pwsh`):

```
& { $ErrorActionPreference = 'Stop'; $rel = 'https://github.com/wanyexin1998/dsh-workbench/releases/download/v0.2.0-rc.2'; Invoke-WebRequest "$rel/dsh-workbench-bootstrap.ps1" -OutFile dsh-workbench-bootstrap.ps1; Invoke-WebRequest "$rel/SHA256SUMS" -OutFile SHA256SUMS; $expectedLine = (Select-String -Path SHA256SUMS -Pattern 'dsh-workbench-bootstrap\.ps1$').Line; if (-not $expectedLine) { throw 'SHA256SUMS 中未找到 dsh-workbench-bootstrap.ps1 的记录，已中止' }; $expected = ($expectedLine -split '\s+')[0].ToLower(); if ($expected -notmatch '^[0-9a-f]{64}$') { throw "SHA256SUMS 中的哈希格式不合法：$expected" }; $actual = (Get-FileHash dsh-workbench-bootstrap.ps1 -Algorithm SHA256).Hash.ToLower(); if ($actual -ne $expected) { throw "SHA256 校验失败：期望 $expected，实际 $actual" }; pwsh -NoProfile -ExecutionPolicy Bypass -File .\dsh-workbench-bootstrap.ps1 }
```
````

The command embedded above is byte-identical to the normative Chinese sample (this is a translation of the surrounding message text only), so its own failure messages (`SHA256SUMS 中未找到...`, `SHA256 校验失败：...`) are still Chinese. An English variant of the normative §1 command itself is tracked as follow-up work for the release task; the command is not altered here.

**macOS — Chinese (verbatim from tasks.md §1):**

````text
✅ DSH Workbench 已安装完成。Navigator、快捷键等通用功能现在就可以使用。

ℹ️ 分屏（双 Pane）功能当前未激活：你的官方 Harness 还不支持多 Pane 所需的
接口（该接口已作为提案提交官方，进展见
https://github.com/deepseek-ai/deepseek-harness/discussions/4718）。
这不是安装出错，其余功能不受影响。

如果你现在就想用分屏，可以运行下面这一条命令。它会在独立目录里构建一份带补丁的
Harness 副本，与你的官方版并存——不会改动官方安装、配置或任何会话数据；不想要时
删除该目录即可，官方 Harness 不受任何影响：

macOS（Terminal）：

```
rel='https://github.com/wanyexin1998/dsh-workbench/releases/download/v0.2.0-rc.2'; if curl -fsSLO "$rel/dsh-workbench-bootstrap.sh" && curl -fsSLO "$rel/SHA256SUMS"; then expected=$(grep 'dsh-workbench-bootstrap\.sh$' SHA256SUMS | awk '{print $1}'); actual=$(shasum -a 256 dsh-workbench-bootstrap.sh | awk '{print $1}'); if [ -n "$expected" ] && printf '%s' "$expected" | grep -qE '^[0-9a-f]{64}$' && [ "$actual" = "$expected" ]; then chmod +x dsh-workbench-bootstrap.sh && ./dsh-workbench-bootstrap.sh; else echo 'SHA256 校验失败，已中止，不会执行未校验脚本' >&2; false; fi; else echo '下载失败，已中止，不会执行未校验脚本' >&2; false; fi
```
````

**macOS — English (translation):**

````text
✅ DSH Workbench is installed. Navigator, shortcuts, and the rest of the
general-purpose functionality work now.

ℹ️ Split Pane (dual Pane) is not active yet: your official Harness does not
yet expose the interface multi-Pane needs (this has been filed as a proposal
upstream; track it at
https://github.com/deepseek-ai/deepseek-harness/discussions/4718).
This is not an install error — everything else is unaffected.

If you want Split Pane right now, you can run the single command below. It
builds a patched copy of Harness in an isolated directory, side by side with
your official install — it changes nothing about your official install, its
configuration, or any session data. Delete that directory whenever you no
longer want it; your official Harness is left completely untouched:

macOS (Terminal):

```
rel='https://github.com/wanyexin1998/dsh-workbench/releases/download/v0.2.0-rc.2'; if curl -fsSLO "$rel/dsh-workbench-bootstrap.sh" && curl -fsSLO "$rel/SHA256SUMS"; then expected=$(grep 'dsh-workbench-bootstrap\.sh$' SHA256SUMS | awk '{print $1}'); actual=$(shasum -a 256 dsh-workbench-bootstrap.sh | awk '{print $1}'); if [ -n "$expected" ] && printf '%s' "$expected" | grep -qE '^[0-9a-f]{64}$' && [ "$actual" = "$expected" ]; then chmod +x dsh-workbench-bootstrap.sh && ./dsh-workbench-bootstrap.sh; else echo 'SHA256 校验失败，已中止，不会执行未校验脚本' >&2; false; fi; else echo '下载失败，已中止，不会执行未校验脚本' >&2; false; fi
```
````

The command embedded above is byte-identical to the normative Chinese sample (this is a translation of the surrounding message text only), so its own failure messages (`SHA256 校验失败...`, `下载失败...`) are still Chinese. An English variant of the normative §1 command itself is tracked as follow-up work for the release task; the command is not altered here.

### (b) Split pane (bootstrap)

If you want Split Pane right now, this is the supported path: it builds a
patched Harness fork in an isolated directory, side by side with your
official install. It never touches your official install. These are the
same two commands embedded in the completion message above — running them
directly here works identically.

**Windows (PowerShell 7+ / `pwsh`):**

```
& { $ErrorActionPreference = 'Stop'; $rel = 'https://github.com/wanyexin1998/dsh-workbench/releases/download/v0.2.0-rc.2'; Invoke-WebRequest "$rel/dsh-workbench-bootstrap.ps1" -OutFile dsh-workbench-bootstrap.ps1; Invoke-WebRequest "$rel/SHA256SUMS" -OutFile SHA256SUMS; $expectedLine = (Select-String -Path SHA256SUMS -Pattern 'dsh-workbench-bootstrap\.ps1$').Line; if (-not $expectedLine) { throw 'SHA256SUMS 中未找到 dsh-workbench-bootstrap.ps1 的记录，已中止' }; $expected = ($expectedLine -split '\s+')[0].ToLower(); if ($expected -notmatch '^[0-9a-f]{64}$') { throw "SHA256SUMS 中的哈希格式不合法：$expected" }; $actual = (Get-FileHash dsh-workbench-bootstrap.ps1 -Algorithm SHA256).Hash.ToLower(); if ($actual -ne $expected) { throw "SHA256 校验失败：期望 $expected，实际 $actual" }; pwsh -NoProfile -ExecutionPolicy Bypass -File .\dsh-workbench-bootstrap.ps1 }
```

**macOS (Terminal):**

```
rel='https://github.com/wanyexin1998/dsh-workbench/releases/download/v0.2.0-rc.2'; if curl -fsSLO "$rel/dsh-workbench-bootstrap.sh" && curl -fsSLO "$rel/SHA256SUMS"; then expected=$(grep 'dsh-workbench-bootstrap\.sh$' SHA256SUMS | awk '{print $1}'); actual=$(shasum -a 256 dsh-workbench-bootstrap.sh | awk '{print $1}'); if [ -n "$expected" ] && printf '%s' "$expected" | grep -qE '^[0-9a-f]{64}$' && [ "$actual" = "$expected" ]; then chmod +x dsh-workbench-bootstrap.sh && ./dsh-workbench-bootstrap.sh; else echo 'SHA256 校验失败，已中止，不会执行未校验脚本' >&2; false; fi; else echo '下载失败，已中止，不会执行未校验脚本' >&2; false; fi
```

Both commands omit `--target`/`-Target` and use the script's built-in
default directory (Windows: `%USERPROFILE%\dsh-workbench`; macOS:
`$HOME/dsh-workbench`).

What the script does:

- Everything it writes lives under one root, `<target>` — the Harness fork
  checkout, an isolated `DSH_HOME`, downloaded artifacts, and a launcher.
- It writes nothing to your official Harness install, `PATH`, a shell
  profile, or the registry, apart from `pnpm`'s own global package
  store/cache — that store is `pnpm`-managed outside `<target>` regardless
  of what invokes it.
- Deleting `<target>` removes everything the script itself ever wrote.
- The script always ends by printing exactly one JSON line
  (`{ schema, state, reason, nextStep, details }`, `state` one of
  `installed | manual-action-required | incompatible | failed`) and exits
  with the matching process code (`0 / 2 / 3 / 1`). See the header comments
  in `scripts/bootstrap/dsh-workbench-bootstrap.ps1` / `.sh` for the full
  contract.

Requirements:

- Node.js `^22.19` or `>=24`
- `pnpm@11`
- `git`
- PowerShell 7+ (`pwsh`) on Windows; macOS runs the script directly under
  its Terminal `bash`.

Honest note on the hashes: the real SHA256 values in `SHA256SUMS` are
written when `v0.2.0-rc.2` is attached to a GitHub Release. Until then, this
command template is final and will not change, but there is no published
artifact yet for the download/verify step to check against.

## Advanced: source build

This is the original full-audit path: approve a full 40-character commit
through an independent trusted channel, clone with `--no-checkout`, verify a
detached HEAD and a clean worktree before running any repository code, then
build from source yourself. It remains valid indefinitely for anyone who
wants to verify every byte themselves; it is simply no longer the default
now that immutable Release artifacts exist (see Quick Install above).

### 1. Verify the Workbench source

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

### 2. Verify and build the Harness fork

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

### 3. Build Workbench artifacts

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

The Split Pane module fails closed unless Harness exposes `sessions.presentation` with `protocol === 2` *and* passes a structural probe of the actual interface shape it needs — a `requestCapacity` function and a `state.getSnapshot()` that returns `{ visible: Array, capacity: number }` without throwing. A matching protocol number alone is not accepted as proof (see `packages/dsh-workbench/src/client/guard.ts`).

### 4. Optional Pane panels

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

### 5. Verify

- Ctrl/Command-click a listed Session opens it beside the focused Pane.
- Ordinary click replaces the focused Pane.
- Both Panes preserve independent drafts, scroll state, Navigator, and optional panels.
- Refresh restores one Pane; multi-Pane membership is process-local by design.

