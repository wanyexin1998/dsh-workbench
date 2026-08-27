#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const pnpmEntry = process.env.npm_execpath
const pnpmCommand = pnpmEntry === undefined ? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm') : process.execPath
const pnpmArgs = args => pnpmEntry === undefined ? args : [pnpmEntry, ...args]
const commands = [
  { display: 'node scripts/scan-secrets.mjs', command: 'node', args: ['scripts/scan-secrets.mjs'] },
  { display: 'node scripts/release-contract-check.mjs', command: 'node', args: ['scripts/release-contract-check.mjs'] },
  { display: 'node --test scripts/install/result.test.mjs', command: 'node', args: ['--test', 'scripts/install/result.test.mjs'] },
  { display: 'pnpm typecheck', command: pnpmCommand, args: pnpmArgs(['typecheck']) },
  { display: 'pnpm test', command: pnpmCommand, args: pnpmArgs(['test']) },
  { display: 'pnpm audit --audit-level=low', command: pnpmCommand, args: pnpmArgs(['audit', '--audit-level=low']) },
  { display: 'node scripts/build-release-bundle.mjs', command: 'node', args: ['scripts/build-release-bundle.mjs'] },
]

for (const { display, command, args } of commands) {
  console.log(`\n> ${display}`)
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: pnpmEntry === undefined && process.platform === 'win32' && command === 'pnpm.cmd',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log('\nLocal release checks passed. No network publication was performed.')
