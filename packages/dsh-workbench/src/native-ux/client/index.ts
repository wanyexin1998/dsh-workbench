// DSH Workbench client entry — one Cordis plugin, two business modules.
// Loader consumes this entry via exports["./client"] + the dsh.client manifest.
import { applyNavigator } from './navigator.js'
import { applyShortcuts } from './shortcuts.js'
import { type HarnessContext } from './harness-adapter.js'
import { logCapabilityReport, probeCapabilities, warnOnce } from './capabilities.js'

/** Services required by this plugin (cordis fiber inject). */
export const inject = ['connection', 'slots', 'locale', 'layout', 'sessions', 'workspaces', 'settingsScope']

/**
 * Plugin apply: registers the navigator rail and the shortcuts settings
 * section. GA-043 fail-soft (§9A.11): each module registers inside its own
 * try/catch so one module's seam failure never crashes the page — it logs
 * once and the other module (and the rest of the host) keep working.
 * Slot declarations are awaited via ctx.slots.inject so activation order
 * does not matter.
 */
export function apply(ctx: HarnessContext) {
  // Dev diagnostics only (console.debug) — capability state is never
  // surfaced in the Settings UI (§9A.11).
  try {
    logCapabilityReport(probeCapabilities(ctx))
  } catch {
    // probing must never block activation
  }
  try {
    applyNavigator(ctx)
  } catch (error) {
    warnOnce('navigator-apply-failed', 'navigator module failed to register (fail-soft): ' + String(error))
  }
  try {
    applyShortcuts(ctx)
  } catch (error) {
    warnOnce('shortcuts-apply-failed', 'shortcuts module failed to register (fail-soft): ' + String(error))
  }
}
