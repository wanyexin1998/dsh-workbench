#!/usr/bin/env node
// Tests for the release-gate secret scanner (scripts/scan-secrets.mjs).
// Run with: node --test scripts/scan-secrets.test.mjs
//
// Why this file exists: the gate only ever runs the scanner against THIS
// repository, and this repository by definition contains no secrets. So a
// green gate proves the walker terminates, and nothing whatsoever about the
// rules -- a rule can be deleted, or silently widened into a false negative,
// and the gate stays green. Every rule therefore gets a matched pair here:
// a realistic leak that MUST be reported, and an adjacent shape that MUST
// NOT be, so neither a deletion nor a cry-wolf widening can pass unnoticed.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findMatches, rules } from './scan-secrets.mjs'

// Every sample below is assembled at run time instead of being written as a
// literal, because this test file is itself walked by
// `node scripts/scan-secrets.mjs`. A literal secret-shaped string here would
// fail the very gate these tests defend.
const SEP = '\\'
/** A drive-rooted user home, in the plain single-separator spelling. */
const winPath = tail => `C:${SEP}Users${SEP}${tail}`
/** The JSON/JS-escaped spelling of the same home, with doubled separators. */
const winPathEscaped = tail => `C:${SEP}${SEP}Users${SEP}${SEP}${tail}`
const USERS_ROOT = '/Users/'
const HOME_ROOT = '/home/'
const macPath = tail => USERS_ROOT + tail
const linuxPath = tail => HOME_ROOT + tail
/** A `<secret-shaped name> = "<value>"` binding, the shape the keyed rule hunts. */
const keyed = (name, value) => `${name} = "${value}"`
/** A vendor-prefixed token of a given body length. */
const token = (prefix, length, char = 'a') => prefix + char.repeat(length)
/** A PEM banner, split so the banner itself never appears literally here. */
const pem = kind => ['-----BEGIN', kind, 'KEY-----'].join(' ')
const address = (local, domain) => [local, domain].join('@')

// A full Git commit SHA. This repository pins commits by full SHA in tracked
// files, which is exactly why the bare-40-hex rule was rejected; the reverse
// guarantee at the bottom of this file locks that decision in.
const COMMIT_SHA = '0f3a1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c'

/**
 * One rule, its must-report samples, and its must-not-report samples.
 * `label` must match a label in the scanner's rule table exactly; the
 * coverage test at the bottom enforces that this list and the rule table
 * stay in one-to-one correspondence, so a newly added rule cannot ship
 * without a pair of cases.
 * @type {{ label: string, hits: string[], misses: string[] }[]}
 */
const cases = [
  {
    label: 'private key',
    hits: [pem('PRIVATE'), pem('RSA PRIVATE'), pem('OPENSSH PRIVATE')],
    misses: [pem('PUBLIC'), '-----BEGIN CERTIFICATE-----', 'PRIVATE KEY'],
  },
  {
    label: 'GitHub token',
    hits: [
      token('ghp_', 36),
      token('gho_', 36),
      token('ghu_', 36),
      token('ghs_', 36),
      token('ghr_', 36),
    ],
    misses: [
      // Unknown two-letter prefix: not a GitHub token shape.
      token('ghz_', 36),
      // Too short to be a real token.
      token('ghp_', 12),
    ],
  },
  {
    label: 'GitHub fine-grained token',
    hits: [token('github_pat_', 44)],
    misses: [token('github_pat_', 20)],
  },
  {
    label: 'AWS access key',
    hits: [token('AKIA', 16, 'A'), `AKIA${'A'.repeat(12)}${'0'.repeat(4)}`],
    misses: [
      // Too short.
      token('AKIA', 10, 'A'),
      // The rule is deliberately case-sensitive; lowercase is not the shape.
      token('akia', 16, 'a'),
    ],
  },
  {
    label: 'OpenAI-style secret',
    hits: [token('sk-', 32), token('sk-proj-', 32)],
    misses: [token('sk-', 12), 'sk-learn'],
  },
  {
    label: 'npm token',
    hits: [token('npm_', 36)],
    misses: [
      // Too short for the fixed 36-character body.
      token('npm_', 20),
      // A package name, not a token.
      'npm_config_registry',
    ],
  },
  {
    label: 'keyed high-entropy secret',
    hits: [
      keyed('apiKey', COMMIT_SHA),
      keyed('client_secret', 'aGVsbG8xMjM0NTY3ODkwYWJj'),
      keyed('AUTH_TOKEN', 'Zm9vYmFyMTIzNDU2Nzg5MGFi'),
    ],
    misses: [
      // A word-shaped placeholder: no digit anywhere in the value.
      keyed('apiKey', 'YOUR_API_KEY_HERE'),
      // Digits present, but `_` is outside the value charset, so no run
      // reaches the 20-character minimum.
      keyed('apiKey', 'PLACEHOLDER_VALUE_12345'),
      keyed('api-key', 'your-api-key-1234'),
      // A non-secret key bound to a high-entropy value stays quiet.
      keyed('implementationCommit', COMMIT_SHA),
    ],
  },
  {
    label: 'personal Windows path',
    hits: [
      winPath('wanyexin\\AppData\\Local\\'),
      // The bare-home form, terminated by end of line rather than a separator.
      winPath('wanyexin'),
      // The JSON/JS-escaped spelling of the same home.
      winPathEscaped('wanyexin\\AppData\\'),
      // Regression guard. `Public` used to be exempted with `\b`, which
      // matches before ANY non-word character, so every personal home whose
      // name merely STARTS with `Public` slipped through the gate. The
      // exemption must anchor on the end of the segment instead.
      winPath('Public.old\\stuff\\'),
      winPath('Public-Kiosk\\stuff\\'),
      winPath('Publisher\\projects\\'),
    ],
    misses: [
      // The genuine shared-public tree carries no identity.
      winPath('Public\\Desktop\\'),
      winPathEscaped('Public\\\\Desktop\\\\'),
      winPath('Public'),
      // `...` is the universal redaction marker; the identity is gone.
      winPath('...\\AppData\\'),
      // Not a home directory at all.
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\dsh-workbench\\',
    ],
  },
  {
    label: 'personal macOS path',
    hits: [macPath('alice/Library/'), macPath('wanyexin/dsh-workbench/')],
    misses: [
      // The bare root, the form documentation uses as a placeholder.
      USERS_ROOT,
      '/usr/local/share/',
      '/Volumes/Data/',
    ],
  },
  {
    label: 'personal Linux path',
    hits: [
      linuxPath('wanyexin/dsh-workbench/'),
      linuxPath('alice/.config/'),
      // The CI exemption is segment-anchored: `runners` is not `runner`.
      linuxPath('runners/build/'),
    ],
    misses: [
      // Fixed service accounts on CI runners and in containers. These are
      // roles, not people, and they turn up in exactly the material a
      // release gate reads (workflow logs, Dockerfiles, devcontainer
      // configs, shell transcripts pasted into docs).
      linuxPath('runner/work/dsh-workbench/'),
      linuxPath('node/app/'),
      linuxPath('vscode/.cache/'),
      linuxPath('ubuntu/repo/'),
      linuxPath('user/project/'),
      // A one-character home is a synthetic test fixture, not an account.
      linuxPath('u/workspace/'),
    ],
  },
  {
    label: 'personal email address',
    hits: [
      address('jane.doe', 'example.com'),
      address('wanyexin1998', 'gmail.com'),
    ],
    misses: [
      // GitHub's privacy-preserving commit address carries no real mailbox.
      address('12345+wanyexin1998', 'users.noreply.github.com'),
      // No domain, so no address.
      'reply to jane.doe at example',
    ],
  },
]

for (const { label, hits, misses } of cases) {
  for (const sample of hits) {
    test(`${label} reports ${JSON.stringify(sample)}`, () => {
      assert.ok(
        findMatches(sample).includes(label),
        `expected rule "${label}" to fire; findMatches returned ${JSON.stringify(findMatches(sample))}`,
      )
    })
  }
  for (const sample of misses) {
    test(`${label} stays quiet on ${JSON.stringify(sample)}`, () => {
      assert.ok(
        !findMatches(sample).includes(label),
        `expected rule "${label}" NOT to fire on a benign sample`,
      )
    })
  }
}

// --- Coverage: the case table and the rule table must stay in lockstep ---

test('every scanner rule has both a positive and a negative case', () => {
  const ruleLabels = rules.map(([label]) => label)
  assert.deepEqual(
    [...ruleLabels].sort(),
    cases.map(entry => entry.label).sort(),
    'a rule was added or removed without updating this test file',
  )
  assert.equal(new Set(ruleLabels).size, ruleLabels.length, 'rule labels must be unique')
  for (const { label, hits, misses } of cases) {
    assert.ok(hits.length > 0, `rule "${label}" has no must-report sample`)
    assert.ok(misses.length > 0, `rule "${label}" has no must-not-report sample`)
  }
})

// --- Reverse guarantees: shapes this repository legitimately contains ---

test('a bare 40-hex commit sha is not treated as a secret', () => {
  assert.deepEqual(findMatches(COMMIT_SHA), [])
  assert.deepEqual(findMatches(`"implementationCommit": "${COMMIT_SHA}"`), [])
  assert.deepEqual(findMatches(`git checkout --detach ${COMMIT_SHA}`), [])
})

test('ordinary prose and repository paths produce no findings', () => {
  assert.deepEqual(findMatches('The Workbench pins protocol 2 and a visible capacity of 2.'), [])
  assert.deepEqual(findMatches('packages/dsh-workbench/src/client/guard.ts'), [])
  assert.deepEqual(findMatches(''), [])
})

test('findMatches reports every rule that fires, in rule-table order', () => {
  const both = `${winPath('wanyexin\\AppData\\')} ${address('jane.doe', 'example.com')}`
  assert.deepEqual(findMatches(both), ['personal Windows path', 'personal email address'])
})
