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
  const checkout = flow.indexOf('git checkout --detach $WorkbenchCommit')
  const checkoutExit = flow.indexOf('if ($LASTEXITCODE -ne 0)', checkout)
  const resolveHead = flow.indexOf('git rev-parse --verify HEAD')
  const resolveExit = flow.indexOf('if ($LASTEXITCODE -ne 0)', resolveHead)
  const compare = flow.indexOf('$ResolvedCommit -ne $WorkbenchCommit')
  const detached = flow.indexOf('git symbolic-ref -q HEAD')
  const detachedCheck = flow.indexOf('if ($LASTEXITCODE -eq 0)', detached)
  const status = flow.indexOf('git status --porcelain=v1 --untracked-files=all')
  const statusExit = flow.indexOf('if ($LASTEXITCODE -ne 0)', status)
  const cleanCheck = flow.indexOf('if ($WorktreeState)', status)
  const verified = flow.indexOf('SOURCE-VERIFIED-BEFORE-REPOSITORY-CODE')
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
  && contract.sourceVerification?.exactHeadEqualityBeforeRepositoryCode === true)
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

if (failures.length > 0) {
  console.error(`\nrelease-contract consistency: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\nrelease-contract consistency: all checks passed')
