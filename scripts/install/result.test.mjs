#!/usr/bin/env node
// Tests for the install result contract (scripts/install/result.mjs).
// Run with: node --test scripts/install/result.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeResult, evaluateEnvironment, validateDisclosure, validateSidebarOffer, TERMINAL_STATES } from './result.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(here, 'fixtures', '260827-macos-replay.json')
const fixtureRaw = readFileSync(fixturePath, 'utf8')
const fixture = JSON.parse(fixtureRaw)

const tasksMdPath = join(here, '..', '..', 'plans', '260827-workbench-v2', 'tasks.md')
const tasksMdRaw = readFileSync(tasksMdPath, 'utf8')

/**
 * Extract the fenced sample text immediately following a given normative
 * heading in tasks.md, so tests validate the actual doc content rather than
 * a copy that could silently drift from it.
 * @param {string} heading
 * @returns {string}
 */
function extractFencedSampleAfter(heading) {
  const headingIndex = tasksMdRaw.indexOf(heading)
  if (headingIndex < 0) throw new Error(`heading not found in tasks.md: ${heading}`)
  const afterHeading = tasksMdRaw.slice(headingIndex)
  const fenceStart = afterHeading.indexOf('```text\n')
  if (fenceStart < 0) throw new Error(`no \`\`\`text fence found after heading: ${heading}`)
  const contentStart = fenceStart + '```text\n'.length
  const fenceEnd = afterHeading.indexOf('\n```', contentStart)
  if (fenceEnd < 0) throw new Error(`unterminated \`\`\`text fence after heading: ${heading}`)
  return afterHeading.slice(contentStart, fenceEnd)
}

// --- makeResult: four terminal states + validation ---

test('makeResult builds each of the four terminal states', () => {
  const installed = makeResult('installed', { reason: 'Plugin written to DSH_HOME and load verification succeeded.' })
  assert.equal(installed.state, 'installed')
  assert.equal(installed.schema, 1)
  assert.equal(installed.nextStep, null)
  assert.ok(Object.isFrozen(installed))

  const incompatible = makeResult('incompatible', { reason: 'Target Harness major version is unsupported.' })
  assert.equal(incompatible.state, 'incompatible')
  assert.ok(Object.isFrozen(incompatible))

  const manual = makeResult('manual-action-required', {
    reason: 'DSH_HOME is not writable by the sandbox.',
    nextStep: 'pwsh -File .\\dsh-workbench-bootstrap.ps1',
  })
  assert.equal(manual.state, 'manual-action-required')
  assert.equal(manual.nextStep, 'pwsh -File .\\dsh-workbench-bootstrap.ps1')
  assert.ok(Object.isFrozen(manual))

  const failed = makeResult('failed', {
    reason: 'Artifact hash did not match SHA256SUMS.',
    nextStep: 'Re-download the release artifact and retry.',
  })
  assert.equal(failed.state, 'failed')
  assert.ok(Object.isFrozen(failed))

  assert.deepEqual(new Set(['installed', 'incompatible', 'manual-action-required', 'failed']), TERMINAL_STATES)
})

test('makeResult throws on an unknown state', () => {
  assert.throws(() => makeResult('not-a-real-state', { reason: 'x' }), /Unknown install result state/)
})

test('makeResult throws when reason is missing or empty', () => {
  assert.throws(() => makeResult('installed', {}), /non-empty 'reason'/)
  assert.throws(() => makeResult('installed', { reason: '' }), /non-empty 'reason'/)
  assert.throws(() => makeResult('installed', { reason: '   ' }), /non-empty 'reason'/)
})

test('makeResult throws when nextStep is missing for manual-action-required or failed', () => {
  assert.throws(() => makeResult('manual-action-required', { reason: 'read-only DSH_HOME' }), /non-empty 'nextStep'/)
  assert.throws(() => makeResult('failed', { reason: 'verification failed' }), /non-empty 'nextStep'/)
  // installed/incompatible do not require nextStep.
  assert.doesNotThrow(() => makeResult('installed', { reason: 'ok' }))
  assert.doesNotThrow(() => makeResult('incompatible', { reason: 'unsupported Harness' }))
})

test('makeResult throws when nextStep is whitespace-only for manual-action-required or failed', () => {
  assert.throws(() => makeResult('manual-action-required', { reason: 'read-only DSH_HOME', nextStep: '   ' }), /non-empty 'nextStep'/)
  assert.throws(() => makeResult('failed', { reason: 'verification failed', nextStep: '\t\n' }), /non-empty 'nextStep'/)
})

test('makeResult throws its own descriptive Error (not a raw TypeError) when options is null or not an object', () => {
  assert.throws(() => makeResult('installed', null), /requires an options object/)
  assert.throws(() => makeResult('installed', 'not an object'), /requires an options object/)
  assert.throws(() => makeResult('installed', 42), /requires an options object/)
  assert.throws(() => makeResult('installed', ['reason', 'x']), /requires an options object/)
})

// --- evaluateEnvironment: fixture replay (the core acceptance criterion) ---

test('replaying the 260827 macOS fixture yields manual-action-required, not installed', () => {
  assert.equal(fixture.expectedTerminal, 'manual-action-required')
  const decision = evaluateEnvironment(fixture.environment)
  assert.ok('terminal' in decision, 'decision must be terminal, not a proceed phase')
  assert.equal(decision.terminal.state, fixture.expectedTerminal)
  assert.notEqual(decision.terminal.state, 'installed')
  // Pin the `details` shape so A3 can rely on it to render the §1 script:
  // it must carry the environment facts that decide WHICH platform/Split
  // Pane script to show, not just the writability fact that produced this
  // terminal.
  assert.deepEqual(decision.terminal.details, {
    presentationProtocol: fixture.environment.presentationProtocol,
    wantsSplitPane: fixture.environment.wantsSplitPane,
  })
})

// --- evaluateEnvironment: short-circuit rules ---

test('incompatible protocol + wantsSplitPane returns the offer-bootstrap phase, never a build/install phase', () => {
  const decision = evaluateEnvironment({
    presentationProtocol: null,
    wantsSplitPane: true,
    dshHomeWritable: true,
    artifactsVerified: true,
  })
  assert.ok('proceed' in decision, 'decision must be a non-terminal proceed phase')
  assert.equal(decision.proceed, 'generic-install-offer-bootstrap')
  assert.notEqual(decision.proceed, 'full-install')
  assert.ok(!('terminal' in decision))
})

test('incompatible protocol + generic-only proceeds to a plain generic install', () => {
  const decision = evaluateEnvironment({
    presentationProtocol: 1,
    wantsSplitPane: false,
    dshHomeWritable: true,
    artifactsVerified: true,
  })
  assert.deepEqual(decision, { proceed: 'generic-install' })
})

test('presentationProtocol as the string "2" is NOT treated as compatible (strict === 2, no coercion)', () => {
  const decision = evaluateEnvironment({
    presentationProtocol: '2',
    wantsSplitPane: true,
    dshHomeWritable: true,
    artifactsVerified: true,
  })
  assert.ok('proceed' in decision)
  assert.equal(decision.proceed, 'generic-install-offer-bootstrap')
  assert.notEqual(decision.proceed, 'full-install')
})

test('compatible protocol + writable proceeds to full-install (not yet installed)', () => {
  const decision = evaluateEnvironment({
    presentationProtocol: 2,
    wantsSplitPane: true,
    dshHomeWritable: true,
    artifactsVerified: true,
  })
  assert.deepEqual(decision, { proceed: 'full-install' })
})

test('unverified artifacts short-circuit to failed before any proceed phase, even when other fields would otherwise pass', () => {
  const decision = evaluateEnvironment({
    presentationProtocol: 2,
    wantsSplitPane: true,
    dshHomeWritable: false,
    artifactsVerified: false,
  })
  assert.ok('terminal' in decision)
  assert.equal(decision.terminal.state, 'failed')
  assert.ok(!('proceed' in decision), 'a failed verification must never leak a proceed phase')
})

// --- validateDisclosure: tasks.md §1 five hard requirements ---

const compliantDisclosure = [
  '✅ DSH Workbench 已安装完成。Navigator、快捷键等通用功能现在就可以使用。',
  '',
  'ℹ️ 分屏（双 Pane）功能当前未激活：你的官方 Harness 还不支持多 Pane 所需的接口。',
  '这不是安装出错，其余功能不受影响。',
  '',
  '如果你现在就想用分屏，可以运行下面这一条命令。它会在独立目录里构建一份带补丁的',
  'Harness 副本，与你的官方版并存——不会改动官方安装、配置或任何会话数据；不想要时',
  '删除该目录即可，官方 Harness 不受任何影响：',
  '',
  '```',
  'pwsh -File .\\dsh-workbench-bootstrap.ps1',
  '```',
].join('\n')

test('validateDisclosure accepts a compliant Chinese sample covering all five elements', () => {
  const result = validateDisclosure(compliantDisclosure)
  assert.deepEqual(result.failures, [])
  assert.equal(result.valid, true)
})

test('validateDisclosure rejects text missing the coexistence statement', () => {
  const missingCoexistence = [
    '✅ DSH Workbench 已安装完成。Navigator、快捷键等通用功能现在就可以使用。',
    '',
    'ℹ️ 分屏（双 Pane）功能当前未激活：你的官方 Harness 还不支持多 Pane 所需的接口。',
    '这不是安装出错，其余功能不受影响。',
    '',
    '如果你现在就想用分屏，可以运行下面这一条命令：',
    '',
    '```',
    'pwsh -File .\\dsh-workbench-bootstrap.ps1',
    '```',
  ].join('\n')
  const result = validateDisclosure(missingCoexistence)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 3')))
})

test('validateDisclosure rejects text containing the unfilled <BOOTSTRAP_COMMAND> placeholder', () => {
  const withPlaceholder = compliantDisclosure.replace('pwsh -File .\\dsh-workbench-bootstrap.ps1', '<BOOTSTRAP_COMMAND>')
  const result = validateDisclosure(withPlaceholder)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('<BOOTSTRAP_COMMAND>')))
})

test('validateDisclosure rejects text with zero command lines', () => {
  const withoutCommand = [
    '✅ DSH Workbench 已安装完成。Navigator、快捷键等通用功能现在就可以使用。',
    '',
    'ℹ️ 分屏（双 Pane）功能当前未激活：你的官方 Harness 还不支持多 Pane 所需的接口。',
    '这不是安装出错，其余功能不受影响。',
    '',
    '如果你现在就想用分屏，可以运行下面这一条命令。它会在独立目录里构建一份带补丁的',
    'Harness 副本，与你的官方版并存——不会改动官方安装、配置或任何会话数据；不想要时',
    '删除该目录即可，官方 Harness 不受任何影响。',
  ].join('\n')
  const result = validateDisclosure(withoutCommand)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 5')))
})

test('validateDisclosure rejects text missing requirement 1 (Split Pane inactive + reason + not-a-failure statement)', () => {
  const missingRequirement1 = compliantDisclosure
    .replace('ℹ️ 分屏（双 Pane）功能当前未激活：你的官方 Harness 还不支持多 Pane 所需的接口。', '')
    .replace('这不是安装出错，其余功能不受影响。', '')
  const result = validateDisclosure(missingRequirement1)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 1')))
})

test('validateDisclosure rejects text missing requirement 2 (other features work now statement)', () => {
  const missingRequirement2 = compliantDisclosure
    .replace('Navigator、快捷键等通用功能现在就可以使用。', 'Navigator、快捷键等通用功能已启用。')
    .replace('这不是安装出错，其余功能不受影响。', '这不是安装出错。')
  const result = validateDisclosure(missingRequirement2)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 2')))
})

test('validateDisclosure rejects text missing requirement 4 (removable without residue statement)', () => {
  const missingRequirement4 = compliantDisclosure.replace('删除该目录即可，官方 Harness 不受任何影响：', '：')
  const result = validateDisclosure(missingRequirement4)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 4')))
})

test('validateDisclosure rejects an otherwise-compliant text carrying an ambiguous "modified Harness" phrase', () => {
  const withAmbiguousPhrase = `${compliantDisclosure}\n\n本次安装对 Harness 做了一些改动。`
  const result = validateDisclosure(withAmbiguousPhrase)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('ambiguous')))
})

// P1 regression test: "不会对 Harness 做任何改动" is the natural, REQUIRED way
// to phrase requirement 3's own zero-modification statement (it is in fact
// tasks.md §1's own sample text, worded as "不会改动官方安装..."). A naive
// "对 Harness 做...改动" pattern with no negation guard used to false-positive
// on this — flagging the very statement requirement 3 mandates as the
// ambiguous claim it exists to forbid. It must PASS validation.
test('validateDisclosure does NOT flag "不会对 Harness 做任何改动" as the ambiguous modification phrase (negation-guarded false-positive fix)', () => {
  const withNegatedPhrase = `${compliantDisclosure}\n\n本次安装不会对 Harness 做任何改动。`
  const result = validateDisclosure(withNegatedPhrase)
  assert.deepEqual(result.failures, [])
  assert.equal(result.valid, true)
})

// S7 regression: "不得不" ("had no choice but to") is a double negative, not
// a real negation -- "不得不对 Harness 做了一些改动" actually ADMITS a
// modification happened. The pre-S7 regex only checked whether a bare "不"
// sat immediately before "对", so it treated this exactly like a real
// negation (e.g. "不会对...") and let the claim through unflagged. It must
// be FLAGGED (i.e. fail validation with an "ambiguous" failure), not pass.
test('validateDisclosure DOES flag "不得不对 Harness 做了一些改动" (不得不 double-negative) as the ambiguous modification phrase, unlike a real negation (S7 false-accept fix)', () => {
  const withDoubleNegative = `${compliantDisclosure}\n\n本次安装不得不对 Harness 做了一些改动。`
  const validation = validateDisclosure(withDoubleNegative)
  assert.equal(validation.valid, false)
  assert.ok(validation.failures.some(failure => failure.includes('ambiguous')), `expected an "ambiguous" failure, got: ${JSON.stringify(validation.failures)}`)
})

// S7 regression, other side of the fix: plain 不会/没有 negations, and a bare
// "不" that is NOT part of "不得不", must still be accepted exactly as
// before -- the (?<!不得) exclusion must not over-reach and start rejecting
// ordinary negated statements.
test('validateDisclosure still accepts plain 不会/没有/bare-不 negations after the S7 不得不 fix (no over-reach)', () => {
  for (const negatedPhrase of ['本次安装不会对 Harness 做任何改动。', '本次安装没有对 Harness 做任何改动。', '本次安装不对 Harness 做任何改动。']) {
    const text = `${compliantDisclosure}\n\n${negatedPhrase}`
    const validation = validateDisclosure(text)
    assert.deepEqual(validation.failures, [], `expected no failures for "${negatedPhrase}", got: ${JSON.stringify(validation.failures)}`)
    assert.equal(validation.valid, true)
  }
})

test('validateDisclosure rejects text missing only the 并存 (coexistence) conjunct of requirement 3, even with the zero-changes conjunct present', () => {
  const missingBingcunOnly = compliantDisclosure.replace('与你的官方版并存——', '与你的官方版——')
  const result = validateDisclosure(missingBingcunOnly)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 3')))
})

// P2 isolating test 1: removes ONLY requirement 3's zero-change conjunct
// (零改动|不会改动|不改动|不会修改|不改写), keeping 并存 and 官方 intact. This
// is distinct from the "missing coexistence" test above, which drops 并存
// itself — if statesCoexistence's middle conjunct were ever dropped from the
// implementation, that test would still fail correctly (par 并存 is gone
// too), silently hiding the regression. This test isolates the conjunct so a
// dropped zero-change check is caught on its own.
test('validateDisclosure rejects text missing ONLY requirement 3\'s zero-change conjunct (并存 and 官方 both remain)', () => {
  const missingZeroChangeConjunct = compliantDisclosure.replace(
    '不会改动官方安装、配置或任何会话数据',
    '对官方安装、配置或任何会话数据没有影响',
  )
  assert.ok(missingZeroChangeConjunct.includes('并存'), 'test setup: 并存 must remain present')
  assert.ok(missingZeroChangeConjunct.includes('官方'), 'test setup: 官方 must remain present')
  assert.ok(!/(零改动|不会改动|不改动|不会修改|不改写)/u.test(missingZeroChangeConjunct), 'test setup: no zero-change phrase may remain anywhere')
  const result = validateDisclosure(missingZeroChangeConjunct)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 3')))
})

// P2 isolating test 2: removes ONLY requirement 4's 删除 conjunct, keeping a
// 无残留/不受任何影响 phrase intact. The existing "missing requirement 4" test
// above removes 删除 AND 不受任何影响 together, so it would still catch a
// mutation that drops only the 删除 check (the remaining conjunct alone
// already fails on that text). This test isolates 删除 specifically.
test('validateDisclosure rejects text missing ONLY requirement 4\'s 删除 conjunct (不受任何影响 remains)', () => {
  const missingDeleteConjunct = compliantDisclosure.replace('删除该目录即可，', '')
  assert.ok(!missingDeleteConjunct.includes('删除'), 'test setup: 删除 must not appear anywhere in the sample')
  assert.ok(missingDeleteConjunct.includes('不受任何影响'), 'test setup: 不受任何影响 must remain present')
  const result = validateDisclosure(missingDeleteConjunct)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 4')))
})

// P2 isolating test 3: guards against re-adding the loose bare "不受影响"
// alternative to requirement 4 (it was deliberately excluded — see the
// comment above statesRemovable in result.mjs — because requirement 2 also
// uses bare "不受影响", so accepting it here would let requirement 4 pass
// purely on requirement 2's sentence). This sample satisfies 删除 and has
// only the loose "不受影响" (no "任何"), so it must keep failing requirement 4
// under the current, stricter implementation.
test('validateDisclosure rejects a sample that would only pass requirement 4 via the loose bare "不受影响" alternative', () => {
  const looseAlternativeOnly = compliantDisclosure.replace('官方 Harness 不受任何影响', '官方 Harness 不受影响')
  assert.ok(looseAlternativeOnly.includes('删除'), 'test setup: 删除 must remain present')
  assert.ok(!looseAlternativeOnly.includes('不受任何影响'), 'test setup: only the loose 不受影响 phrase may remain')
  assert.ok(looseAlternativeOnly.includes('不受影响'), 'test setup: the loose 不受影响 phrase must be present')
  const result = validateDisclosure(looseAlternativeOnly)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 4')))
})

// --- fixture sensitivity sweep: tasks.md A1's "zero sensitive content" acceptance ---

test('fixture file contains no sensitive path, email, or raw-commit-hash patterns', () => {
  // JSON-string-encodes a Windows path as `C:\\Users\\...` (each backslash
  // doubled), so a regex that only expects a single literal backslash never
  // matches the actual bytes on disk. Match 1 or 2 backslashes to catch both
  // a raw path and its JSON-escaped form.
  const windowsUserPath = /[A-Za-z]:\\{1,2}Users\\{1,2}/u
  const macUserPath = /\/Users\/[^/\s]+\//u
  // Reused verbatim from scripts/scan-secrets.mjs's "personal email address"
  // rule so this sweep and the repo-wide secret scan agree on what an email
  // address looks like, instead of the narrower `/@gmail/i` this test used
  // to hardcode (which would miss e.g. an @deepseek.com or @outlook.com
  // address in the fixture).
  const emailAddress = /\b[A-Z0-9._%+-]+@(?!users\.noreply\.github\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/iu
  const fortyHex = /\b[0-9a-f]{40}\b/iu

  assert.equal(windowsUserPath.test(fixtureRaw), false, 'fixture must not contain a Windows user path')
  assert.equal(macUserPath.test(fixtureRaw), false, 'fixture must not contain a real-looking macOS user path')
  assert.equal(emailAddress.test(fixtureRaw), false, 'fixture must not contain an email address')
  assert.equal(fortyHex.test(fixtureRaw), false, 'fixture must not contain a raw 40-hex commit hash')
})

// --- evaluateEnvironment: advisory `offer` (Better Sidebar consent flow) ---

test('evaluateEnvironment attaches offer: "sidebar-fork" on every proceed phase when betterSidebar is "official"', () => {
  const base = { dshHomeWritable: true, artifactsVerified: true, betterSidebar: 'official' }

  const genericOnly = evaluateEnvironment({ ...base, presentationProtocol: 1, wantsSplitPane: false })
  assert.deepEqual(genericOnly, { proceed: 'generic-install', offer: 'sidebar-fork' })

  const offerBootstrap = evaluateEnvironment({ ...base, presentationProtocol: null, wantsSplitPane: true })
  assert.deepEqual(offerBootstrap, { proceed: 'generic-install-offer-bootstrap', offer: 'sidebar-fork' })

  const fullInstall = evaluateEnvironment({ ...base, presentationProtocol: 2, wantsSplitPane: true })
  assert.deepEqual(fullInstall, { proceed: 'full-install', offer: 'sidebar-fork' })
})

test('evaluateEnvironment does NOT attach offer when betterSidebar is "none" (no upsell)', () => {
  const decision = evaluateEnvironment({
    presentationProtocol: 2, wantsSplitPane: true, dshHomeWritable: true, artifactsVerified: true, betterSidebar: 'none',
  })
  assert.deepEqual(decision, { proceed: 'full-install' })
  assert.ok(!('offer' in decision))
})

test('evaluateEnvironment does NOT attach offer when betterSidebar is "fork-compatible" (already installed, nothing to offer)', () => {
  const decision = evaluateEnvironment({
    presentationProtocol: 2, wantsSplitPane: true, dshHomeWritable: true, artifactsVerified: true, betterSidebar: 'fork-compatible',
  })
  assert.deepEqual(decision, { proceed: 'full-install' })
  assert.ok(!('offer' in decision))
})

test('evaluateEnvironment treats an absent betterSidebar field as unknown/"none" — no offer, no throw', () => {
  const decision = evaluateEnvironment({ presentationProtocol: 2, wantsSplitPane: true, dshHomeWritable: true, artifactsVerified: true })
  assert.deepEqual(decision, { proceed: 'full-install' })
  assert.ok(!('offer' in decision))
})

test('evaluateEnvironment never attaches offer to a terminal decision, even when betterSidebar is "official"', () => {
  const manualAction = evaluateEnvironment({
    presentationProtocol: null, wantsSplitPane: true, dshHomeWritable: false, artifactsVerified: true, betterSidebar: 'official',
  })
  assert.ok('terminal' in manualAction)
  assert.equal(manualAction.terminal.state, 'manual-action-required')
  assert.ok(!('offer' in manualAction), 'a terminal decision must never carry the advisory offer key')
  // The terminal outcome itself (state/reason/nextStep/details) must be
  // byte-identical to the no-betterSidebar-field case — the advisory field
  // must not leak into or alter terminal-state construction at all.
  const manualActionNoField = evaluateEnvironment({
    presentationProtocol: null, wantsSplitPane: true, dshHomeWritable: false, artifactsVerified: true,
  })
  assert.deepEqual(manualAction.terminal, manualActionNoField.terminal)

  const failed = evaluateEnvironment({
    presentationProtocol: 2, wantsSplitPane: true, dshHomeWritable: true, artifactsVerified: false, betterSidebar: 'official',
  })
  assert.ok('terminal' in failed)
  assert.equal(failed.terminal.state, 'failed')
  assert.ok(!('offer' in failed))
})

test('evaluateEnvironment tolerates an unrelated unknown field alongside betterSidebar without throwing', () => {
  assert.doesNotThrow(() => evaluateEnvironment({
    presentationProtocol: 2,
    wantsSplitPane: true,
    dshHomeWritable: true,
    artifactsVerified: true,
    betterSidebar: 'official',
    somethingFutureCallersMightAdd: { nested: true },
  }))
  const decision = evaluateEnvironment({
    presentationProtocol: 2,
    wantsSplitPane: true,
    dshHomeWritable: true,
    artifactsVerified: true,
    betterSidebar: 'official',
    somethingFutureCallersMightAdd: { nested: true },
  })
  assert.deepEqual(decision, { proceed: 'full-install', offer: 'sidebar-fork' })
})

// --- validateSidebarOffer: tasks.md §1 "Sidebar fork 征询话术"'s five hard requirements ---

// Extracted from the actual doc (not a hand-copied duplicate) so this suite
// fails loudly if the shipped tasks.md sample ever drifts from what
// validateSidebarOffer actually accepts.
const compliantSidebarOffer = extractFencedSampleAfter('**Sidebar fork 征询话术**')

test('validateSidebarOffer accepts the normative tasks.md §1 "Sidebar fork 征询话术" sample, read directly from the doc', () => {
  const result = validateSidebarOffer(compliantSidebarOffer)
  assert.deepEqual(result.failures, [])
  assert.equal(result.valid, true)
})

test('the normative sidebar offer names the CURRENT contract pin: providerVersion and the implementationCommit short sha from release-contract.json', () => {
  // validateSidebarOffer only shape-checks the version/commit (any x.y.z /
  // 7-hex passes), so this test is the doc<->contract binding: a future pin
  // advance that updates release-contract.json but forgets the consent
  // script must fail here.
  const contract = JSON.parse(readFileSync(new URL('../../release-contract.json', import.meta.url), 'utf8'))
  const pin = contract.panelCompatibility
  assert.ok(compliantSidebarOffer.includes(pin.providerVersion), `offer must name providerVersion ${pin.providerVersion}`)
  assert.ok(compliantSidebarOffer.includes(pin.implementationCommit.slice(0, 7)), `offer must name the pinned commit short sha ${pin.implementationCommit.slice(0, 7)}`)
})

test('validateSidebarOffer rejects text missing requirement 1\'s "optional" conjunct (可选), even with the untouched-if-declined conjunct present', () => {
  const missingOptional = compliantSidebarOffer.replace('这是一项可选功能升级', '这是一项功能升级')
  assert.ok(!missingOptional.includes('可选'), 'test setup: 可选 must not appear anywhere in the mutated sample')
  const result = validateSidebarOffer(missingOptional)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 1')))
})

test('validateSidebarOffer rejects text missing requirement 1\'s "untouched if declined" conjunct, even with 可选 present', () => {
  const missingUntouched = compliantSidebarOffer.replace(
    '官方 Better Sidebar 会保持原样，不会有任何改动，继续正常工作。',
    '官方 Better Sidebar 的情况这里不做进一步说明。',
  )
  assert.ok(missingUntouched.includes('可选'), 'test setup: 可选 must remain present')
  assert.ok(!/(保持原样|不受影响|不受任何改动|不会有任何改动|继续正常工作)/u.test(missingUntouched), 'test setup: no untouched-if-declined phrase may remain anywhere')
  const result = validateSidebarOffer(missingUntouched)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 1')))
})

test('validateSidebarOffer rejects text missing requirement 2\'s version number, even with commit + verification + replacement wording present', () => {
  const missingVersion = compliantSidebarOffer.replace('版本 0.16.1，提交 1685770', '提交 1685770')
  assert.ok(!/\d+\.\d+\.\d+/u.test(missingVersion), 'test setup: no version-triplet pattern may remain anywhere')
  assert.ok(missingVersion.includes('1685770'), 'test setup: the short commit must remain present')
  const result = validateSidebarOffer(missingVersion)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 2')))
})

test('validateSidebarOffer rejects text missing requirement 2\'s hash/commit-verification conjunct, even with version + commit present', () => {
  const missingVerification = compliantSidebarOffer.replace('，安装前会做哈希/提交校验', '')
  assert.ok(!/(哈希|commit|提交)[\s\S]{0,6}校验/u.test(missingVerification), 'test setup: no verification phrase may remain anywhere')
  assert.ok(missingVerification.includes('0.16.1') && missingVerification.includes('1685770'), 'test setup: version + commit must remain present')
  const result = validateSidebarOffer(missingVerification)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 2')))
})

test('validateSidebarOffer rejects text missing requirement 3\'s panel-shortcut-actions conjunct (面板快捷键), even with per-Pane panel wording present', () => {
  const missingShortcutCapability = compliantSidebarOffer.replace('面板开关动作（面板快捷键）', '面板开关动作')
  assert.ok(!missingShortcutCapability.includes('面板快捷键'), 'test setup: 面板快捷键 must not appear anywhere in the mutated sample')
  assert.ok(/每\s*个?\s*Pane[\s\S]{0,10}(独立|面板)/u.test(missingShortcutCapability), 'test setup: per-Pane panel wording must remain present')
  const result = validateSidebarOffer(missingShortcutCapability)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 3')))
})

test('validateSidebarOffer rejects text missing requirement 4\'s explicit 要/不要 consent question (a lone "？" with no 要...不要 framing does not satisfy it)', () => {
  const missingConsentQuestion = compliantSidebarOffer.replace(
    '要不要现在安装这个 fork？',
    '现在安装这个 fork？',
  )
  const result = validateSidebarOffer(missingConsentQuestion)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 4')))
  // Isolation check: exactly one "？" still remains, so this failure is
  // attributable to requirement 4 alone, not a requirement-5 question-count
  // side effect.
  assert.equal((missingConsentQuestion.match(/？/gu) ?? []).length, 1)
})

test('validateSidebarOffer rejects an otherwise-compliant text carrying imperative auto-action wording ("将自动...")', () => {
  const withImperativeWording = `${compliantSidebarOffer}\n\n本次将自动为你安装。`
  const result = validateSidebarOffer(withImperativeWording)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('imperative auto-action')))
})

test('validateSidebarOffer rejects text with a bundled command mixed into the consent ask (requirement 5)', () => {
  const withBundledCommand = `${compliantSidebarOffer}\n\n\`\`\`\npwsh -File .\\dsh-workbench-bootstrap.ps1\n\`\`\``
  const result = validateSidebarOffer(withBundledCommand)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('bundled command')))
})

test('validateSidebarOffer rejects text with zero confirm-questions (requirement 5)', () => {
  const withoutQuestion = compliantSidebarOffer.replace(
    '要不要现在安装这个 fork？请回答"要"或"不要"——不回答同样视为"不要"，不会执行任何安装。',
    '是否安装由你自行决定。',
  )
  assert.equal((withoutQuestion.match(/？/gu) ?? []).length, 0)
  const result = validateSidebarOffer(withoutQuestion)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 5')))
})

test('validateSidebarOffer rejects text with two confirm-questions (requirement 5, "exactly one")', () => {
  const withTwoQuestions = `${compliantSidebarOffer}\n\n真的确定吗？`
  assert.equal((withTwoQuestions.match(/？/gu) ?? []).length, 2)
  const result = validateSidebarOffer(withTwoQuestions)
  assert.equal(result.valid, false)
  assert.ok(result.failures.some(failure => failure.includes('requirement 5')))
})

test('validateSidebarOffer rejects empty text', () => {
  assert.deepEqual(validateSidebarOffer(''), { valid: false, failures: ['text is empty'] })
  assert.deepEqual(validateSidebarOffer('   '), { valid: false, failures: ['text is empty'] })
})
