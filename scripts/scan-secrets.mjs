#!/usr/bin/env node
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const includeBuild = process.argv.includes('--include-build')
const excluded = new Set(['.git', 'node_modules', 'dist', 'coverage', '.artifacts'])
if (!includeBuild) excluded.add('lib')
const findings = []
const rules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/u],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/u],
  ['OpenAI-style secret', /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/u],
  ['personal Windows path', /[A-Za-z]:\\Users\\(?!Public\\)[^\\\s]+\\/u],
  ['personal macOS path', /\/Users\/[^/\s]+\//u],
  ['personal email address', /\b[A-Z0-9._%+-]+@(?!users\.noreply\.github\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
]

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
    for (const [label, pattern] of rules) {
      if (pattern.test(text)) findings.push(`${relative(root, path)}: ${label}`)
    }
  }
}

visit(root)
if (findings.length > 0) {
  console.error(`High-confidence secret/privacy scan failed:\n${findings.join('\n')}`)
  process.exit(1)
}
console.log('High-confidence secret/privacy scan passed.')
