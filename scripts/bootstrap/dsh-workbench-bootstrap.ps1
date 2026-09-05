<#
.SYNOPSIS
  DSH Workbench source-bootstrap installer (Windows).

.DESCRIPTION
  Automates docs/INSTALL.md §1-3 (A3, plans/260827-workbench-v2/tasks.md §3):
  downloads (or accepts a pre-downloaded) Workbench release TGZ, clones and
  verifies the pinned Harness fork by exact commit (never a mutable
  branch/tag), builds it, verifies and installs the TGZ into an ISOLATED
  profile, runs a post-install load verification, and writes a launcher.

  ISOLATION INVARIANT (by construction): every path this script writes is
  derived from a single root, -Target. It never touches the official ~/.dsh
  (or %USERPROFILE%\.dsh) install, PATH, a shell profile, or the registry --
  apart from pnpm's own global package store/cache, which pnpm manages
  outside -Target regardless of what invokes it (this script does not
  configure or rely on that store's location). Deleting -Target removes
  everything this script itself ever wrote.

  TRUST MODEL: the Harness fork's repository URL and branch name below are
  informational only. The only thing this script ever trusts is the exact
  40-character commit hash pinned as a constant — it is never resolved from
  a branch or tag, and every git step that could silently diverge from it
  (clone, checkout, HEAD verification, detached-HEAD proof, clean-worktree
  check) aborts the whole run immediately on any failure (fail closed). The
  Workbench release TGZ (whether downloaded by this script or supplied via
  -Tgz) is likewise never used before its SHA256 has been verified.

.PARAMETER Target
  Root install directory. Everything this script writes lives under here.
  Default: %USERPROFILE%\dsh-workbench

.PARAMETER Tgz
  OFFLINE OVERRIDE: path to an already-downloaded Workbench release TGZ.
  When omitted (the default), this script downloads the pinned-version TGZ
  itself from the embedded $ReleaseBaseUrl into -Target\downloads\. Either
  way, the TGZ is hash-verified before any use.

.PARAMETER TgzSha256
  Expected SHA256 of the TGZ, as 64 lowercase hex characters. Required only
  when the embedded $WorkbenchTgzSha256 constant below is still the
  STAMPED-AT-RELEASE placeholder (i.e. before this script has been attached
  to a GitHub Release with its real hash stamped in).

.PARAMETER CheckOnly
  Run Phase 0 preconditions and the embedded-pin self-consistency check,
  print the planned actions, and stop — no network access, no writes. This
  is the locally testable mode.

.OUTPUTS
  The LAST line written to stdout is always exactly one JSON object shaped
  like scripts/install/result.mjs's InstallResult contract:
    { schema: 1, state, reason, nextStep, details }
  where state is one of: installed | manual-action-required | incompatible | failed.

  Process exit code contract (not part of result.mjs; this script's own,
  documented mapping from state to exit code, for shell/CI use):
    installed              -> 0
    manual-action-required -> 2
    incompatible            -> 3  (reserved; no current code path emits it)
    failed                  -> 1

  ARGUMENT-PARSING PARITY NOTE (B4): a bare trailing flag with no value
  (e.g. `-TgzSha256` with nothing after it) errors loudly here too, but NOT
  through the JSON contract above -- PowerShell's own typed-parameter
  binder rejects a missing argument value before this script's body ever
  runs, printing its own diagnostic to stderr and exiting nonzero. The
  `.sh` sibling instead guards every two-arg flag explicitly and always
  exits promptly with a `failed` JSON. This is intentional platform
  behavior, not a gap to fix: either way the exit code is nonzero and the
  process returns promptly (never hangs), which is what a caller scripting
  around either tool needs to check regardless of stdout shape.

  A flag that IS given a value, on the other hand, always leaves through
  the JSON contract here. A -Target value that cannot be normalized into a
  path at all -- an empty or whitespace-only string, and whatever else the
  host runtime's GetFullPath rejects -- yields a `failed` result naming the
  problem, never a raw exception. (What GetFullPath rejects is runtime
  dependent and deliberately not enumerated here: on .NET 8 neither
  `C:\bad|path` nor a 400-character path throws, and both simply continue
  into the run, failing later through the contract like any other bad
  directory.) The `.sh` sibling differs on the empty value: `--target ''`
  falls back to its default root ($HOME/dsh-workbench) exactly as if
  --target had been omitted, whereas this script reports it rather than
  silently installing into a root the caller did not name. Both stay inside
  the contract; only the chosen terminal state differs.
#>

[CmdletBinding()]
param(
    [string]$Target = (Join-Path $env:USERPROFILE 'dsh-workbench'),
    [string]$Tgz,
    [string]$TgzSha256,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# N3: immunize against a user PowerShell profile that has changed this
# preference globally -- without it, a native command (git, pnpm, curl, ...)
# returning a nonzero exit code could itself become a terminating error
# depending on the caller's profile, which would short-circuit our own
# $LASTEXITCODE-based error handling below in surprising ways. This
# automatic variable only exists on PowerShell 7.3+; assigning it on an
# older host is a harmless no-op (just an unused variable).
$PSNativeCommandUseErrorActionPreference = $false

# --- Pinned constants (embedded; NEVER fetched from a mutable ref) ---------
#
# These mirror release-contract.json's `harness` block and docs/INSTALL.md
# §2. Keep them in sync with release-contract.json by hand; this script does
# not read that file at run time (it must stay fully self-contained once
# attached to an immutable GitHub Release).
$HarnessRepoUrl = 'https://github.com/wanyexin1998/deepseek-harness.git'
# Informational only — see the TRUST MODEL note above. Never used to select
# what gets checked out; only the pinned commit below is.
$HarnessForkBranch = 'feat/toggle-settings-verb'
$HarnessCommit = '82de604afc683cd8c7692d0736f26f9ebc0f1823'
# The upstream DeepSeek Harness commit the fork branch is based on
# (release-contract.json harness.upstreamCommit). Recorded here only for
# the self-consistency check and diagnostic output; never checked out.
$HarnessUpstreamBaseCommit = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
$WorkbenchVersion = '0.2.0-rc.3'
$WorkbenchTgzFilename = "wanyexin1998-dsh-workbench-$WorkbenchVersion.tgz"
# Base URL for this script's own default TGZ download (B1): the GitHub
# Release this script itself is attached to as an asset. Kept as its own
# constant (rather than derived purely from $WorkbenchVersion) so the
# self-consistency check below can catch a hand-edit that changes one but
# not the other.
$ReleaseBaseUrl = 'https://github.com/wanyexin1998/dsh-workbench/releases/download/v0.2.0-rc.3'
# STAMPED-AT-RELEASE: placeholder. Replaced with the real lowercase 64-hex
# SHA256 of the release TGZ when this script is attached to the GitHub
# Release (see plans/260827-workbench-v2/tasks.md §8). While this constant
# still holds the placeholder, a real run REQUIRES -TgzSha256 on the command
# line and refuses to install (or even download) an unverified artifact
# otherwise.
$WorkbenchTgzSha256 = '974716952ac8ac406a3e8fa2af59db722fe1c0c6e20ccc321356d1b0754da6c7'
$ResultSchema = 1

# NOTE: -Target normalization and the write paths derived from it are NOT
# done here. They live at the top of the main try block below, after
# Complete-Result exists, so that a malformed -Target still leaves through
# the JSON contract instead of killing the process with a raw exception.

$ExitCodeForState = @{
    'installed'               = 0
    'manual-action-required'  = 2
    'incompatible'            = 3
    'failed'                  = 1
}

function Complete-Result {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('installed', 'manual-action-required', 'incompatible', 'failed')]
        [string]$State,
        [Parameter(Mandatory)][string]$Reason,
        [string]$NextStep,
        $Details,
        [string]$HumanBlock
    )

    if (($State -eq 'manual-action-required' -or $State -eq 'failed') -and [string]::IsNullOrWhiteSpace($NextStep)) {
        # Internal contract bug, not a user-facing outcome: every call site
        # for these two states must supply NextStep. Fail loudly rather than
        # emit a result.mjs-noncompliant JSON line.
        throw "internal error: Complete-Result state '$State' requires a non-empty -NextStep"
    }

    if ($HumanBlock) {
        Write-Output $HumanBlock
        Write-Output ''
    }

    $resultObject = [ordered]@{
        schema   = $ResultSchema
        state    = $State
        reason   = $Reason
        nextStep = if ($NextStep) { $NextStep } else { $null }
        details  = $Details
    }
    # -Compress: the contract requires the JSON to be exactly one stdout
    # line, and it must be the LAST line this script ever writes.
    $json = $resultObject | ConvertTo-Json -Depth 10 -Compress
    Write-Output $json
    exit $ExitCodeForState[$State]
}

function Get-ToolVersionString {
    param([string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $cmd) { return $null }
    try {
        $output = & $Name --version 2>$null
        if ($null -eq $output) { return $null }
        return ($output | Select-Object -First 1).ToString().Trim()
    } catch {
        return $null
    }
}

function Test-Preconditions {
    # Node.js ^22.19 || >=24
    $nodeVersionRaw = Get-ToolVersionString -Name 'node'
    if ($null -eq $nodeVersionRaw) {
        Complete-Result -State 'failed' `
            -Reason 'Node.js was not found on PATH.' `
            -NextStep 'Install Node.js ^22.19 or >=24 (https://nodejs.org/), then re-run this script.'
    }
    $nodeMatch = [regex]::Match($nodeVersionRaw, '(\d+)\.(\d+)\.(\d+)')
    if (-not $nodeMatch.Success) {
        Complete-Result -State 'failed' `
            -Reason "Could not parse a Node.js version number from: $nodeVersionRaw" `
            -NextStep 'Ensure `node --version` prints a standard vMAJOR.MINOR.PATCH string, then re-run this script.'
    }
    $nodeMajor = [int]$nodeMatch.Groups[1].Value
    $nodeMinor = [int]$nodeMatch.Groups[2].Value
    $nodeCompatible = $false
    if ($nodeMajor -eq 22 -and $nodeMinor -ge 19) { $nodeCompatible = $true }
    if ($nodeMajor -ge 24) { $nodeCompatible = $true }
    if (-not $nodeCompatible) {
        Complete-Result -State 'failed' `
            -Reason "Node.js $nodeVersionRaw does not satisfy the required range (^22.19 || >=24)." `
            -NextStep 'Install Node.js ^22.19 or >=24 (https://nodejs.org/), then re-run this script.'
    }

    # pnpm 11
    $pnpmVersionRaw = Get-ToolVersionString -Name 'pnpm'
    if ($null -eq $pnpmVersionRaw) {
        Complete-Result -State 'failed' `
            -Reason 'pnpm was not found on PATH.' `
            -NextStep 'Install pnpm 11 (e.g. `corepack enable` then `corepack prepare pnpm@11 --activate`), then re-run this script.'
    }
    $pnpmMatch = [regex]::Match($pnpmVersionRaw, '^(\d+)\.')
    if (-not $pnpmMatch.Success -or [int]$pnpmMatch.Groups[1].Value -ne 11) {
        Complete-Result -State 'failed' `
            -Reason "pnpm $pnpmVersionRaw does not satisfy the required major version (11)." `
            -NextStep 'Install pnpm 11 (e.g. `corepack enable` then `corepack prepare pnpm@11 --activate`), then re-run this script.'
    }

    # git present
    $gitCmd = Get-Command 'git' -ErrorAction SilentlyContinue
    if ($null -eq $gitCmd) {
        Complete-Result -State 'failed' `
            -Reason 'git was not found on PATH.' `
            -NextStep 'Install Git for Windows (https://git-scm.com/download/win), then re-run this script.'
    }
}

function Test-PinSelfConsistency {
    # Defends against a corrupted or hand-edited copy of this immutable
    # release asset silently doing the wrong thing.
    $problems = New-Object System.Collections.Generic.List[string]
    if ($HarnessCommit -notmatch '^[0-9a-f]{40}$') {
        $problems.Add('the embedded Harness commit is not a lowercase 40-hex-character hash')
    }
    if ($HarnessUpstreamBaseCommit -notmatch '^[0-9a-f]{40}$') {
        $problems.Add('the embedded Harness upstream base commit is not a lowercase 40-hex-character hash')
    }
    $expectedTgzPattern = '^wanyexin1998-dsh-workbench-' + [regex]::Escape($WorkbenchVersion) + '\.tgz$'
    if ($WorkbenchTgzFilename -notmatch $expectedTgzPattern) {
        $problems.Add('the embedded Workbench TGZ filename does not match the embedded Workbench version')
    }
    $expectedReleaseBase = 'https://github.com/wanyexin1998/dsh-workbench/releases/download/v' + $WorkbenchVersion
    if ($ReleaseBaseUrl -ne $expectedReleaseBase) {
        $problems.Add('the embedded ReleaseBaseUrl does not match the embedded Workbench version')
    }
    if ($WorkbenchTgzSha256 -ne 'STAMPED-AT-RELEASE' -and $WorkbenchTgzSha256 -notmatch '^[0-9a-f]{64}$') {
        $problems.Add('the embedded Workbench TGZ SHA256 is neither the STAMPED-AT-RELEASE placeholder nor a lowercase 64-hex SHA256 hash')
    }
    if ($problems.Count -gt 0) {
        Complete-Result -State 'failed' `
            -Reason ('Embedded pin self-consistency check failed: ' + ($problems -join '; ') + '.') `
            -NextStep 'Do not trust this copy of the script. Re-download it from the official GitHub Release page and verify it against the published SHA256SUMS before running it again.'
    }
}

function Get-PlannedActionsText {
    if ($Tgz) {
        $tgzSourceBlock = "Use the already-downloaded TGZ at:`n       $Tgz`n     (offline -Tgz override; no download)."
    } else {
        $tgzSourceBlock = "Download the Workbench release TGZ ($WorkbenchTgzFilename) from:`n       $ReleaseBaseUrl`n     into:`n       $DownloadsDir"
    }
    @"
Planned actions for a full run (this --check-only run performed NONE of
these: no network access, no writes):
  1. $tgzSourceBlock
     Verify it against its SHA256 before any use (either path).
  2. Clone $HarnessRepoUrl
     (branch '$HarnessForkBranch' is informational only; the actual checkout
     is pinned to commit $HarnessCommit, detached, verified) into:
       $HarnessCheckoutDir
  3. Run 'pnpm install --frozen-lockfile' then 'pnpm build' inside that checkout.
  4. Install the verified TGZ, with DSH_HOME scoped to that one child process only:
       DSH_HOME=$DshHomeDir  pnpm dsh plugin --profile web add file:<verified-tgz-path>
  5. Post-install load verification (no boot), same DSH_HOME scoping:
       DSH_HOME=$DshHomeDir  pnpm dsh --profile web --dump-config
     and confirm the Workbench package name appears in its output before
     declaring success.
  6. Write an isolated launcher at:
       $LauncherPath

Isolation: every path above is derived from -Target ($Target), apart from
pnpm's own global package store/cache, which pnpm manages outside -Target.
Nothing else outside -Target is ever written to — no ~\.dsh, no PATH, no
shell profile, no registry key.
"@
}

function Invoke-Phase1AcquireFork {
    if (Test-Path -LiteralPath $HarnessCheckoutDir) {
        Complete-Result -State 'failed' `
            -Reason "Target checkout directory already exists: $HarnessCheckoutDir. Refusing to overwrite an existing directory (fail closed)." `
            -NextStep "Remove or rename $HarnessCheckoutDir, or choose a different -Target, then re-run this script."
    }

    New-Item -ItemType Directory -Force -Path $Target | Out-Null

    & git clone --no-checkout $HarnessRepoUrl $HarnessCheckoutDir
    if ($LASTEXITCODE -ne 0) {
        Complete-Result -State 'failed' `
            -Reason 'git clone of the Harness fork failed.' `
            -NextStep "Check your network connection and that $HarnessRepoUrl is reachable, then re-run this script."
    }

    & git -C $HarnessCheckoutDir checkout --detach $HarnessCommit
    if ($LASTEXITCODE -ne 0) {
        Complete-Result -State 'failed' `
            -Reason "git checkout --detach $HarnessCommit failed." `
            -NextStep "Delete $HarnessCheckoutDir and re-run this script."
    }

    $resolvedCommit = (& git -C $HarnessCheckoutDir rev-parse --verify HEAD)
    if ($LASTEXITCODE -ne 0) {
        Complete-Result -State 'failed' `
            -Reason 'Failed to resolve the Harness fork HEAD.' `
            -NextStep "Delete $HarnessCheckoutDir and re-run this script."
    }
    $resolvedCommit = $resolvedCommit.Trim().ToLowerInvariant()
    if ($resolvedCommit -ne $HarnessCommit.ToLowerInvariant()) {
        Complete-Result -State 'failed' `
            -Reason "Harness commit mismatch: expected $HarnessCommit, got $resolvedCommit." `
            -NextStep "Delete $HarnessCheckoutDir and re-run this script. If the mismatch persists, do not proceed -- report this to the maintainer."
    }

    & git -C $HarnessCheckoutDir symbolic-ref -q HEAD *> $null
    $symbolicRefExitCode = $LASTEXITCODE
    if ($symbolicRefExitCode -eq 0) {
        Complete-Result -State 'failed' `
            -Reason 'Harness fork checkout is not in detached HEAD state.' `
            -NextStep "Delete $HarnessCheckoutDir and re-run this script."
    } elseif ($symbolicRefExitCode -ne 1) {
        Complete-Result -State 'failed' `
            -Reason "Failed to verify the Harness fork's detached-HEAD state (unexpected git exit code $symbolicRefExitCode)." `
            -NextStep "Delete $HarnessCheckoutDir and re-run this script."
    }

    $worktreeState = (& git -C $HarnessCheckoutDir status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0) {
        Complete-Result -State 'failed' `
            -Reason 'Failed to verify the Harness fork worktree state.' `
            -NextStep "Delete $HarnessCheckoutDir and re-run this script."
    }
    if ($worktreeState) {
        Complete-Result -State 'failed' `
            -Reason 'Harness fork worktree is not clean immediately after checkout.' `
            -NextStep "Delete $HarnessCheckoutDir and re-run this script."
    }
}

function Invoke-Phase2BuildFork {
    Push-Location -LiteralPath $HarnessCheckoutDir

    & pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
        Complete-Result -State 'failed' `
            -Reason 'pnpm install --frozen-lockfile failed inside the Harness fork checkout.' `
            -NextStep "Re-run this script from a clean -Target, or run 'pnpm install --frozen-lockfile' manually inside $HarnessCheckoutDir to see the underlying error."
    }

    & pnpm build
    if ($LASTEXITCODE -ne 0) {
        Complete-Result -State 'failed' `
            -Reason 'pnpm build failed inside the Harness fork checkout.' `
            -NextStep "Re-run this script from a clean -Target, or run 'pnpm build' manually inside $HarnessCheckoutDir to see the underlying error."
    }

    Pop-Location
}

function Invoke-Phase3InstallTgz {
    param([string]$AbsTgzPath)

    New-Item -ItemType Directory -Force -Path $DshHomeDir | Out-Null
    Push-Location -LiteralPath $HarnessCheckoutDir

    $previousDshHome = $env:DSH_HOME
    try {
        # Scoped to this one child process: restored in `finally` below no
        # matter what, so this script never leaves DSH_HOME set for anything
        # after this call, including itself if further phases ran.
        $env:DSH_HOME = $DshHomeDir
        & pnpm dsh plugin --profile web add "file:$AbsTgzPath"
        $installExitCode = $LASTEXITCODE
    } finally {
        $env:DSH_HOME = $previousDshHome
    }

    if ($installExitCode -ne 0) {
        Pop-Location
        Complete-Result -State 'failed' `
            -Reason 'dsh plugin --profile web add failed while installing the Workbench TGZ into the isolated profile.' `
            -NextStep "Re-run this script, or run it manually with DSH_HOME=$DshHomeDir inside $HarnessCheckoutDir to see the underlying error."
    }

    Pop-Location
}

function Invoke-Phase3bVerifyLoad {
    # A successful `dsh plugin add` only proves the package was written into
    # the profile's node_modules -- not that it actually loads. This is the
    # reviewer-confirmed no-boot probe (S2): ask the installed Harness to
    # dump its resolved config for the same isolated profile, and confirm
    # the Workbench package name shows up in it, before this script is
    # allowed to declare `installed`.
    Push-Location -LiteralPath $HarnessCheckoutDir
    $previousDshHome = $env:DSH_HOME
    try {
        $env:DSH_HOME = $DshHomeDir
        $verifyOutput = (& pnpm dsh --profile web --dump-config 2>&1 | Out-String)
        $verifyExitCode = $LASTEXITCODE
    } finally {
        $env:DSH_HOME = $previousDshHome
    }
    Pop-Location

    if ($verifyExitCode -ne 0) {
        Complete-Result -State 'failed' `
            -Reason 'Post-install load verification failed: `dsh --profile web --dump-config` exited non-zero.' `
            -NextStep "Run manually with DSH_HOME=$DshHomeDir inside $HarnessCheckoutDir to see the underlying error, then re-run this script from a clean -Target."
    }
    if ($null -eq $verifyOutput -or -not $verifyOutput.Contains('@wanyexin1998/dsh-workbench')) {
        Complete-Result -State 'failed' `
            -Reason 'Post-install load verification ran but the Workbench package name did not appear in `dsh --profile web --dump-config` output; the plugin may not have loaded correctly.' `
            -NextStep "Run manually with DSH_HOME=$DshHomeDir inside $HarnessCheckoutDir to inspect the output, then re-run this script from a clean -Target."
    }
}

function Invoke-Phase4WriteLauncher {
    # S1: the launcher body below is fully self-relative (uses %~dp0, the
    # batch-file's own directory, resolved at run time) and therefore
    # contains NO absolute path written by this script -- so nothing here
    # can ever go stale, and there is no non-ASCII --target path content
    # left for -Encoding to mangle in the first place. The here-string is
    # single-quoted (@'...'@) specifically so none of THIS script's
    # variables are interpolated into the launcher body.
    $launcherContent = @'
@echo off
rem DSH Workbench isolated launcher -- generated by dsh-workbench-bootstrap.ps1
rem Self-relative: reads/writes only inside this launcher's own directory.
rem Never touches the official dsh install, PATH, or the registry.
setlocal
set "DSH_HOME=%~dp0home"
pushd "%~dp0deepseek-harness"
call pnpm dsh web %*
set "DSH_WORKBENCH_EXITCODE=%ERRORLEVEL%"
popd
endlocal & exit /b %DSH_WORKBENCH_EXITCODE%
'@
    try {
        Set-Content -LiteralPath $LauncherPath -Value $launcherContent -Encoding ASCII
    } catch {
        Complete-Result -State 'failed' `
            -Reason "Failed to write the launcher script at $LauncherPath`: $($_.Exception.Message)" `
            -NextStep 'Ensure the target directory is writable, then re-run this script.'
    }
}

function Invoke-TgzDownload {
    # B1: default acquisition path. Downloads to a .partial sibling file
    # first so a failed or interrupted download can never be mistaken for a
    # complete artifact -- the real destination path only ever contains a
    # fully-downloaded file, and it is still hash-verified by the caller
    # before any use regardless.
    param([string]$Url, [string]$Dest)
    $tmpDest = "$Dest.partial"
    if (Test-Path -LiteralPath $tmpDest) {
        Remove-Item -LiteralPath $tmpDest -Force -ErrorAction SilentlyContinue
    }
    try {
        Invoke-WebRequest -Uri $Url -OutFile $tmpDest -UseBasicParsing -ErrorAction Stop
    } catch {
        if (Test-Path -LiteralPath $tmpDest) {
            Remove-Item -LiteralPath $tmpDest -Force -ErrorAction SilentlyContinue
        }
        Complete-Result -State 'failed' `
            -Reason "Failed to download the Workbench release TGZ from $Url`: $($_.Exception.Message)" `
            -NextStep "Check your network connection and that the URL is reachable, or download it manually and re-run with -Tgz <path>."
    }
    Move-Item -LiteralPath $tmpDest -Destination $Dest -Force
}

# --- Main -------------------------------------------------------------------

try {
    # -Target is normalized HERE, inside the try and after Complete-Result
    # is defined, because GetFullPath throws on a value a caller can
    # plausibly pass -- most concretely `-Target ''`, which the PowerShell
    # binder accepts happily and hands straight to this call. While this
    # ran at the top of the script (above every function definition and
    # outside this try) the throw escaped before any handler existed, so
    # `-Target '' -CheckOnly` died with a raw
    # PowerShell exception and NO JSON line at all -- a caller parsing the
    # last stdout line got a parse error rather than a `failed` terminal
    # state. Every predictable argument error must leave through the
    # contract; see the ARGUMENT-PARSING PARITY NOTE in the header.
    try {
        $Target = [System.IO.Path]::GetFullPath($Target)
    } catch {
        Complete-Result -State 'failed' `
            -Reason "-Target is not a usable directory path: $($_.Exception.Message)" `
            -NextStep 'Re-run with -Target set to a valid absolute or relative directory path, or omit -Target entirely to install into the default root under $env:USERPROFILE.'
    }

    # --- Isolation invariant: every write path is derived from $Target ----
    $HarnessCheckoutDir = Join-Path $Target 'deepseek-harness'
    $DshHomeDir = Join-Path $Target 'home'
    $LauncherPath = Join-Path $Target 'dsh-workbench.cmd'
    $DownloadsDir = Join-Path $Target 'downloads'

    Test-Preconditions
    Test-PinSelfConsistency

    if ($CheckOnly) {
        $plan = Get-PlannedActionsText
        $nextStepParts = New-Object System.Collections.Generic.List[string]
        $nextStepParts.Add("pwsh -File `"$PSCommandPath`" -Target `"$Target`"")
        if ($Tgz) {
            $nextStepParts.Add("-Tgz `"$Tgz`"")
        }
        if ($WorkbenchTgzSha256 -eq 'STAMPED-AT-RELEASE') {
            $exampleHash = if ($TgzSha256) { $TgzSha256 } else { '<sha256-from-SHA256SUMS>' }
            $nextStepParts.Add("-TgzSha256 `"$exampleHash`"")
        }
        $nextStep = ($nextStepParts -join ' ')
        $humanBlock = "Check-only: no network access, no writes performed.`n仅检查模式：未联网，未写入任何文件。`n`n$plan"
        Complete-Result -State 'manual-action-required' `
            -Reason 'Check-only mode: preconditions and embedded-pin self-consistency passed; no network access or writes were performed.' `
            -NextStep $nextStep `
            -Details $null `
            -HumanBlock $humanBlock
    }

    # --- TGZ acquisition + verification (B1) ---------------------------------
    # The expected hash is resolved FIRST, before any network access or file
    # acquisition, so a run that could never pass verification (unstamped
    # placeholder and no -TgzSha256 override) fails fast without downloading
    # anything.

    $expectedHash = $null
    if ($TgzSha256) {
        $expectedHash = $TgzSha256.ToLowerInvariant()
        if ($expectedHash -notmatch '^[0-9a-f]{64}$') {
            Complete-Result -State 'failed' `
                -Reason "-TgzSha256 is not a valid 64-hex-character SHA256 hash: $TgzSha256" `
                -NextStep 'Pass the correct SHA256 value from SHA256SUMS and re-run.'
        }
    } elseif ($WorkbenchTgzSha256 -ne 'STAMPED-AT-RELEASE') {
        $expectedHash = $WorkbenchTgzSha256.ToLowerInvariant()
    } else {
        Complete-Result -State 'failed' `
            -Reason "This script's embedded Workbench TGZ SHA256 has not been stamped for release yet (placeholder value), and no -TgzSha256 override was supplied." `
            -NextStep 'Obtain the real SHA256 for the TGZ (e.g. from SHA256SUMS on the Release page) and re-run with -TgzSha256 <hex>.'
    }

    if ($Tgz) {
        # Offline override: use the caller-supplied TGZ path as-is, no network access.
        if (-not (Test-Path -LiteralPath $Tgz -PathType Leaf)) {
            Complete-Result -State 'failed' `
                -Reason "TGZ file not found at path: $Tgz" `
                -NextStep 'Re-download the release TGZ, verify it against SHA256SUMS, then re-run with -Tgz pointing at the correct file.'
        }
        $absTgz = (Resolve-Path -LiteralPath $Tgz).ProviderPath
    } else {
        # Default acquisition path: download the pinned-version release TGZ.
        New-Item -ItemType Directory -Force -Path $DownloadsDir | Out-Null
        $absTgz = Join-Path $DownloadsDir $WorkbenchTgzFilename
        Invoke-TgzDownload -Url "$ReleaseBaseUrl/$WorkbenchTgzFilename" -Dest $absTgz
    }

    $computedHash = (Get-FileHash -LiteralPath $absTgz -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($computedHash -ne $expectedHash) {
        Complete-Result -State 'failed' `
            -Reason "TGZ SHA256 mismatch: expected $expectedHash, computed $computedHash." `
            -NextStep 'Re-download the release TGZ and SHA256SUMS from the GitHub Release page; do not proceed with a mismatched artifact.'
    }

    Invoke-Phase1AcquireFork
    Invoke-Phase2BuildFork
    Invoke-Phase3InstallTgz -AbsTgzPath $absTgz
    Invoke-Phase3bVerifyLoad
    Invoke-Phase4WriteLauncher

    $details = [ordered]@{
        forkCommit = $HarnessCommit
        tgzSha256  = $computedHash
        targetDir  = $Target
    }
    $humanBlock = "DSH Workbench bootstrap install complete.`nDSH Workbench 独立引导安装已完成。`n`nLaunch it with: $LauncherPath`n使用以下命令启动：$LauncherPath`n`nThis install is fully isolated under $Target (apart from pnpm's own global`npackage store/cache, which pnpm manages outside -Target) and did not modify`nyour official Harness install, PATH, or shell profile in any way.`n本次安装完全隔离在 $Target 目录下（pnpm 自身的全局包存储/缓存除外，该部分由`npnpm 在 -Target 之外自行管理），未以任何方式改动你的官方 Harness 安装、PATH`n或 Shell 配置文件。"
    Complete-Result -State 'installed' `
        -Reason 'Harness fork verified, built, Workbench TGZ installed into the isolated profile, post-install load verification passed, and launcher written.' `
        -NextStep $null `
        -Details $details `
        -HumanBlock $humanBlock
} catch {
    Complete-Result -State 'failed' `
        -Reason "Unexpected error: $($_.Exception.Message)" `
        -NextStep 'Re-run this script from a clean -Target with -Verbose for more detail, or report this to the maintainer.'
}
