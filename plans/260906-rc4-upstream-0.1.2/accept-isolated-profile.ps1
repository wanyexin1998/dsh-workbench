# rc.4 验收脚本：把插件 TGZ 装进一个隔离的 DSH_HOME，用 round-2 的 fork 起 web。
#
# 不动用户的真实 ~/.dsh、不动 fork 主 checkout。只读 fork 的 rc4 worktree（要先 pnpm build 过）。
# 用法：
#   pwsh -File accept-isolated-profile.ps1 -Tgz <path\to\wanyexin1998-dsh-workbench-*.tgz> [-Home <dir>] [-NoWeb]
param(
  [Parameter(Mandatory = $true)][string]$Tgz,
  [string]$Fork = 'E:\wyx_code\Vibe coding\harness-rc4',
  [string]$Home = (Join-Path $env:TEMP ("dsh-rc4-accept-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))),
  [switch]$NoWeb
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Tgz)) { throw "TGZ not found: $Tgz" }
if (-not (Test-Path (Join-Path $Fork 'apps\cli\src\bin.ts'))) { throw "fork worktree not found: $Fork" }
New-Item -ItemType Directory -Force $Home | Out-Null
$env:DSH_HOME = $Home
"DSH_HOME = $Home"
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
