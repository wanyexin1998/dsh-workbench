// GA-030 / GA-041 / GA-043 (Roadmap §9A.1, §9A.11) — runtime capability
// probe + fail-soft. The harness is in RC and seams (slots / services / DOM
// anchors) may be renamed or absent. This module:
//   1. probes the seams the plugin depends on into a CapabilityReport
//   2. gives a warn-once helper so a missing seam logs once, never spams
//   3. (consumed by apply) isolates each module's registration so one
//      module's failure never crashes the page.
//
// The report is dev diagnostics only (console.debug) — it is intentionally
// NOT surfaced in the Settings UI (§9A.11: diagnostics do not become product
// chrome).

import {
  detectConversationDom,
  type ConversationDomCapabilities,
} from './conversation-dom.js'
import {
  resolveHarnessServices,
  type HarnessContext,
  type HarnessServices,
} from './harness-adapter.js'

export interface CapabilityReport {
  /** the slot seam (ctx.slots.inject) the plugin registers through is callable.
   * A single boolean: §9A.1 forbids inventing a ctx.slots.has(), so we cannot
   * distinguish the two specific slot names — the inject seam is the only
   * honest signal both the navigator and the settings section share. */
  slotsInject: boolean
  /** layout service exposes toggleSidebar. */
  layoutToggle: boolean
  /** sessions service is present (per-session conversation face). */
  conversationFace: boolean
  /** at least one [data-chat-anchor-key] is rendered (navigator content). */
  chatAnchorDom: boolean
  /** [data-composer-seat] is present (composer focus target). */
  composerDom: boolean
  /** settingsScope.bind is available (shortcut persistence backend). */
  settingsPersistence: boolean
  /** a real favorite-agent open API is exposed (currently always false). */
  favoriteAgent: boolean
}

/**
 * Build the report from resolved services + the conversation DOM state.
 * Pure in its inputs so it is trivially testable without a live host.
 */
export function buildCapabilityReport(
  services: HarnessServices,
  dom: ConversationDomCapabilities,
  seams: { slotsInject: boolean; settingsPersistence: boolean },
): CapabilityReport {
  return {
    slotsInject: seams.slotsInject,
    layoutToggle: typeof services.layout?.toggleSidebar === 'function',
    conversationFace: services.sessions !== undefined,
    chatAnchorDom: dom.anchors,
    composerDom: dom.composer,
    settingsPersistence: seams.settingsPersistence,
    favoriteAgent: false, // no real open API in the harness rc (issue #1 p4)
  }
}

/** Probe the live context + DOM into a CapabilityReport. */
export function probeCapabilities(ctx: HarnessContext): CapabilityReport {
  // Single narrowing point (GA-040): reuse resolveHarnessServices instead of
  // re-casting ctx.get() here — a boundary signature change surfaces in one
  // place, not in three.
  const services = resolveHarnessServices(ctx)
  const dom = detectConversationDom()
  const seamOk = (fn: unknown): boolean => typeof fn === 'function'
  return buildCapabilityReport(services, dom, {
    slotsInject: seamOk(ctx.slots.inject),
    settingsPersistence: seamOk(ctx.settingsScope.bind),
  })
}

// warn-once: a missing seam should surface once, not on every frame.
const warned = new Set<string>()

/** Log a one-shot warning for a missing/degraded seam. The key is included
 * in the output so each degraded seam is identifiable in dev logs. */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[dsh-native-ux] ${key}: ${message}`)
}

/** Test-only: reset the warn-once dedup. */
export function resetWarnOnce(): void {
  warned.clear()
}

/** Dev diagnostics only — never rendered into product UI. */
export function logCapabilityReport(report: CapabilityReport): void {
  const missing = (Object.keys(report) as Array<keyof CapabilityReport>)
    .filter((k) => report[k] === false)
  // eslint-disable-next-line no-console
  console.debug(
    `[dsh-native-ux] capabilities: ` +
      (missing.length === 0
        ? 'all present'
        : `degraded [${missing.join(', ')}]`),
    report,
  )
}
