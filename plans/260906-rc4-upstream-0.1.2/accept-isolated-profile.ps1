# rc.4 验收脚本：把插件 TGZ 装进一个隔离的 DSH_HOME，用 round-2 的 fork 起 web。
#
# 不动用户的真实 ~/.dsh、不动 fork 主 checkout。只读 fork 的 rc4 worktree（要先 pnpm build 过）。
# 用法：
#   pwsh -File accept-isolated-profile.ps1 -Tgz <path\to\wanyexin1998-dsh-workbench-*.tgz> [-IsolatedHome <dir>] [-NoWeb]
#
# ★ 2026-09-06 事故：这个参数原来叫 $Home。PowerShell 的 $HOME 是只读自动变量（= 用户主目录），
#   同名参数/赋值会静默失败，随后任何递归删除都可能跑在主目录上——当天就这么删掉了 ~/.dsh、
#   ~/.claude、~/.agents。所以现在：① 参数改名 $IsolatedHome；② 用之前先断言它不是主目录、不是主
#   目录的祖先，且路径里带着本脚本的标记；③ 本脚本自身不做任何删除——目录用时间戳新建，绝不"清空再用"。
param(
  [Parameter(Mandatory = $true)][string]$Tgz,
  [string]$Fork = 'E:\wyx_code\Vibe coding\harness-rc4',
  [string]$IsolatedHome = (Join-Path $env:TEMP ("dsh-rc4-accept-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))),
  [switch]$NoWeb
)
$ErrorActionPreference = 'Stop'

# ── 路径断言（见文件头）────────────────────────────────────────────────────
$profileRoot = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
$resolved = [IO.Path]::GetFullPath($IsolatedHome).TrimEnd('\')
if ([string]::IsNullOrWhiteSpace($resolved)) { throw 'IsolatedHome is empty' }
if ($resolved -ieq $profileRoot) { throw "refusing: IsolatedHome resolves to the user profile root ($resolved)" }
if ($profileRoot.StartsWith($resolved + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "refusing: IsolatedHome ($resolved) is an ancestor of the user profile" }
if ($resolved -notmatch 'dsh-rc4-accept') { throw "refusing: IsolatedHome ($resolved) does not carry the dsh-rc4-accept marker" }

if (-not (Test-Path $Tgz)) { throw "TGZ not found: $Tgz" }
if (-not (Test-Path (Join-Path $Fork 'apps\cli\src\bin.ts'))) { throw "fork worktree not found: $Fork" }
New-Item -ItemType Directory -Force $IsolatedHome | Out-Null
$env:DSH_HOME = $IsolatedHome
"DSH_HOME = $IsolatedHome"
"fork     = $Fork @ $(git -C $Fork rev-parse --short HEAD) ($(git -C $Fork branch --show-current))"
"tgz      = $Tgz"
"tgz sha  = $((Get-FileHash $Tgz -Algorithm SHA256).Hash.ToLower())"
""
Push-Location $Fork
try {
  "=== plugin add ==="
  pnpm dsh plugin --profile web add "file:$Tgz" 2>&1 | Select-Object -Last 8
  if ($LASTEXITCODE -ne 0) { throw "plugin add failed: $LASTEXITCODE" }
  ""
  "=== dump-config probe ==="
  $cfg = pnpm dsh --profile web --dump-config 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "dump-config failed: $LASTEXITCODE" }
  $hit = $cfg -match '@wanyexin1998/dsh-workbench'
  "workbench in composed config: $hit"
  if (-not $hit) { throw 'workbench layer missing from --dump-config' }
  if ($NoWeb) { "(-NoWeb: stopping before launching web)"; return }
  ""
  "=== launching web (Ctrl+C to stop). Check: no guard failure in console; Ctrl+click a 2nd session -> two [data-session-pane] ==="
  pnpm dsh web --no-open --port 0
} finally {
  Pop-Location
}
