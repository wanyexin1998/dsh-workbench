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
const install = read('docs/INSTALL.md')

check('contract schema version is 2', contract.schemaVersion === 2)
check('release is explicitly a source preview', contract.releaseStatus === 'source-preview')
check('root and Workbench versions match the contract',
  rootPackage.version === contract.workbenchVersion && workbench.version === contract.workbenchVersion)
check('presentation protocol is 2', contract.presentationProtocol === 2)
check('visible Pane capacity is 2', contract.maxVisiblePanes === 2)
check('third Session replaces focused Pane', contract.thirdSessionDisposition === 'replace-focused')
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

check('README states source-preview status', /source preview|源码预览/i.test(readme))
check('README states protocol 2', /protocol 2/i.test(readme))
check('install guide forbids automatic third-party install', /不会自动安装|does not automatically install/i.test(install))
check('install guide contains no npm publish command', !/npm\s+publish/i.test(install))

if (failures.length > 0) {
  console.error(`\nrelease-contract consistency: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\nrelease-contract consistency: all checks passed')
