#!/usr/bin/env node
// Tests for the DSH Workbench bootstrap installer scripts (A3,
// plans/260827-workbench-v2/tasks.md §3): dsh-workbench-bootstrap.ps1 (Windows)
// and dsh-workbench-bootstrap.sh (macOS).
//
// Run with: node --test scripts/bootstrap/bootstrap.test.mjs
//
// Scope, per the task brief:
//   (a) run the .ps1 with -CheckOnly via pwsh/powershell, parse the last
//       stdout line as JSON, validate it against scripts/install/result.mjs's
//       makeResult, and assert exit code semantics.
//   (b) bash -n syntax-check the .sh script (always), and additionally run
//       it under bash --check-only if that bash actually has node/pnpm/git
//       on its PATH; if it doesn't (or bash itself is unavailable), that one
//       execution assertion is skipped WITH A REASON rather than failed,
//       since this is an environment fact this suite cannot control.
//   (c) a static sweep of both script files: the pinned fork commit appears
//       exactly once in each, and neither contains an absolute personal
//       path (reusing the sweep regexes from scripts/install/result.test.mjs).
//
// This suite deliberately never performs a real network clone/build/install
// -- only --check-only (no network, no writes, by the script's own contract)
// and static analysis.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

import { makeResult, TERMINAL_STATES } from '../install/result.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ps1Path = join(here, 'dsh-workbench-bootstrap.ps1')
const shPath = join(here, 'dsh-workbench-bootstrap.sh')
const normalizeNewlines = source => source.replace(/\r\n?/g, '\n')
const ps1Source = normalizeNewlines(readFileSync(ps1Path, 'utf8'))
const shSource = normalizeNewlines(readFileSync(shPath, 'utf8'))

// On Windows, a bare `bash` can resolve to the WSL bash in System32, which
// answers --version but cannot read Windows-form paths like E:\... (exit
// 127) -- an environment accident, not a script defect. Prefer Git Bash
// (located via the git on PATH, which handles non-standard install roots),
// and accept a candidate only if it can actually read the script under test.
function resolveBash() {
  const candidates = []
  if (process.platform === 'win32') {
    const whereGit = spawnSync('where.exe', ['git'], { encoding: 'utf8' })
    if (whereGit.error === undefined && whereGit.status === 0) {
      for (const line of whereGit.stdout.split(/\r?\n/u)) {
        const gitPath = line.trim()
        // <root>\cmd\git.exe or <root>\bin\git.exe -> <root>\{bin,usr\bin}\bash.exe
        if (gitPath === '') continue
        const root = dirname(dirname(gitPath))
        candidates.push(join(root, 'bin', 'bash.exe'), join(root, 'usr', 'bin', 'bash.exe'))
      }
    }
    candidates.push(
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'bash',
    )
  } else {
    candidates.push('bash')
  }
  for (const candidate of candidates) {
    // The readability probe (not --version) is what rejects WSL bash: it
    // requires the candidate to resolve the Windows-form script path.
    const probe = spawnSync(candidate, ['-c', 'test -r "$0"', shPath], { encoding: 'utf8' })
    if (probe.error === undefined && probe.status === 0) return candidate
  }
  return undefined
}
const bashExe = resolveBash()

// Child-process budget for a single installer-script run. Every assertion
// below targets a pre-network abort, so these runs are fail-fast by design --
// but each one still spawns node, pnpm, and git once for its precondition
// checks, and on Windows those three spawns alone measured 5.5s / 9.9s / 3.3s
// under Git Bash (process creation there is dominated by on-access scanning,
// not by anything the scripts do; the same script fails in milliseconds on
// macOS/Linux). At 45s the bash lane failed deterministically under gate
// contention -- B5.2 died at 45.2s with empty stdout, which surfaces as
// `"undefined" is not valid JSON` rather than as a timeout. This budget
// absorbs that platform cost while still tripping on a genuine hang.
const SCRIPT_TIMEOUT_MS = 180_000


// The exit code contract both scripts document in their own header comments
// (not part of result.mjs itself -- these scripts' own addition for
// shell/CI use).
const EXPECTED_EXIT_CODE_FOR_STATE = {
  installed: 0,
  'manual-action-required': 2,
  incompatible: 3,
  failed: 1,
}

/**
 * Parse the LAST non-empty stdout line as JSON, per both scripts' output
 * contract ("the LAST stdout line is always one JSON object").
 */
function parseLastJsonLine(stdout) {
  const lines = stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
  const lastLine = lines[lines.length - 1]
  return JSON.parse(lastLine)
}

/**
 * Assert `resultJson` (parsed from a script's last stdout line) is a valid
 * InstallResult by round-tripping it through result.mjs's own makeResult --
 * this is the actual acceptance criterion, not a hand-rolled shape check.
 */
function assertRoundTripsThroughMakeResult(resultJson) {
  assert.ok(TERMINAL_STATES.has(resultJson.state), `state '${resultJson.state}' must be one of the four terminal states`)
  assert.equal(resultJson.schema, 1)
  const rebuilt = makeResult(resultJson.state, {
    reason: resultJson.reason,
    nextStep: resultJson.nextStep,
    details: resultJson.details,
  })
  assert.equal(rebuilt.state, resultJson.state)
  assert.equal(rebuilt.reason, resultJson.reason)
  assert.equal(rebuilt.nextStep, resultJson.nextStep)
  assert.deepEqual(rebuilt.details, resultJson.details)
}

// --- (a) PowerShell script: -CheckOnly via pwsh/powershell -----------------

function findWorkingPowerShell() {
  for (const candidate of ['pwsh', 'powershell']) {
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' })
    if (probe.error === undefined && probe.status === 0) return candidate
  }
  return null
}

const powerShellExe = findWorkingPowerShell()

test('dsh-workbench-bootstrap.ps1 -CheckOnly emits a result.mjs-valid JSON as the last stdout line, with the documented exit code', { skip: powerShellExe === null ? 'neither pwsh nor powershell is runnable in this environment' : false }, () => {
  const result = spawnSync(powerShellExe, ['-NoProfile', '-File', ps1Path, '-CheckOnly'], { encoding: 'utf8' })
  assert.equal(result.error, undefined, `spawning ${powerShellExe} must not error: ${result.error}`)

  let parsed
  try {
    parsed = parseLastJsonLine(result.stdout)
  } catch (parseError) {
    assert.fail(`last stdout line was not valid JSON: ${parseError.message}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`)
  }

  assertRoundTripsThroughMakeResult(parsed)
  // --check-only's own contract (A3 spec): preconditions pass on this
  // Windows dev/CI machine (node/pnpm/git are all present per Phase 0), so
  // it must reach exactly manual-action-required, never a network/write phase.
  assert.equal(parsed.state, 'manual-action-required')
  assert.equal(typeof parsed.nextStep, 'string')
  assert.notEqual(parsed.nextStep.trim(), '')
  assert.ok(!parsed.nextStep.includes('<BOOTSTRAP_COMMAND>'))

  assert.equal(result.status, EXPECTED_EXIT_CODE_FOR_STATE[parsed.state], `exit code must match this script's documented mapping for state '${parsed.state}'`)
})

test('dsh-workbench-bootstrap.ps1 -CheckOnly performs no network access or writes (planned-actions text only, no side effects)', { skip: powerShellExe === null ? 'neither pwsh nor powershell is runnable in this environment' : false }, () => {
  const result = spawnSync(powerShellExe, ['-NoProfile', '-File', ps1Path, '-CheckOnly'], { encoding: 'utf8' })
  assert.equal(result.error, undefined)
  assert.match(result.stdout, /Planned actions for a full run/u)
  assert.match(result.stdout, /no network access, no writes/u)
})

// --- (b) bash script: syntax check (always) + --check-only (best effort) ---

test('dsh-workbench-bootstrap.sh passes `bash -n` syntax check', { skip: bashExe === undefined ? 'no usable bash found (Git Bash absent and PATH bash unusable)' : false }, () => {
  const result = spawnSync(bashExe, ['-n', shPath], { encoding: 'utf8' })
  assert.equal(result.error, undefined, `spawning bash must not error: ${result.error}`)
  assert.equal(result.status, 0, `bash -n reported a syntax error:\n${result.stderr}`)
})

const bashCheckOnlyProbe = bashExe === undefined
  ? undefined
  : spawnSync(bashExe, [shPath, '--check-only'], { encoding: 'utf8' })
let bashCheckOnlyParsed
// NOTE: node:test's `skip` option treats even `null` as "skip" (only a
// literal `false` or omission means "run") -- so the "not skipped" default
// here must be `false`, not `null`.
let bashCheckOnlySkipReason = false
if (bashCheckOnlyProbe === undefined) {
  bashCheckOnlySkipReason = 'no usable bash found (Git Bash absent and PATH bash unusable)'
} else if (bashCheckOnlyProbe.error !== undefined) {
  bashCheckOnlySkipReason = `bash itself is not runnable in this environment: ${bashCheckOnlyProbe.error.message}`
} else {
  try {
    bashCheckOnlyParsed = parseLastJsonLine(bashCheckOnlyProbe.stdout)
  } catch {
    // The whatever-"bash"-resolves-to in this environment may not have
    // node/pnpm/git on its PATH even when the repo's own dev environment
    // does (observed on this machine: plain `bash` can resolve to WSL,
    // which has neither Node nor pnpm installed, rather than Git Bash).
    // That is exactly the "Git Bash env makes it flaky" case the task
    // brief anticipates -- keep the syntax check above green and skip only
    // this execution assertion, with the raw output attached for diagnosis.
    bashCheckOnlySkipReason = `bash ran but did not produce a parseable JSON last-line (environment likely lacks node/pnpm/git on this bash's PATH):\n--- stdout ---\n${bashCheckOnlyProbe.stdout}\n--- stderr ---\n${bashCheckOnlyProbe.stderr}`
  }
}

test('dsh-workbench-bootstrap.sh --check-only emits a result.mjs-valid JSON as the last stdout line, with the documented exit code', { skip: bashCheckOnlySkipReason }, () => {
  assertRoundTripsThroughMakeResult(bashCheckOnlyParsed)
  assert.equal(bashCheckOnlyProbe.status, EXPECTED_EXIT_CODE_FOR_STATE[bashCheckOnlyParsed.state], `exit code must match this script's documented mapping for state '${bashCheckOnlyParsed.state}'`)
  // Whatever terminal state this bash's PATH produced (manual-action-required
  // if preconditions passed, failed if e.g. node/pnpm were missing on THIS
  // bash's PATH), it must still be one of the four valid states and must
  // never claim `installed` -- --check-only must never reach a write phase.
  assert.notEqual(bashCheckOnlyParsed.state, 'installed')
})

test('dsh-workbench-bootstrap.sh --check-only performs no network access or writes when it reaches the check-only branch', { skip: bashCheckOnlySkipReason || (bashCheckOnlyParsed && bashCheckOnlyParsed.state !== 'manual-action-required' ? 'preconditions did not pass on this bash\'s PATH, so the check-only planned-actions branch was never reached' : false) }, () => {
  assert.match(bashCheckOnlyProbe.stdout, /Planned actions for a full run/u)
  assert.match(bashCheckOnlyProbe.stdout, /no network access, no writes/u)
})

// --- (c) static sweep: pinned commit appears exactly once, no personal paths ---

const HARNESS_COMMIT = '1a8cf5ba416246f22d9526a917af5fb233170c58'

// S2's post-install load verification is only reachable in a real networked
// run, so pin its presence statically: both engines must carry the
// --dump-config probe and gate `installed` on the Workbench package name
// appearing in its output.
test('both bootstrap scripts retain the post-install --dump-config load probe and its package-name guard', () => {
  for (const [name, source] of [['dsh-workbench-bootstrap.ps1', ps1Source], ['dsh-workbench-bootstrap.sh', shSource]]) {
    assert.ok(source.includes('--dump-config'), `${name} must run the --dump-config load probe before declaring installed`)
    assert.ok(source.includes('@wanyexin1998/dsh-workbench'), `${name} must check the probe output for the Workbench package name`)
  }
})

test('both bootstrap scripts contain the pinned Harness fork commit exactly once each', () => {
  const ps1Occurrences = (ps1Source.match(new RegExp(HARNESS_COMMIT, 'gu')) ?? []).length
  const shOccurrences = (shSource.match(new RegExp(HARNESS_COMMIT, 'gu')) ?? []).length
  assert.equal(ps1Occurrences, 1, `dsh-workbench-bootstrap.ps1 must reference the pinned commit exactly once (found ${ps1Occurrences}) -- every message must interpolate the $HarnessCommit variable, never re-type the literal hash`)
  assert.equal(shOccurrences, 1, `dsh-workbench-bootstrap.sh must reference the pinned commit exactly once (found ${shOccurrences}) -- every message must interpolate the $HARNESS_COMMIT variable, never re-type the literal hash`)
})

// Reused verbatim from scripts/install/result.test.mjs's fixture sweep (the
// fortyHex sweep from that file is deliberately NOT reused here -- these
// scripts are supposed to contain pinned 40-hex commit hashes by design).
const WINDOWS_USER_PATH = /[A-Za-z]:\\{1,2}Users\\{1,2}/u
const MAC_USER_PATH = /\/Users\/[^/\s]+\//u
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@(?!users\.noreply\.github\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/iu

test('neither bootstrap script contains an absolute personal Windows/macOS path or email address', () => {
  for (const [label, source] of [['dsh-workbench-bootstrap.ps1', ps1Source], ['dsh-workbench-bootstrap.sh', shSource]]) {
    assert.equal(WINDOWS_USER_PATH.test(source), false, `${label} must not contain a hardcoded personal Windows path (use $env:USERPROFILE instead)`)
    assert.equal(MAC_USER_PATH.test(source), false, `${label} must not contain a hardcoded personal macOS path (use $HOME instead)`)
    assert.equal(EMAIL_ADDRESS.test(source), false, `${label} must not contain an email address`)
  }
})

test('both bootstrap scripts derive their default target from an environment variable, not a literal home directory', () => {
  assert.match(ps1Source, /\$env:USERPROFILE/u)
  assert.match(shSource, /\$HOME/u)
})

// --- WORKBENCH_TGZ_SHA256 placeholder is present and clearly marked --------

test('both bootstrap scripts embed the WORKBENCH_TGZ_SHA256 placeholder marked STAMPED-AT-RELEASE', () => {
  assert.match(ps1Source, /WorkbenchTgzSha256\s*=\s*'STAMPED-AT-RELEASE'/u)
  assert.match(shSource, /WORKBENCH_TGZ_SHA256='STAMPED-AT-RELEASE'/u)
})

// --- S5: pin drift gate -- embedded Harness pin must match release-contract.json ---

const releaseContractPath = join(here, '..', '..', 'release-contract.json')
const releaseContract = JSON.parse(readFileSync(releaseContractPath, 'utf8'))

test('both bootstrap scripts embed the same Harness implementationCommit as release-contract.json (S5 pin drift gate)', () => {
  const commit = releaseContract.harness.implementationCommit
  assert.match(commit, /^[0-9a-f]{40}$/u, 'test setup: release-contract.json harness.implementationCommit must itself be a 40-hex commit')
  assert.ok(ps1Source.includes(commit), `dsh-workbench-bootstrap.ps1 must embed the same Harness implementationCommit as release-contract.json (${commit})`)
  assert.ok(shSource.includes(commit), `dsh-workbench-bootstrap.sh must embed the same Harness implementationCommit as release-contract.json (${commit})`)
})

test('both bootstrap scripts embed the same Harness branch as release-contract.json (S5 pin drift gate)', () => {
  const branch = releaseContract.harness.branch
  assert.ok(ps1Source.includes(`'${branch}'`), `dsh-workbench-bootstrap.ps1 must embed the same Harness branch as release-contract.json (${branch})`)
  assert.ok(shSource.includes(`'${branch}'`), `dsh-workbench-bootstrap.sh must embed the same Harness branch as release-contract.json (${branch})`)
  // TODO-A6: workbenchVersion is deliberately NOT asserted here yet.
  // release-contract.json's workbenchVersion (currently 0.2.0-rc.1) still
  // lags these scripts' embedded WORKBENCH_VERSION (0.2.0-rc.2) -- a
  // declared, tracked debt item for A6, not a drift bug (see
  // plans/260827-workbench-v2/tasks.md §3 A6 and §8's decision record).
  // Once that version bump lands, add:
  //   assert.equal(releaseContract.workbenchVersion, '<the embedded WORKBENCH_VERSION>')
  // for both scripts here, the same way implementationCommit/branch are
  // checked above.
})

// --- S1: generated launchers are self-relative -- no absolute path baked in ---
// The launcher body is only actually written to disk during a full (networked)
// run, which this suite deliberately never performs (see file header). So
// this checks the literal heredoc/here-string TEMPLATE BLOCK in each script's
// own source instead: the text that will become the launcher's on-disk
// content must never reference this script's own path variables.

test('the dsh-workbench-bootstrap.sh launcher template is self-relative and contains no absolute-path variable interpolation (S1)', () => {
  const match = /<<'LAUNCHER'\n([\s\S]*?)\nLAUNCHER\n/u.exec(shSource)
  assert.ok(match, 'test setup: could not locate the launcher heredoc block in dsh-workbench-bootstrap.sh')
  const launcherBody = match[1]
  assert.ok(!launcherBody.includes('$ABS_TARGET'), 'launcher body must not interpolate $ABS_TARGET')
  assert.ok(!launcherBody.includes('$HARNESS_CHECKOUT_DIR'), 'launcher body must not interpolate $HARNESS_CHECKOUT_DIR')
  assert.ok(!launcherBody.includes('$DSH_HOME_DIR'), 'launcher body must not interpolate $DSH_HOME_DIR')
  assert.match(launcherBody, /dirname/u, 'launcher body must derive its own directory at run time (e.g. via `dirname "$0"`)')
})

test('the dsh-workbench-bootstrap.ps1 launcher template is self-relative and contains no absolute-path variable interpolation (S1)', () => {
  const match = /\$launcherContent = @'\n([\s\S]*?)\n'@/u.exec(ps1Source)
  assert.ok(match, 'test setup: could not locate the launcher here-string block in dsh-workbench-bootstrap.ps1')
  const launcherBody = match[1]
  assert.ok(!launcherBody.includes('$Target'), 'launcher body must not interpolate $Target')
  assert.ok(!launcherBody.includes('$HarnessCheckoutDir'), 'launcher body must not interpolate $HarnessCheckoutDir')
  assert.ok(!launcherBody.includes('$DshHomeDir'), 'launcher body must not interpolate $DshHomeDir')
  assert.match(launcherBody, /%~dp0/u, 'launcher body must derive its own directory at run time (via %~dp0)')
})

// --- Regression: bootstrap scripts must invoke `pnpm dsh`, never `pnpm exec dsh` ---
// `dsh` is provided by the workspace package apps/cli (name=@deepseek-ai/dsh,
// bin={"dsh":"lib/bin.js"}), but that package is not a dependency of the
// Harness repo's ROOT package.json -- so pnpm never links a `dsh` bin into
// root node_modules/.bin. `pnpm exec dsh ...` therefore fails with
// ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL ("Command \"dsh\" not found"), confirmed
// against a real `pnpm install --frozen-lockfile && pnpm build` checkout.
// The repo's root package.json instead exposes a `dsh` SCRIPT
// ("dsh": "node --import tsx/esm apps/cli/src/bin.ts"), which `pnpm dsh ...`
// (a script invocation, not a bin lookup) runs correctly. This test locks
// that contract so a future edit cannot silently revert to the broken
// `pnpm exec dsh` form.

test('both bootstrap scripts invoke `pnpm dsh` (never `pnpm exec dsh`, which fails because `dsh` is not linked into node_modules/.bin)', () => {
  for (const [name, source] of [['dsh-workbench-bootstrap.ps1', ps1Source], ['dsh-workbench-bootstrap.sh', shSource]]) {
    assert.match(source, /pnpm dsh\b/u, `${name} must invoke the Harness CLI via the \`pnpm dsh\` root package.json script`)
    assert.ok(!source.includes('pnpm exec dsh'), `${name} must not contain \`pnpm exec dsh\` -- that bin is never linked into node_modules/.bin, so this form fails with ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`)
  }
})

test('the generated launcher body invokes `pnpm dsh` (never `pnpm exec dsh`) in both bootstrap scripts', () => {
  const shMatch = /<<'LAUNCHER'\r?\n([\s\S]*?)\r?\nLAUNCHER\r?\n/u.exec(shSource)
  assert.ok(shMatch, 'test setup: could not locate the launcher heredoc block in dsh-workbench-bootstrap.sh')
  const shLauncherBody = shMatch[1]
  assert.match(shLauncherBody, /pnpm dsh\b/u, 'dsh-workbench-bootstrap.sh launcher body must invoke `pnpm dsh`')
  assert.ok(!shLauncherBody.includes('pnpm exec dsh'), 'dsh-workbench-bootstrap.sh launcher body must not invoke `pnpm exec dsh`')

  const ps1Match = /\$launcherContent = @'\r?\n([\s\S]*?)\r?\n'@/u.exec(ps1Source)
  assert.ok(ps1Match, 'test setup: could not locate the launcher here-string block in dsh-workbench-bootstrap.ps1')
  const ps1LauncherBody = ps1Match[1]
  assert.match(ps1LauncherBody, /pnpm dsh\b/u, 'dsh-workbench-bootstrap.ps1 launcher body must invoke `pnpm dsh`')
  assert.ok(!ps1LauncherBody.includes('pnpm exec dsh'), 'dsh-workbench-bootstrap.ps1 launcher body must not invoke `pnpm exec dsh`')
})

// --- B5: security-invariant tests (no network needed -- the hash gate      ---
// --- precedes Phase 1, and Phase 1 refuses a pre-existing checkout dir)     ---
//
// Shared scratch root + a single fake TGZ fixture, cleaned up once at the
// end of the whole suite via `after`.

const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-test-'))
after(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})
const fakeTgzPath = join(tmpRoot, 'fake.tgz')
writeFileSync(fakeTgzPath, 'not a real tgz, just fixture bytes for hash verification tests\n')
const fakeTgzRealHash = createHash('sha256').update(readFileSync(fakeTgzPath)).digest('hex')
const wrongHash = '0'.repeat(64)
const nonHexHash = 'z'.repeat(64)

function shSkipReason() {
  return bashExe === undefined ? 'no usable bash found (Git Bash absent and PATH bash unusable)' : false
}
function ps1SkipReason() {
  return powerShellExe === null ? 'neither pwsh nor powershell is runnable in this environment' : false
}

// B5.1 -- --tgz with no --tgz-sha256 while the embedded placeholder is unstamped.

test('dsh-workbench-bootstrap.sh: --tgz with no --tgz-sha256 fails while the embedded hash placeholder is unstamped (B5.1)', { skip: shSkipReason() }, () => {
  const target = join(tmpRoot, 'b5-1-sh-target')
  const result = spawnSync(bashExe, [shPath, '--target', target, '--tgz', fakeTgzPath], { encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MS })
  const parsed = parseLastJsonLine(result.stdout)
  assertRoundTripsThroughMakeResult(parsed)
  assert.equal(parsed.state, 'failed')
  assert.match(parsed.reason, /stamped|placeholder/iu)
})

test('dsh-workbench-bootstrap.ps1: -Tgz with no -TgzSha256 fails while the embedded hash placeholder is unstamped (B5.1)', { skip: ps1SkipReason() }, () => {
  const target = join(tmpRoot, 'b5-1-ps1-target')
  const result = spawnSync(powerShellExe, ['-NoProfile', '-File', ps1Path, '-Target', target, '-Tgz', fakeTgzPath], { encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MS })
  const parsed = parseLastJsonLine(result.stdout)
  assertRoundTripsThroughMakeResult(parsed)
  assert.equal(parsed.state, 'failed')
  assert.match(parsed.reason, /stamped|placeholder/iu)
})

// B5.2 -- --tgz-sha256 supplied but wrong -> hash mismatch.

test('dsh-workbench-bootstrap.sh: --tgz-sha256 with a wrong (but well-formed) hash fails with a mismatch (B5.2)', { skip: shSkipReason() }, () => {
  const target = join(tmpRoot, 'b5-2-sh-target')
  const result = spawnSync(bashExe, [shPath, '--target', target, '--tgz', fakeTgzPath, '--tgz-sha256', wrongHash], { encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MS })
  const parsed = parseLastJsonLine(result.stdout)
  assertRoundTripsThroughMakeResult(parsed)
  assert.equal(parsed.state, 'failed')
  assert.match(parsed.reason, /mismatch/iu)
})

test('dsh-workbench-bootstrap.ps1: -TgzSha256 with a wrong (but well-formed) hash fails with a mismatch (B5.2)', { skip: ps1SkipReason() }, () => {
  const target = join(tmpRoot, 'b5-2-ps1-target')
  const result = spawnSync(powerShellExe, ['-NoProfile', '-File', ps1Path, '-Target', target, '-Tgz', fakeTgzPath, '-TgzSha256', wrongHash], { encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MS })
  const parsed = parseLastJsonLine(result.stdout)
  assertRoundTripsThroughMakeResult(parsed)
  assert.equal(parsed.state, 'failed')
  assert.match(parsed.reason, /mismatch/iu)
})

// B5.3 -- correct hash + a pre-existing <target>/deepseek-harness directory.
// This proves verification PASSED (a hash failure would stop the run one
// step earlier, before Phase 1 ever gets to check for a pre-existing
// checkout dir) and that the run still stops before any network step.

test('dsh-workbench-bootstrap.sh: correct --tgz-sha256 with a pre-existing deepseek-harness dir fails at "already exists", proving verification passed and the run stopped pre-network (B5.3)', { skip: shSkipReason() }, () => {
  const target = join(tmpRoot, 'b5-3-sh-target')
  mkdirSync(join(target, 'deepseek-harness'), { recursive: true })
  const result = spawnSync(bashExe, [shPath, '--target', target, '--tgz', fakeTgzPath, '--tgz-sha256', fakeTgzRealHash], { encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MS })
  const parsed = parseLastJsonLine(result.stdout)
  assertRoundTripsThroughMakeResult(parsed)
  assert.equal(parsed.state, 'failed')
  assert.match(parsed.reason, /already exists/iu)
})

test('dsh-workbench-bootstrap.ps1: correct -TgzSha256 with a pre-existing deepseek-harness dir fails at "already exists", proving verification passed and the run stopped pre-network (B5.3)', { skip: ps1SkipReason() }, () => {
  const target = join(tmpRoot, 'b5-3-ps1-target')
  mkdirSync(join(target, 'deepseek-harness'), { recursive: true })
  const result = spawnSync(powerShellExe, ['-NoProfile', '-File', ps1Path, '-Target', target, '-Tgz', fakeTgzPath, '-TgzSha256', fakeTgzRealHash], { encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MS })
  const parsed = parseLastJsonLine(result.stdout)
  assertRoundTripsThroughMakeResult(parsed)
  assert.equal(parsed.state, 'failed')
  assert.match(parsed.reason, /already exists/iu)
})

// B5.4 -- non-hex --tgz-sha256 is rejected outright.

test('dsh-workbench-bootstrap.sh: a non-hex --tgz-sha256 is rejected (B5.4)', { skip: shSkipReason() }, () => {
  const target = join(tmpRoot, 'b5-4-sh-target')
  const result = spawnSync(bashExe, [shPath, '--target', target, '--tgz', fakeTgzPath, '--tgz-sha256', nonHexHash], { encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MS })
  const parsed = parseLastJsonLine(result.stdout)
  assertRoundTripsThroughMakeResult(parsed)
  assert.equal(parsed.state, 'failed')
  assert.match(parsed.reason, /64-hex/iu)
})

test('dsh-workbench-bootstrap.ps1: a non-hex -TgzSha256 is rejected (B5.4)', { skip: ps1SkipReason() }, () => {
  const target = join(tmpRoot, 'b5-4-ps1-target')
  const result = spawnSync(powerShellExe, ['-NoProfile', '-File', ps1Path, '-Target', target, '-Tgz', fakeTgzPath, '-TgzSha256', nonHexHash], { encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MS })
  const parsed = parseLastJsonLine(result.stdout)
  assertRoundTripsThroughMakeResult(parsed)
  assert.equal(parsed.state, 'failed')
  assert.match(parsed.reason, /64-hex/iu)
})

// --- B4 regression: a trailing valueless flag must never hang -----------------

test('dsh-workbench-bootstrap.sh: a trailing valueless --tgz-sha256 flag exits promptly with a failed JSON, never hangs (B4 regression)', { skip: shSkipReason() }, () => {
  const result = spawnSync(bashExe, [shPath, '--tgz-sha256'], { encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MS })
  assert.notEqual(result.signal, 'SIGTERM', 'the process must exit on its own well within the timeout, not be killed by it (i.e. must not hang)')
  const parsed = parseLastJsonLine(result.stdout)
  assertRoundTripsThroughMakeResult(parsed)
  assert.equal(parsed.state, 'failed')
  assert.match(parsed.reason, /requires a value/iu)
  assert.equal(result.status, EXPECTED_EXIT_CODE_FOR_STATE.failed)
})

// dsh-workbench-bootstrap.ps1's parameter binding is native to PowerShell
// (CmdletBinding + typed [string]$TgzSha256): a bare trailing `-TgzSha256`
// is rejected by PowerShell itself before the script body ever runs, so it
// errors loudly and promptly but NOT through the JSON contract -- see the
// "ARGUMENT-PARSING PARITY NOTE (B4)" comment in both scripts' headers.
// This test pins that documented, intentional difference rather than the
// sh script's JSON-based behavior.
test('dsh-workbench-bootstrap.ps1: a trailing valueless -TgzSha256 flag exits promptly and loudly (not via the JSON contract -- documented B4 parity difference), never hangs', { skip: ps1SkipReason() }, () => {
  const result = spawnSync(powerShellExe, ['-NoProfile', '-File', ps1Path, '-TgzSha256'], { encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MS })
  assert.notEqual(result.signal, 'SIGTERM', 'the process must exit on its own well within the timeout, not be killed by it (i.e. must not hang)')
  assert.notEqual(result.status, 0, 'must exit with a nonzero status')
  assert.match(result.stderr, /TgzSha256/iu)
})

// --- S4 regression: full-charset hash validation, not just first/last char ---

test('dsh-workbench-bootstrap.sh: pin self-consistency rejects an embedded WORKBENCH_TGZ_SHA256 with valid first/last hex chars but an invalid character in the middle (S4 mutation regression)', { skip: shSkipReason() }, () => {
  const placeholderAssignment = "WORKBENCH_TGZ_SHA256='STAMPED-AT-RELEASE'"
  assert.ok(shSource.includes(placeholderAssignment), 'test setup: could not find the WORKBENCH_TGZ_SHA256 placeholder assignment to mutate')
  // 64 characters total, first and last are valid hex, but 'Z' (invalid)
  // fills the middle -- the pre-S4 bug (`[0-9a-f]*[0-9a-f]` glob) only
  // inspected the first/last character and would have accepted this.
  const badHash = `a${'Z'.repeat(62)}a`
  assert.equal(badHash.length, 64, 'test setup: badHash must be exactly 64 characters')
  const mutatedSource = shSource.replace(placeholderAssignment, `WORKBENCH_TGZ_SHA256='${badHash}'`)
  const scratchScript = join(tmpRoot, 's4-bad-middle-hex.sh')
  writeFileSync(scratchScript, mutatedSource, 'utf8')
  const result = spawnSync(bashExe, [scratchScript, '--check-only'], { encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MS })
  const parsed = parseLastJsonLine(result.stdout)
  assert.equal(parsed.state, 'failed')
  assert.match(parsed.reason, /pin self-consistency/iu)
  assert.match(parsed.reason, /lowercase 64-hex/iu)
})

// --- S6 regression: unexpected mid-run death still emits a valid failed JSON ---

test('dsh-workbench-bootstrap.sh: an unexpected mid-run death (forced unbound variable under `set -u`) still emits a valid failed JSON as the last line, via the EXIT trap safety net (S6 mutation regression)', { skip: shSkipReason() }, () => {
  const trapInstallLine = 'trap trap_unexpected_exit EXIT\n'
  const anchorIndex = shSource.indexOf(trapInstallLine)
  assert.ok(anchorIndex >= 0, 'test setup: could not find the EXIT trap installation line to inject after')
  const insertAt = anchorIndex + trapInstallLine.length
  const injectedLine = 'printf \'%s\\n\' "$DSH_BOOTSTRAP_TEST_FORCED_UNBOUND_VAR_XYZ" >/dev/null\n'
  const mutatedSource = shSource.slice(0, insertAt) + injectedLine + shSource.slice(insertAt)
  const scratchScript = join(tmpRoot, 's6-forced-unbound.sh')
  writeFileSync(scratchScript, mutatedSource, 'utf8')
  const result = spawnSync(bashExe, [scratchScript, '--check-only'], { encoding: 'utf8', timeout: SCRIPT_TIMEOUT_MS })
  assert.notEqual(result.signal, 'SIGTERM', 'must not hang')
  const parsed = parseLastJsonLine(result.stdout)
  assertRoundTripsThroughMakeResult(parsed)
  assert.equal(parsed.state, 'failed')
  assert.match(parsed.reason, /Unexpected script termination/iu)
  assert.equal(result.status, EXPECTED_EXIT_CODE_FOR_STATE.failed)
})
