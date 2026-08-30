#!/usr/bin/env node
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const includeBuild = process.argv.includes('--include-build')
const excluded = new Set(['.git', 'node_modules', 'dist', 'coverage', '.artifacts'])
if (!includeBuild) excluded.add('lib')
const findings = []

// Every rule here must stay HIGH-CONFIDENCE: it runs as a release gate, so a
// rule that cries wolf gets the whole gate ignored. Two shapes were evaluated
// and deliberately REJECTED for that reason, both recorded here so they are
// not "fixed" again by the next reader:
//
//   * A bare 40-hex secret (/\b[0-9a-f]{40}\b/). This repository pins Git
//     commits by full SHA in 15 tracked files (release-contract.json, both
//     bootstrap scripts, docs/INSTALL.md, docs/ACTIONS_API.md, ADRs, plan
//     reports), so the rule fires on all of them and can never pass. The
//     realistic slice of it -- a 40-hex value bound to a secret-shaped name
//     -- is covered by the `keyed high-entropy secret` rule below instead.
//   * Any absolute Windows path (/[A-Za-z]:\\[^\\\s]+\\/). It matches the
//     documented placeholders in docs/INSTALL.md (`C:\dsh-workbench\`,
//     `C:\absolute\path\to\...`), the real Git-for-Windows install root this
//     repo's own test suite probes for (`C:\Program Files\Git\bin\bash.exe`),
//     and byte noise inside docs/assets/*.png, which this scanner reads as
//     UTF-8. Personal-path coverage is therefore kept to the user-home
//     shapes below, which carry the identity.
export const rules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/u],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/u],
  ['OpenAI-style secret', /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/u],
  // npm registry auth token, the shape an `.npmrc` `_authToken=` carries.
  // This repo packs and installs TGZs, so a stray `.npmrc` is plausible.
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/u],
  // A secret-shaped name bound to a quoted, non-placeholder value. This is
  // the deliberately narrow stand-in for the rejected bare-40-hex rule: a
  // 40-hex string means nothing on its own, but one bound to `apiKey` does.
  // Two guards keep it high-confidence, and both work without a
  // case-sensitive assertion (the `i` flag folds character classes, so a
  // "must contain a lowercase letter" test would be a no-op here):
  //   * The value must contain a digit, which no word-shaped placeholder
  //     such as `YOUR_API_KEY_HERE` or `changeme` does.
  //   * The value charset excludes `_` and `-`, so the placeholders that DO
  //     carry a digit (`PLACEHOLDER_VALUE_12345`, `your-api-key-1234`) break
  //     into runs too short to reach the 20-character minimum. The cost is
  //     that a bespoke underscore-bearing token is missed; the vendor
  //     prefixes above already cover the ones that matter here.
  [
    'keyed high-entropy secret',
    /(?:secret|password|passwd|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)["']?\s*[:=]\s*["'`](?=[A-Za-z0-9+/=]*\d)[A-Za-z0-9+/=]{20,}["'`]/iu,
  ],
  // A personal Windows home, i.e. <drive>:\Users\<name>. Three widenings
  // over the separator-terminated original, each needed for a shape that
  // actually leaks:
  //   * The trailing separator is no longer required. The leaky form is
  //     usually a bare home path ending a line or closed by a quote,
  //     backtick, or bracket, which the old rule walked straight past.
  //   * A doubled backslash run is accepted, so the JSON/JS-escaped
  //     spelling of the same path is caught too.
  //   * The lookahead now also skips an elided `...` segment, the universal
  //     redaction marker (it carries no identity, and both this repo's
  //     docs and scripts/install/result.test.mjs write the escaped form
  //     that way when documenting the shape).
  // The terminator set deliberately excludes whitespace: that is what keeps
  // docs/INSTALL.md's `Jane Doe` home placeholder out of the findings.
  // The `Public` exemption must anchor on the END of that segment, i.e. a
  // path separator or the end of the line. A `\b` there would also exempt
  // every personal home whose name merely STARTS with `Public` -- a
  // `Public.old` or `Public-Kiosk` home -- because `\b` matches before ANY
  // non-word character. That is a false negative in a release gate, and it
  // is pinned by scripts/scan-secrets.test.mjs.
  ['personal Windows path', /[A-Za-z]:\\{1,2}Users\\{1,2}(?!Public(?:\\|$)|\.{3})[^\\\s]+(?:\\|["'`)\]}>,;:]|\r?$)/mu],
  ['personal macOS path', /\/Users\/[^/\s]+\//u],
  // A personal Linux/WSL home. The two-character minimum is a concession:
  // this repo's own unit tests use `/home/u/...` as a synthetic workspace
  // path, and a one-character home directory is a fixture, not an account.
  // The excluded names are the standard CI-runner, container and
  // documentation home directories. They are fixed service accounts, not
  // people, so they carry no identity -- and they appear in exactly the
  // material a release gate reads (workflow logs, Dockerfiles, devcontainer
  // configs, shell transcripts pasted into docs). Flagging them would be the
  // cry-wolf failure this rule table opens by rejecting.
  [
    'personal Linux path',
    /\/home\/(?!(?:runner|node|vscode|ubuntu|user|admin|circleci|jenkins|gitpod|codespace|devcontainer|container|linuxbrew)\/)[^/\s]{2,}\//u,
  ],
  ['personal email address', /\b[A-Z0-9._%+-]+@(?!users\.noreply\.github\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
]

/**
 * Labels of every rule that fires on `text`, in rule-table order. This is the
 * whole detection path, split out as a pure function so the rules can be unit
 * tested (scripts/scan-secrets.test.mjs) -- scanning this repository proves
 * nothing about them, because this repository by definition holds no secrets.
 * @param {string} text
 * @returns {string[]}
 */
export function findMatches(text) {
  const labels = []
  for (const [label, pattern] of rules) {
    if (pattern.test(text)) labels.push(label)
  }
  return labels
}

function visit(directory) {
  for (const name of readdirSync(directory)) {
    if (excluded.has(name)) continue
    const path = join(directory, name)
    const entry = lstatSync(path)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      visit(path)
      continue
    }
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    for (const label of findMatches(text)) findings.push(`${relative(root, path)}: ${label}`)
  }
}

// Scan only when run as a CLI. The unit tests import this module for its rule
// table, and importing must not walk the tree or exit the process.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  visit(root)
  if (findings.length > 0) {
    console.error(`High-confidence secret/privacy scan failed:\n${findings.join('\n')}`)
    process.exit(1)
  }
  console.log('High-confidence secret/privacy scan passed.')
}
