#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'dist')
const pnpmEntry = process.env.npm_execpath
const pnpmCommand = pnpmEntry === undefined ? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm') : process.execPath
const pnpmArgs = args => pnpmEntry === undefined ? args : [pnpmEntry, ...args]
const packages = [
  {
    path: 'packages/dsh-workbench',
    requiredFiles: ['THIRD_PARTY_NOTICES.md'],
  },
  {
    path: 'packages/dsh-workbench-panel-compat',
    requiredFiles: [],
  },
]

function run(command, args, shell = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const sourceRevision = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  shell: false,
})
if (sourceRevision.status !== 0) throw new Error('release bundle requires a committed Git revision')
const sourceStatus = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
  cwd: root,
  encoding: 'utf8',
  shell: false,
})
if (sourceStatus.status !== 0) throw new Error('unable to verify Git source state')
if (sourceStatus.stdout.trim() !== '') throw new Error('release bundle requires a clean Git worktree')

run(pnpmCommand, pnpmArgs(['build']), pnpmEntry === undefined && process.platform === 'win32')
run(process.execPath, ['scripts/scan-secrets.mjs', '--include-build'])

rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })

const packedMetadata = new Map()
for (const packageSpec of packages) {
  // pnpm resolves --pack-destination against the --dir project, not the
  // spawn cwd, so this must be expressed relative to the package. Passing
  // the absolute `output` instead breaks whenever the repository lives under
  // a path containing a space: without npm_execpath (e.g. `node
  // scripts/release-check.mjs`) the spawn falls back to the pnpm.cmd shim and
  // must set shell:true, and Node joins argv into one cmd.exe command line
  // without quoting -- the destination is word-split, pnpm reports a
  // successful pack, and the artifact count below fails with `found 0`.
  const packDestination = relative(join(root, packageSpec.path), output).split(sep).join('/')
  const args = ['--dir', packageSpec.path, 'pack', '--pack-destination', packDestination, '--json']
  const result = spawnSync(pnpmCommand, pnpmArgs(args), {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: pnpmEntry === undefined && process.platform === 'win32',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)

  const packReport = JSON.parse(result.stdout)
  const packedFiles = new Set(packReport.files.map(file => file.path))
  for (const requiredFile of packageSpec.requiredFiles) {
    if (!packedFiles.has(requiredFile)) {
      throw new Error(`${packReport.name} pack is missing required file ${requiredFile}`)
    }
  }

  const notices = packageSpec.requiredFiles.map((path) => {
    const data = readFileSync(join(root, packageSpec.path, path))
    return {
      path,
      sha256: createHash('sha256').update(data).digest('hex'),
    }
  })
  packedMetadata.set(basename(packReport.filename), { notices })
  console.log(`Packed ${packReport.name}@${packReport.version}: ${packedFiles.size} files`)
}

const contract = JSON.parse(readFileSync(join(root, 'release-contract.json'), 'utf8'))
const artifacts = readdirSync(output)
  .filter(name => name.endsWith('.tgz'))
  .sort()
  .map((name) => {
    const data = readFileSync(join(output, name))
    return {
      file: name,
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      notices: packedMetadata.get(name)?.notices ?? [],
    }
  })

if (artifacts.length !== packages.length) {
  throw new Error(`expected ${packages.length} TGZ artifacts, found ${artifacts.length}`)
}

// The installers are Release assets in their own right, and the one-line
// install commands in README/docs fetch SHA256SUMS and refuse to run a
// script whose digest is not listed there. Staging them into the bundle
// keeps `dist/` the exact set of files a Release carries, so the checksum
// list covers everything a user is told to verify.
const installers = ['dsh-workbench-bootstrap.ps1', 'dsh-workbench-bootstrap.sh'].map((name) => {
  copyFileSync(join(root, 'scripts', 'bootstrap', name), join(output, name))
  const data = readFileSync(join(output, name))
  return { file: name, bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex'), notices: [] }
})
const checksummed = [...artifacts, ...installers]

/*
 * 安装器里刻死的三个常量必须描述**刚刚打出来的这个** TGZ。
 *
 * 为什么需要这道检查：两个版本连着把过期的版本号 / 提交哈希发出去了，九步门禁
 * 全绿——因为没有任何一步拿文档或安装器去对账发布契约与真实产物。安装器尤其
 * 致命：它默认从 `RELEASE_BASE_URL` 下载 `WORKBENCH_VERSION` 那个文件名，再拿
 * `WORKBENCH_TGZ_SHA256` 校验。三个常量忘了改，用户要么装到上一版（版本号没动，
 * 校验还能过），要么每一次 bootstrap 都以 "TGZ SHA256 mismatch" 中止。
 *
 * ── 为什么不是无条件硬失败 ──────────────────────────────────────────────
 * 发布流程本身是个两趟循环，第一趟必须能跑起来：
 *   趟 1  打包 → 才知道新 TGZ 的摘要（源码变了摘要就变，没法预先算）
 *   人工  把摘要刻进两个安装器
 *   趟 2  重新打包 → SHA256SUMS 这才描述的是**刻好之后**的安装器
 * 趟 1 时摘要必然对不上。所以：默认硬失败，趟 1 用一个说明自己在干什么的显式
 * 开关 `--allow-unstamped` 放行。方向是刻意的——**默认路径（`pnpm release:check`
 * 不带任何参数）不可能悄悄发出一个没刻好的安装器**，要绕过必须自己打字。
 */
const allowUnstamped = process.argv.includes('--allow-unstamped')
const workbenchTgz = artifacts.find(artifact => artifact.file.startsWith('wanyexin1998-dsh-workbench-'))
if (workbenchTgz === undefined) throw new Error('workbench TGZ not found among packed artifacts')
const expectedTgzName = `wanyexin1998-dsh-workbench-${contract.workbenchVersion}.tgz`
if (workbenchTgz.file !== expectedTgzName) {
  throw new Error(`packed ${workbenchTgz.file} but the contract says ${expectedTgzName}`)
}
const releaseUrl = `https://github.com/wanyexin1998/dsh-workbench/releases/download/v${contract.workbenchVersion}`
const installerProblems = []
for (const name of ['dsh-workbench-bootstrap.ps1', 'dsh-workbench-bootstrap.sh']) {
  const text = readFileSync(join(root, 'scripts', 'bootstrap', name), 'utf8')
  const digest = /WORKBENCH_TGZ_SHA256\s*=\s*'([^']*)'|\$WorkbenchTgzSha256\s*=\s*'([^']*)'/.exec(text)
  const version = /WORKBENCH_VERSION\s*=\s*'([^']*)'|\$WorkbenchVersion\s*=\s*'([^']*)'/.exec(text)
  const found = match => (match === null ? null : match[1] ?? match[2])
  if (found(version) !== contract.workbenchVersion) {
    installerProblems.push(`${name}: embedded version ${found(version)} != contract ${contract.workbenchVersion}`)
  }
  if (!text.includes(releaseUrl)) {
    installerProblems.push(`${name}: does not carry the release URL ${releaseUrl}`)
  }
  if (found(digest) !== workbenchTgz.sha256) {
    installerProblems.push(
      `${name}: embedded TGZ digest ${found(digest)} != the digest of the ${workbenchTgz.file} just packed `
      + `(${workbenchTgz.sha256})`,
    )
  }
}
if (installerProblems.length > 0) {
  const detail = installerProblems.map(problem => `  - ${problem}`).join('\n')
  if (!allowUnstamped) {
    throw new Error(
      `bootstrap installers do not describe this bundle:\n${detail}\n\n`
      + `Stamp them and rebuild:\n`
      + `  1. write ${workbenchTgz.sha256}\n`
      + `     into WORKBENCH_TGZ_SHA256 (.sh) and $WorkbenchTgzSha256 (.ps1)\n`
      + `  2. set WORKBENCH_VERSION / $WorkbenchVersion to ${contract.workbenchVersion}\n`
      + `     and the release URL to ${releaseUrl}\n`
      + `  3. re-run this bundle so SHA256SUMS covers the stamped scripts\n\n`
      + `First pass of a release, before the digest is knowable? Re-run with --allow-unstamped.`,
    )
  }
  console.warn(
    `\n!! --allow-unstamped: publishing this bundle would break every install.\n${detail}\n`
    + `!! Stamp ${workbenchTgz.sha256} into both installers and rebuild WITHOUT the flag.\n`,
  )
}

const manifest = {
  schemaVersion: 2,
  sourceCommit: sourceRevision.stdout.trim(),
  workbenchVersion: contract.workbenchVersion,
  releaseStatus: contract.releaseStatus,
  harness: contract.harness,
  panelCompatibility: contract.panelCompatibility,
  artifacts: checksummed,
}
writeFileSync(join(output, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(
  join(output, 'SHA256SUMS'),
  `${checksummed.map(artifact => `${artifact.sha256}  ${artifact.file}`).join('\n')}\n`,
)
// Every file this bundle publishes must be listed in SHA256SUMS: the
// documented one-line installs abort when the digest of what they just
// downloaded is not there, so an asset added without a checksum entry
// breaks the install rather than merely going unverified.
const unlisted = readdirSync(output)
  .filter(name => name !== 'SHA256SUMS' && name !== 'release-manifest.json')
  .filter(name => !checksummed.some(artifact => artifact.file === name))
if (unlisted.length > 0) {
  throw new Error(`release assets missing from SHA256SUMS: ${unlisted.join(', ')}`)
}
console.log(`Release bundle written to ${output}`)
