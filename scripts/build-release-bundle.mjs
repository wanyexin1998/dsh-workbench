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
