#!/usr/bin/env node
// Machine-readable install result contract for the DSH Workbench installer.
//
// Background: a real macOS install test (see
// plans/260827-real-user-install-review/task_plan.md §2) built TGZ artifacts,
// ran the full test suite, but never reached a declared terminal state — the
// stock Harness lacked Session Presentation protocol 2 and the sandbox could
// not write to the user's DSH_HOME, so the flow ended in a manual command
// with no machine-readable signal that installation had NOT completed.
//
// This module gives the upcoming bootstrap script (A3, plans/260827-workbench-v2/tasks.md §3)
// a single source of truth for: (1) what a terminal outcome looks like, (2)
// how environment facts map onto that outcome (task_plan.md §4.2's state
// machine), and (3) whether a stock-install disclosure message meets the
// five hard requirements in tasks.md §1.

/**
 * The four terminal states an install attempt can end in. Any Workbench
 * installer flow (A3 and beyond) MUST end in exactly one of these — never in
 * a silent "build succeeded" message with no declared state.
 *
 * - `installed`: the plugin was written to a writable DSH_HOME AND a
 *   post-install load verification succeeded.
 * - `manual-action-required`: the agent could not act further (e.g. a
 *   read-only DSH_HOME) and instead prepared a single command for the user
 *   to run themselves.
 * - `incompatible`: the target Harness cannot run this install at all
 *   (reserved for gates outside {@link evaluateEnvironment}'s scope, e.g. an
 *   unsupported major Harness version; the protocol-2/Split-Pane gate on its
 *   own is NOT incompatibility — the generic plugin still installs).
 * - `failed`: verification or another step failed outright; nothing further
 *   should have been attempted after this point.
 *
 * @type {ReadonlySet<'installed' | 'manual-action-required' | 'incompatible' | 'failed'>}
 */
export const TERMINAL_STATES = new Set(['installed', 'manual-action-required', 'incompatible', 'failed'])

// States where the user cannot simply "try again" — they need one concrete
// next action, so `nextStep` (the single command to show) is mandatory.
const STATES_REQUIRING_NEXT_STEP = new Set(['manual-action-required', 'failed'])

/**
 * @typedef {Object} InstallResult
 * @property {'installed'|'manual-action-required'|'incompatible'|'failed'} state Terminal state.
 * @property {string} reason Human-readable reason this state was reached. Always present.
 * @property {string|null} nextStep The single next command/action to show the user.
 *   Required (non-empty) for `manual-action-required` and `failed`; `null` otherwise.
 * @property {*} details Optional free-form machine-readable context (e.g. an
 *   environment snapshot or a verification hash). Defaults to `null`. NOTE:
 *   {@link makeResult}'s `Object.freeze` is shallow — it freezes the
 *   top-level `InstallResult` object, not `details` itself. `details` is
 *   whatever object the caller passed in (by reference, not cloned); its
 *   contents remain mutable and are the caller's responsibility to treat as
 *   read-only if that matters to them.
 * @property {1} schema Contract schema version, for forward compatibility.
 */

/**
 * Construct a validated, frozen {@link InstallResult}.
 *
 * Throws synchronously (never returns a partially-invalid object) when:
 * - `state` is not one of {@link TERMINAL_STATES};
 * - `options` is not a plain object (e.g. `null`, a string, an array);
 * - `reason` is missing or an empty string;
 * - `state` is `manual-action-required` or `failed` and `nextStep` is missing
 *   or an empty string (these states must always carry the single command to
 *   show — this is the fix for the real install test ending in an
 *   undeclared, ad-hoc manual command).
 *
 * @param {'installed'|'manual-action-required'|'incompatible'|'failed'} state
 * @param {{ reason: string, nextStep?: string|null, details?: * }} options
 * @returns {InstallResult}
 */
export function makeResult(state, options = {}) {
  if (!TERMINAL_STATES.has(state)) {
    throw new Error(`Unknown install result state: ${JSON.stringify(state)}. Expected one of: ${[...TERMINAL_STATES].join(', ')}.`)
  }

  // Guard against an explicit null/non-object `options` (the `= {}` default
  // only covers `undefined`) so callers get this contract's own descriptive
  // Error instead of a raw "Cannot destructure property 'reason' of ..."
  // TypeError from the destructure below.
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error(`Install result state '${state}' requires an options object (got ${JSON.stringify(options)}).`)
  }

  const { reason, nextStep = null, details = null } = options

  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error(`Install result state '${state}' requires a non-empty 'reason'.`)
  }

  if (STATES_REQUIRING_NEXT_STEP.has(state) && (typeof nextStep !== 'string' || nextStep.trim() === '')) {
    throw new Error(`Install result state '${state}' requires a non-empty 'nextStep' (the single command to show the user).`)
  }

  // `Object.freeze` here is shallow: it locks `state`/`reason`/`nextStep`/
  // `details`/`schema` as own properties of the returned object, but does
  // NOT deep-freeze `details` itself. `details` is stored by reference
  // exactly as the caller passed it in — its contents are caller-owned and
  // remain mutable; this function makes no copy and enforces no immutability
  // on them.
  return Object.freeze({ state, reason, nextStep, details, schema: 1 })
}

/**
 * The environment facts {@link evaluateEnvironment} decides on. All fields
 * are plain booleans/primitives so a caller (a real installer, or a replayed
 * fixture) can construct this from observed facts with no hidden state.
 *
 * @typedef {Object} InstallEnvironment
 * @property {number|null} presentationProtocol The Session Presentation
 *   protocol number the target Harness implements, or `null` when it could
 *   not be detected / is absent. Compatible with Split Pane only when
 *   exactly `2`.
 * @property {boolean} wantsSplitPane Whether the user asked for Split Pane,
 *   as opposed to only the generic Workbench features (Navigator, shortcuts).
 * @property {boolean} dshHomeWritable Whether the agent/sandbox can write to
 *   the resolved target `DSH_HOME` (e.g. `~/.dsh/profiles/<profile>`).
 * @property {boolean} artifactsVerified Whether the release artifact (TGZ +
 *   SHA256SUMS + release-contract.json commit pin) has already passed source
 *   verification. This must be checked BEFORE this function is called for
 *   anything that reads as "verified" — evaluateEnvironment does not itself
 *   verify anything, it only enforces that unverified artifacts never
 *   proceed.
 */

/**
 * Non-terminal decision: proceed to one of these installer phases. Reaching
 * a phase is NOT the same as reaching `installed` — in particular
 * `full-install` only becomes the `installed` terminal state after the
 * caller performs a real post-install load verification (this function
 * cannot know that from environment facts alone).
 *
 * - `generic-install`: install the stock-compatible plugin only. Split Pane
 *   stays inactive; the user did not ask for it (or protocol is fine but
 *   this phase is unreachable when compatible — see the compatible branch).
 * - `generic-install-offer-bootstrap`: same generic install, but the user
 *   DID ask for Split Pane and the Harness is incompatible. The generic
 *   install still proceeds and Split Pane still never activates; the caller
 *   should additionally surface the bootstrap disclosure (tasks.md §1) so
 *   the user knows a parallel bootstrap path exists.
 * - `full-install`: protocol is compatible (`=== 2`) and the target is
 *   writable — proceed to install everything, then verify load before
 *   declaring `installed`.
 *
 * @typedef {'generic-install' | 'generic-install-offer-bootstrap' | 'full-install'} InstallPhase
 */

/**
 * @typedef {{ terminal: InstallResult }} TerminalDecision
 * @typedef {{ proceed: InstallPhase }} ProceedDecision
 * @typedef {TerminalDecision | ProceedDecision} EnvironmentDecision
 */

/**
 * Pure short-circuit evaluator encoding task_plan.md §4.2's install state
 * machine. Given environment facts, decide either a terminal
 * {@link InstallResult} or a non-terminal phase for the caller (A3) to act
 * on next. Never performs I/O, never mutates `env`.
 *
 * Evaluation order (first match wins; later checks never run once one
 * fires — this IS the short-circuit contract):
 *
 * 1. `!artifactsVerified` → terminal `failed`. Unverified artifacts must
 *    never lead to any build or install action, full stop, regardless of
 *    every other field.
 * 2. `!dshHomeWritable` → terminal `manual-action-required`. A read-only
 *    target blocks ANY on-disk install — generic or full, Split-Pane-wanted
 *    or not — so this precondition is checked before the compatibility
 *    branch below. (This ordering is deliberate and differs from the
 *    narrative order in tasks.md §3 A1's prose, which lists the
 *    protocol/Split-Pane rule first; the replayed fixture in
 *    `fixtures/260827-macos-replay.json` — protocol incompatible AND
 *    Split-Pane wanted AND DSH_HOME not writable — is the acceptance test
 *    that pins this precedence: it must resolve to
 *    `manual-action-required`, not to an `offer-bootstrap` directive that
 *    then goes unresolved.)
 * 3. Else, branch on `presentationProtocol === 2` ("compatible"):
 *    - incompatible + `wantsSplitPane` → non-terminal
 *      `{ proceed: 'generic-install-offer-bootstrap' }`.
 *    - incompatible + generic-only → non-terminal `{ proceed: 'generic-install' }`.
 *    - compatible → non-terminal `{ proceed: 'full-install' }` (becomes the
 *      `installed` terminal only after the caller's own load verification).
 *
 * @param {InstallEnvironment} env
 * @returns {EnvironmentDecision}
 */
export function evaluateEnvironment(env) {
  const { presentationProtocol, wantsSplitPane, dshHomeWritable, artifactsVerified } = env

  // Rule 1: unverified artifacts never proceed to any build/install action.
  if (!artifactsVerified) {
    return {
      terminal: makeResult('failed', {
        reason: 'Release artifacts failed source/hash verification before any build or install step.',
        nextStep: 'Re-download the release artifact and re-verify it against SHA256SUMS and release-contract.json before retrying.',
      }),
    }
  }

  // Rule 2: an unwritable DSH_HOME blocks any on-disk install, independent
  // of protocol compatibility or the user's Split Pane preference.
  if (!dshHomeWritable) {
    return {
      terminal: makeResult('manual-action-required', {
        reason: 'The sandbox cannot write to the target DSH_HOME; installation cannot proceed automatically.',
        nextStep: 'Run the single trusted install command yourself, from a terminal with write access to DSH_HOME.',
        // Carried through so the caller (A3) can render the correct §1
        // disclosure script for this environment: which platform's
        // bootstrap command to show, and whether Split Pane was even
        // requested (Split Pane incompatibility is a separate, orthogonal
        // fact from the writability failure that produced this terminal).
        details: { presentationProtocol, wantsSplitPane },
      }),
    }
  }

  const compatible = presentationProtocol === 2

  if (!compatible) {
    return wantsSplitPane
      ? { proceed: 'generic-install-offer-bootstrap' }
      : { proceed: 'generic-install' }
  }

  return { proceed: 'full-install' }
}

// --- Post-install disclosure gate (tasks.md §1's five hard requirements) ---

/**
 * @typedef {Object} DisclosureValidation
 * @property {boolean} valid True only when all five requirements pass.
 * @property {string[]} failures Human-readable labels of failed requirements, empty when valid.
 */

// Ambiguous phrasing that could be misread as "we modified the official
// Harness install" — tasks.md §1 requirement 3 explicitly forbids this even
// when a correct coexistence statement is also present.
//
// The 做...改动 pattern is checked separately, with an extra negation guard
// (see `hasAmbiguousHarnessModificationPhrase` below): "不会对 Harness 做任何
// 改动" is the natural, REQUIRED way to phrase requirement 3's own
// zero-modification statement, and must not be flagged as the ambiguous
// claim it exists to catch.
//
// The filler class between 做 and 改动 excludes punctuation (，。；、,.;) so
// the match cannot run across a sentence boundary — e.g. two unrelated
// clauses "...做了准备。改动..." must not be stitched into one false match.
const AMBIGUOUS_HARNESS_DUI_ZUO_PATTERN = /对\s*Harness\s*做[^\n，。；、,.;]{0,6}改动/gu
const AMBIGUOUS_OFFICIAL_MODIFICATION_PATTERNS = [
  /修改\s*(了\s*)?官方\s*Harness/u,
  /改动\s*(了\s*)?官方\s*Harness/u,
]

// A negation token (不会/没有/不) directly preceding "对" (optionally with
// whitespace between them) turns "对 Harness 做...改动" from an ambiguous
// claim of modification into a statement that no modification happened —
// exactly what requirement 3 requires. Only a negation IMMEDIATELY before 对
// is recognized; see the false-reject note in validateDisclosure's Known
// limits below.
//
// S7 修正（负负得正 / double-negative guard）：裸的"不"不能无条件当作否定词
// ——"不得不对 Harness 做了一些改动"（"不得不"= 迫不得已，双重否定表肯定，
// 实际语义是"确实做了改动"）末尾的"不"紧邻"对"，旧写法会误判为"未改动"而
// 放行这句真正承认改动的话。用 `(?<!不得)不` 排除被"不得"吃掉的"不"，其余
// 场景（如单纯的"不对 Harness 做改动"）不受影响，"不会"/"没有" 两个分支也
// 完全不受影响。
const NEGATION_IMMEDIATELY_BEFORE_DUI = /(?:不会|没有|(?<!不得)不)\s*$/u

/**
 * True when `text` contains the ambiguous "modified the official Harness"
 * phrasing tasks.md §1 requirement 3 forbids, applying the negation guard to
 * the 做...改动 pattern before falling back to the other fixed patterns.
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasAmbiguousHarnessModificationPhrase(text) {
  for (const match of text.matchAll(AMBIGUOUS_HARNESS_DUI_ZUO_PATTERN)) {
    const precedingText = text.slice(0, match.index)
    if (NEGATION_IMMEDIATELY_BEFORE_DUI.test(precedingText)) continue
    return true
  }
  return AMBIGUOUS_OFFICIAL_MODIFICATION_PATTERNS.some(pattern => pattern.test(text))
}

/**
 * Heuristic validator for the post-install disclosure text defined in
 * tasks.md §1. Checks the five hard requirements with plain substring/regex
 * matching — it does NOT understand meaning, so a text can defeat it by
 * using the right keywords in an unrelated or negated sentence, or pass by
 * accident if it happens to contain the right substrings out of context.
 * Treat this as a fast pre-check, not a substitute for human review of the
 * actual product copy that ships in P05's bilingual dictionary.
 *
 * Known limits (documented, not fixed by this heuristic):
 * - Tuned primarily for the normative Chinese text in tasks.md §1; the
 *   English counterpart (produced by P05) will need its own patterns or a
 *   locale-aware variant of this function.
 * - Cannot verify the command inside the single fenced block is actually
 *   correct or safe — only that exactly one non-empty, non-placeholder
 *   command line exists.
 * - Negation-blind: e.g. "分屏功能未激活" is required, but a sentence like
 *   "分屏功能并非未激活" would still match the same substring.
 * - The requirement-3 ambiguous-modification guard (做...改动) only
 *   recognizes a negation (不会/没有/不, with 不 itself excluded when it is
 *   part of 不得不 — see S7 below) IMMEDIATELY before 对; a negation
 *   separated by more words (e.g. "确实不会，对 Harness 做了一些改动") is not
 *   recognized and the text is still (over-cautiously) flagged as ambiguous.
 *   That specific limitation is false-reject only (can make validateDisclosure
 *   too strict there). It is NOT a blanket guarantee, though: this is
 *   substring/regex matching, not semantic understanding, so a double
 *   negative or other negation-adjacent construction this function does not
 *   special-case could still cause a false accept. One such case (不得不,
 *   "had no choice but to" — a double negative that is NOT a real negation,
 *   e.g. "不得不对 Harness 做了一些改动") is fixed as of S7 by excluding a 不
 *   preceded by 得 from the negation match; other unanticipated
 *   negation-adjacent phrasings are not guaranteed to be caught.
 *
 * @param {string} text
 * @returns {DisclosureValidation}
 */
export function validateDisclosure(text) {
  const failures = []

  if (typeof text !== 'string' || text.trim() === '') {
    return { valid: false, failures: ['text is empty'] }
  }

  // Requirement 1: Split Pane inactive + reason (official interface
  // missing), and this is explicitly NOT an install failure.
  const statesInactive = /分屏[\s\S]{0,20}未激活/u.test(text)
  const statesReason = /(接口|protocol|不支持)/iu.test(text)
  const statesNotFailure = /不是安装(出错|失败)/u.test(text)
  if (!(statesInactive && statesReason && statesNotFailure)) {
    failures.push('missing requirement 1: Split Pane inactive + reason + "not an install failure" statement')
  }

  // Requirement 2: other features work now.
  const statesOtherFeaturesWork = /(现在就可以使用|现在可用|其余功能[\s\S]{0,10}不受影响)/u.test(text)
  if (!statesOtherFeaturesWork) {
    failures.push('missing requirement 2: "other features work now" statement')
  }

  // Requirement 3: parallel coexistence with zero changes to the official
  // install/config/session, and no ambiguous "modified the official Harness" phrasing.
  const statesCoexistence = /并存/u.test(text)
    && /(零改动|不会改动|不改动|不会修改|不改写)/u.test(text)
    && /官方/u.test(text)
  const hasAmbiguousModificationPhrase = hasAmbiguousHarnessModificationPhrase(text)
  if (!statesCoexistence) {
    failures.push('missing requirement 3: parallel coexistence + zero changes to official install/config/session statement')
  }
  if (hasAmbiguousModificationPhrase) {
    failures.push('requirement 3 violated: contains ambiguous "modified the official Harness" phrasing')
  }

  // Requirement 4: removable without residue. Deliberately does NOT accept
  // the bare "不受影响" alternative — that phrase alone is also how
  // requirement 2 ("other features work") is worded, so accepting it here
  // would let a text satisfy requirement 4 purely on requirement 2's
  // sentence. Require the more specific "无残留" or "不受任何影响" instead
  // (the latter is what tasks.md §1's own sample text uses).
  const statesRemovable = /删除/u.test(text) && /(无残留|不受任何影响)/u.test(text)
  if (!statesRemovable) {
    failures.push('missing requirement 4: "removable without residue" statement')
  }

  // Requirement 5: exactly one non-placeholder command line. The placeholder
  // token must never reach a user-facing disclosure.
  if (text.includes('<BOOTSTRAP_COMMAND>')) {
    failures.push('requirement 5 violated: contains unfilled <BOOTSTRAP_COMMAND> placeholder')
  } else {
    const fencedBlocks = [...text.matchAll(/```(?:[^\n]*)\n([\s\S]*?)```/gu)]
    const commandLines = fencedBlocks
      .flatMap(match => match[1].split(/\r?\n/u))
      .map(line => line.trim())
      .filter(line => line !== '')
    if (commandLines.length !== 1) {
      failures.push(`requirement 5 violated: expected exactly 1 command line, found ${commandLines.length}`)
    }
  }

  return { valid: failures.length === 0, failures }
}
