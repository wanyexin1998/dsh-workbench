#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = relativePath => readFileSync(join(root, relativePath), 'utf8')
const json = relativePath => JSON.parse(read(relativePath))
const failures = []

function check(label, condition, detail = '') {
  if (condition) return console.log(`  ok   ${label}`)
  failures.push(label)
  console.error(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const contract = json('release-contract.json')
const rootPackage = json('package.json')
const workbench = json('packages/dsh-workbench/package.json')
const panelCompat = json('packages/dsh-workbench-panel-compat/package.json')
const guard = read('packages/dsh-workbench/src/client/guard.ts')
const readme = read('README.md')
const readmeEn = read('README_EN.md')
const install = read('docs/INSTALL.md')
const contributing = read('CONTRIBUTING.md')
const agents = read('AGENTS.md')
const packageReadme = read('packages/dsh-workbench/README.md')
const thirdPartyNotices = read('packages/dsh-workbench/THIRD_PARTY_NOTICES.md')
const lockfile = read('pnpm-lock.yaml')
const bundle = read('scripts/build-release-bundle.mjs')
const bundleBuild = bundle.indexOf("pnpmArgs(['build'])")
const bundleScan = bundle.indexOf("['scripts/scan-secrets.mjs', '--include-build']")
const bundlePack = bundle.indexOf("'pack', '--pack-destination'")

function hasSecureSourceFlow(document) {
  const start = document.indexOf('$WorkbenchCommit = Read-Host')
  if (start < 0) return false
  const flow = document.slice(start)
  const format = flow.indexOf("^[0-9a-fA-F]{40}$")
  const targetAbsent = flow.indexOf("Test-Path -LiteralPath 'dsh-workbench'")
  const clone = flow.indexOf('git clone --no-checkout')
  const cloneExit = flow.indexOf('if ($LASTEXITCODE -ne 0)', clone)
  const checkout = flow.indexOf('checkout --detach $WorkbenchCommit')
  const checkoutExit = flow.indexOf('if ($LASTEXITCODE -ne 0)', checkout)
  const resolveHead = flow.indexOf('rev-parse --verify HEAD')
  const resolveExit = flow.indexOf('if ($LASTEXITCODE -ne 0)', resolveHead)
  const compare = flow.indexOf('$ResolvedCommit -ne $WorkbenchCommit')
  const detached = flow.indexOf('symbolic-ref -q HEAD')
  const detachedCheck = flow.indexOf('if ($LASTEXITCODE -eq 0)', detached)
  const status = flow.indexOf('status --porcelain=v1 --untracked-files=all')
  const statusExit = flow.indexOf('if ($LASTEXITCODE -ne 0)', status)
  const cleanCheck = flow.indexOf('if ($WorktreeState)', status)
  const verified = flow.indexOf('WORKBENCH-SOURCE-VERIFIED-BEFORE-REPOSITORY-CODE')
  const firstPnpm = flow.indexOf('pnpm install --frozen-lockfile')
  return format >= 0
    && targetAbsent > format
    && clone > targetAbsent
    && cloneExit > clone && cloneExit < checkout
    && checkout > cloneExit
    && checkoutExit > checkout && checkoutExit < resolveHead
    && resolveHead > checkoutExit
    && resolveExit > resolveHead && resolveExit < compare
    && compare > resolveHead
    && detached > compare
    && detachedCheck > detached && detachedCheck < status
    && status > detachedCheck
    && statusExit > status && statusExit < cleanCheck
    && cleanCheck > statusExit
    && verified > cleanCheck
    && firstPnpm > verified
}

function hasPinnedExternalFlow(document, spec) {
  const start = document.indexOf(`$${spec.commitVariable} = '${spec.commit}'`)
  if (start < 0) return false
  const flow = document.slice(start)
  const format = flow.indexOf("^[0-9a-f]{40}$")
  const targetAbsent = flow.indexOf(`Test-Path -LiteralPath '${spec.target}'`)
  const clone = flow.indexOf(`git clone --no-checkout ${spec.repository}.git ${spec.target}`)
  const cloneExit = flow.indexOf('if ($LASTEXITCODE -ne 0)', clone)
  const checkout = flow.indexOf(`checkout --detach $${spec.commitVariable}`)
  const checkoutExit = flow.indexOf('if ($LASTEXITCODE -ne 0)', checkout)
  const resolveHead = flow.indexOf('rev-parse --verify HEAD')
  const resolveExit = flow.indexOf('if ($LASTEXITCODE -ne 0)', resolveHead)
  const compare = flow.indexOf(`$${spec.resolvedVariable} -ne $${spec.commitVariable}`)
  const detached = flow.indexOf('symbolic-ref -q HEAD')
  const detachedCheck = flow.indexOf('if ($LASTEXITCODE -eq 0)', detached)
  const status = flow.indexOf('status --porcelain=v1 --untracked-files=all')
  const statusExit = flow.indexOf('if ($LASTEXITCODE -ne 0)', status)
  const cleanCheck = flow.indexOf(`if ($${spec.worktreeVariable})`, status)
  const verified = flow.indexOf(spec.marker)
  const executionDirectory = spec.executionDirectory === undefined
    ? -1
    : flow.indexOf(`Push-Location -LiteralPath '${spec.executionDirectory}' -ErrorAction Stop`)
  const instructionAnchor = spec.instructionAnchor === undefined
    ? -1
    : flow.indexOf(spec.instructionAnchor)
  const firstPnpm = flow.indexOf('pnpm ')
  return format >= 0
    && targetAbsent > format
    && clone > targetAbsent
    && cloneExit > clone && cloneExit < checkout
    && checkout > cloneExit
    && checkoutExit > checkout && checkoutExit < resolveHead
    && resolveHead > checkoutExit
    && resolveExit > resolveHead && resolveExit < compare
    && compare > resolveExit
    && detached > compare
    && detachedCheck > detached && detachedCheck < status
    && status > detachedCheck
    && statusExit > status && statusExit < cleanCheck
    && cleanCheck > statusExit
    && verified > cleanCheck
    && (!spec.requiresPnpm || (executionDirectory > verified && firstPnpm > executionDirectory))
    && (spec.instructionAnchor === undefined || instructionAnchor > verified)
}

function hasNoRepositoryExecutionBefore(document, marker) {
  const markerIndex = document.indexOf(marker)
  if (markerIndex < 0) return false
  const prefix = document.slice(0, markerIndex)
  let inPowerShell = false
  for (const rawLine of prefix.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '```powershell') {
      inPowerShell = true
      continue
    }
    if (line === '```') {
      inPowerShell = false
      continue
    }
    if (!inPowerShell || line === '' || line.startsWith('#')) continue
    if (/^(?:pnpm(?:\.cmd)?|npm|node|corepack|pwsh|powershell|dsh|Push-Location|Start-Process|Invoke-Expression|&|\.\s)/u.test(line)) {
      return false
    }
  }
  return true
}

check('contract schema version is 3', contract.schemaVersion === 3)
check('release is explicitly a source preview', contract.releaseStatus === 'source-preview')
check('root and Workbench versions match the contract',
  rootPackage.version === contract.workbenchVersion && workbench.version === contract.workbenchVersion)
check('presentation protocol is 2', contract.presentationProtocol === 2)
check('visible Pane capacity is 2', contract.maxVisiblePanes === 2)
check('third Session replaces focused Pane', contract.thirdSessionDisposition === 'replace-focused')
check('source verification requires a user-approved full commit',
  contract.sourceVerification?.mode === 'user-approved-full-commit'
  && contract.sourceVerification?.commitFormat === '^[0-9a-fA-F]{40}$')
check('source verification precedes repository code',
  contract.sourceVerification?.requireNonexistentTarget === true
  && contract.sourceVerification?.cloneNoCheckout === true
  && contract.sourceVerification?.detachedCheckout === true
  && contract.sourceVerification?.failOnGitError === true
  && contract.sourceVerification?.detachedHeadProof === true
  && contract.sourceVerification?.cleanWorktreeBeforeRepositoryCode === true
  && contract.sourceVerification?.exactHeadEqualityBeforeRepositoryCode === true
  && contract.sourceVerification?.externalPinnedSourcesBeforeExecution === true
  && contract.sourceVerification?.failClosedWorkingDirectory === true
  && contract.sourceVerification?.wholeDocumentExecutableScan === true
  && contract.sourceVerification?.instructionOrderAnchors === true)
check('Workbench guard pins protocol 2', /protocol:\s*2\b/.test(read('packages/dsh-workbench/src/client/contract.ts')))
check('Workbench guard requests capacity 2', /WORKBENCH_VISIBLE_CAPACITY\s*=\s*2\b/.test(guard))

for (const [name, range] of Object.entries(workbench.peerDependencies ?? {})) {
  if (!name.startsWith('@deepseek-ai/dsh')) continue
  check(`Workbench peer ${name} matches Harness baseline`, range === contract.harness.upstreamVersion, `range=${range}`)
}

check('Harness implementation commit is pinned', /^[0-9a-f]{40}$/.test(contract.harness?.implementationCommit ?? ''))
check('Better Sidebar implementation commit is pinned',
  /^[0-9a-f]{40}$/.test(contract.panelCompatibility?.implementationCommit ?? ''))
check('Panel package version matches contract', panelCompat.version === contract.panelCompatibility?.packageVersion)
check('Panel package pins Better Sidebar version',
  panelCompat.peerDependencies?.['dsh-better-sidebar'] === contract.panelCompatibility?.providerVersion)
check('Panel package excludes Workbench 0.1',
  panelCompat.peerDependencies?.['@wanyexin1998/dsh-workbench'] === '>=0.2.0-rc.1 <0.3.0')

check('npm publication is disabled by contract', contract.distribution?.npmPublished === false)
check('automatic installer is disabled', contract.distribution?.automaticInstaller === false)
check('third-party auto-install is disabled', contract.distribution?.automaticThirdPartyInstall === false)
check('both source packages are private against accidental publish', workbench.private === true && panelCompat.private === true)
check('GitHub Actions are disabled by contract', contract.repository?.githubActions === false)
check('repository contains no workflow files', !existsSync(join(root, '.github', 'workflows')))
check('bundle rebuilds and scans generated runtime before packing',
  bundleBuild >= 0 && bundleScan > bundleBuild && bundlePack > bundleScan)
check('bundle validates required packed files from pnpm JSON',
  bundle.includes("requiredFiles: ['THIRD_PARTY_NOTICES.md']")
  && bundle.includes("'--json'")
  && bundle.includes('pack is missing required file')
  && bundle.includes('basename(packReport.filename)'))

check('Chinese README verifies immutable source before pnpm', hasSecureSourceFlow(readme))
check('English README verifies immutable source before pnpm', hasSecureSourceFlow(readmeEn))
check('install guide verifies immutable source before pnpm', hasSecureSourceFlow(install))
check('install guide verifies the pinned Harness before pnpm', hasPinnedExternalFlow(install, {
  commitVariable: 'HarnessCommit',
  resolvedVariable: 'ResolvedHarnessCommit',
  worktreeVariable: 'HarnessWorktreeState',
  commit: contract.harness.implementationCommit,
  repository: contract.harness.repository,
  target: 'deepseek-harness',
  marker: 'HARNESS-SOURCE-VERIFIED-BEFORE-REPOSITORY-CODE',
  requiresPnpm: true,
  executionDirectory: 'deepseek-harness',
}))
check('install guide verifies optional Better Sidebar before its instructions', hasPinnedExternalFlow(install, {
  commitVariable: 'BetterSidebarCommit',
  resolvedVariable: 'ResolvedBetterSidebarCommit',
  worktreeVariable: 'BetterSidebarWorktreeState',
  commit: contract.panelCompatibility.implementationCommit,
  repository: contract.panelCompatibility.repository,
  target: 'DSH-better-sidebar',
  marker: 'BETTER-SIDEBAR-SOURCE-VERIFIED-BEFORE-REPOSITORY-CODE',
  requiresPnpm: false,
  instructionAnchor: 'BETTER-SIDEBAR-INSTRUCTIONS-AFTER-SOURCE-VERIFICATION',
}))
const firstInstallPnpm = install.indexOf('pnpm ')
check('complete install guide verifies Workbench and Harness before its first pnpm',
  install.indexOf('WORKBENCH-SOURCE-VERIFIED-BEFORE-REPOSITORY-CODE') >= 0
  && install.indexOf('HARNESS-SOURCE-VERIFIED-BEFORE-REPOSITORY-CODE') >= 0
  && firstInstallPnpm > install.indexOf('WORKBENCH-SOURCE-VERIFIED-BEFORE-REPOSITORY-CODE')
  && firstInstallPnpm > install.indexOf('HARNESS-SOURCE-VERIFIED-BEFORE-REPOSITORY-CODE'))
check('complete install guide has no repository execution before source verification',
  hasNoRepositoryExecutionBefore(install, 'HARNESS-SOURCE-VERIFIED-BEFORE-REPOSITORY-CODE'))
check('agent install prompt stops without an approved commit',
  /若我未提供则停止/.test(readme) && /stop if I do not provide one/i.test(readmeEn))
check('contributor workflow distinguishes a trusted baseline',
  /trusted baseline/i.test(contributing) && /inspect proposed diffs/i.test(contributing))
check('agent and package instructions route to secure acquisition',
  /docs\/INSTALL\.md/.test(agents) && /docs\/INSTALL\.md/.test(packageReadme))

const noticeContract = contract.distribution?.bundledThirdPartyNotices?.['@wanyexin1998/dsh-workbench']
check('Workbench package ships its third-party notice',
  workbench.files?.includes('THIRD_PARTY_NOTICES.md')
  && noticeContract?.path === 'packages/dsh-workbench/THIRD_PARTY_NOTICES.md')
check('bundled dependency versions are registered',
  noticeContract?.components?.['@deepseek-ai/schemastery'] === '3.18.1'
  && noticeContract?.components?.['@deepseek-ai/cosmokit'] === '1.8.2'
  && /@deepseek-ai\/schemastery@3\.18\.1/.test(lockfile)
  && /@deepseek-ai\/cosmokit@1\.8\.2/.test(lockfile))
check('bundled dependency notice retains complete MIT terms',
  thirdPartyNotices.includes('@deepseek-ai/schemastery` 3.18.1')
  && thirdPartyNotices.includes('@deepseek-ai/cosmokit` 1.8.2')
  && thirdPartyNotices.includes('Copyright (c) 2021-present Shigma')
  && thirdPartyNotices.includes('Permission is hereby granted, free of charge')
  && thirdPartyNotices.includes('The above copyright notice and this permission notice')
  && thirdPartyNotices.includes('THE SOFTWARE IS PROVIDED "AS IS"')
  && thirdPartyNotices.includes('OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE'))

check('README states source-preview status', /source preview|源码预览/i.test(readme))
check('README states protocol 2', /protocol 2/i.test(readme))
check('install guide forbids automatic third-party install', /不会自动安装|does not automatically install/i.test(install))
check('install guide contains no npm publish command', !/npm\s+publish/i.test(install))

/* ── 文档对账：版本号与固定提交 ──────────────────────────────────────────────
 *
 * 这两条检查是补上来的，补的是一个**已经连着两个版本溜过去**的错误类别：
 * 用户文档里的版本号或固定提交哈希过期了，而九步发布门禁全绿。rc.3 之前最后一次
 * 是 README 兼容性表把分支 `feat/toggle-settings-verb` 和它的**父提交**
 * `1a8cf5b…` 配在了一起——照着那一行去 pin 的人，装到的是一个没有
 * `toggleSettings()` 的 Harness。推进 pin 那次改了分支名，漏了哈希，而当时这个
 * 文件对两个 README 只做两条散文正则（"source preview"、"protocol 2"），对
 * INSTALL.md 才比对提交字面量。
 *
 * ── 豁免为什么必须是"看得见"的 ────────────────────────────────────────────
 * 有些文档**理应**写着旧版本：端到端证据说的是那次运行实际验的那个构建，
 * RELEASE_NOTES 的历史小节按定义就是历史。但"整个文件跳过"这种豁免，正是这类
 * bug 活下来的方式——它在调用点看不见，加了就再也没人回头看。所以豁免写成下面
 * 这张表：一行一个文件，附带理由，任何人读 diff 都会看到它，而且**只豁免版本
 * 号、不豁免固定提交**。
 */
const DOC_VERSION_SCAN = [
  'README.md',
  'README_EN.md',
  'docs/INSTALL.md',
  'docs/COMPATIBILITY_MATRIX.md',
  'docs/KNOWN_ISSUES.md',
  'docs/SECURITY_STATEMENT.md',
  'SECURITY.md',
]
// 豁免粒度：文件 + 那一个具体版本号 + **那一行必须包含的字样**。
//
// 三个维度缺一不可，这是调试这条检查时现场踩出来的：先写成"按文件放行"，然后拿
// 「把 README 兼容性表里的 rc.3 改回 rc.2」去验它能不能杀——**没杀掉**。因为
// README 本来就为了截图说明那一行豁免了 rc.2，于是同一个文件里任何地方真的写错
// 成 rc.2 也一并静默——正是这条检查要堵的那类 bug。钉到行上之后，豁免只盖得住
// 它自己那句话。
const DOC_VERSION_EXEMPT = [
  {
    file: 'docs/COMPATIBILITY_MATRIX.md',
    version: '0.2.0-rc.2',
    context: 'end-to-end',
    reason: 'Windows end-to-end evidence names the release it was actually gathered against',
  },
  {
    file: 'docs/KNOWN_ISSUES.md',
    version: '0.2.0-rc.2',
    context: 'end-to-end',
    reason: 'same end-to-end evidence, restated for readers of the issue list',
  },
  {
    file: 'README.md',
    version: '0.2.0-rc.2',
    context: '截图',
    reason: 'the shortcuts screenshot caption dates the image to the release it was captured against',
  },
  {
    file: 'README_EN.md',
    version: '0.2.0-rc.2',
    context: 'screenshot',
    reason: 'same screenshot caption, English side of the pair',
  },
]
// 版本形如 0.2.0-rc.3；shields.io 徽章里连字符要转义成 `--`，两种都扫。
const VERSION_PATTERN = /\b\d+\.\d+\.\d+-rc\.\d+\b/g
const BADGE_PATTERN = /\b\d+\.\d+\.\d+--rc\.\d+\b/g
const staleVersions = []
for (const file of DOC_VERSION_SCAN) {
  const lines = read(file).split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    const found = new Set([
      ...(line.match(VERSION_PATTERN) ?? []),
      ...(line.match(BADGE_PATTERN) ?? []).map(badge => badge.replace('--rc.', '-rc.')),
    ])
    for (const version of found) {
      if (version === contract.workbenchVersion) continue
      // 下面两个是别的产物的版本号，形状相同而已，不归这条检查管。
      if (version === contract.harness.upstreamVersion) continue
      if (version === contract.panelCompatibility.packageVersion) continue
      const exempt = DOC_VERSION_EXEMPT.some(entry => entry.file === file
        && entry.version === version
        && line.includes(entry.context))
      if (exempt) continue
      staleVersions.push(`${file}:${index + 1}: ${version}`)
    }
  }
}
check('user-facing docs name the contract workbenchVersion', staleVersions.length === 0,
  `${staleVersions.join('; ')} (contract says ${contract.workbenchVersion}; `
  + `exempt: ${DOC_VERSION_EXEMPT.map(entry => `${entry.file}@${entry.version} only on lines saying `
  + `"${entry.context}" — ${entry.reason}`).join('; ')})`)

/* 固定提交没有豁免名单：一个缩写只要是契约里那个 40 位哈希的前缀就算对，不是
 * 前缀就是错。README 写 `82de604a…`、INSTALL 写完整 40 位，两种都覆盖。
 * 只认长度 >= 7 的十六进制串——再短的容易撞上普通英文单词。 */
const PINNED = [
  { label: 'Harness', commit: contract.harness.implementationCommit },
  { label: 'Better Sidebar', commit: contract.panelCompatibility.implementationCommit },
]
const COMMITISH = /`([0-9a-f]{7,40})[….]{0,3}`/g
const stalePins = []
for (const file of ['README.md', 'README_EN.md', 'docs/COMPATIBILITY_MATRIX.md']) {
  const text = read(file)
  for (const [, candidate] of text.matchAll(COMMITISH)) {
    const matchesSomePin = PINNED.some(pin => pin.commit.startsWith(candidate))
    // 历史 pin 是可以出现的（"上一版固定的是 X"），但必须**显式**说自己是旧的。
    // 判据：同一行提到 rc.2 / previous / 旧 pin 之类的字样。
    const line = text.split(/\r?\n/).find(row => row.includes(candidate)) ?? ''
    const declaredHistorical = /rc\.\d+|previous|earlier|旧|上一版/i.test(line)
    if (matchesSomePin || declaredHistorical) continue
    stalePins.push(`${file}: \`${candidate}\``)
  }
}
check('user-facing docs name the contract pinned commits', stalePins.length === 0,
  `${stalePins.join('; ')} (contract pins ${PINNED.map(pin => `${pin.label} ${pin.commit.slice(0, 8)}`).join(', ')})`)

if (failures.length > 0) {
  console.error(`\nrelease-contract consistency: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\nrelease-contract consistency: all checks passed')
