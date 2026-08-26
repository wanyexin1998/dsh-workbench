#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'dist')
const pnpmEntry = process.env.npm_execpath
const pnpmCommand = pnpmEntry === undefined ? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm') : process.execPath
const pnpmArgs = args => pnpmEntry === undefined ? args : [pnpmEntry, ...args]
const packages = [
  'packages/dsh-workbench',
  'packages/dsh-workbench-panel-compat',
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

for (const packagePath of packages) {
  const args = ['--dir', packagePath, 'pack', '--pack-destination', output]
  run(pnpmCommand, pnpmArgs(args), pnpmEntry === undefined && process.platform === 'win32')
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
    }
  })

if (artifacts.length !== packages.length) {
  throw new Error(`expected ${packages.length} TGZ artifacts, found ${artifacts.length}`)
}

const manifest = {
  schemaVersion: 1,
  sourceCommit: sourceRevision.stdout.trim(),
  workbenchVersion: contract.workbenchVersion,
  releaseStatus: contract.releaseStatus,
  harness: contract.harness,
  panelCompatibility: contract.panelCompatibility,
  artifacts,
}
writeFileSync(join(output, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(
  join(output, 'SHA256SUMS'),
  `${artifacts.map(artifact => `${artifact.sha256}  ${artifact.file}`).join('\n')}\n`,
)
console.log(`Release bundle written to ${output}`)
