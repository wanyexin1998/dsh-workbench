/** Host registrations for Workbench browser preferences. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { nodeSeedIo, seedChatPreset } from './preset-seed.ts'

/** Legacy shortcut section retained as the source for the 0.2 migration. */
export const LEGACY_SHORTCUT_NAMESPACE = 'dsh-native-ux-shortcuts'

/**
 * The Harness home's user preset root, as `dsh-agent-presets` derives it
 * (`USER_PRESET_DIR` is not exported by the host package, so the name is
 * pinned here and verified against the 0.1.1-rc.2 store:
 * `@deepseek-ai/dsh-agent-presets/lib/invariant.js:159`).
 */
const USER_PRESET_ROOT = '.agent-presets'

/**
 * Register Workbench preference schemas when the Host composes settings,
 * and seed the bundled chat preset (create-only; contract invariant 7
 * carve-out). Seeding is fail-soft: a filesystem error degrades to a warning
 * and never blocks Host composition.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      settingsNamespace(LEGACY_SHORTCUT_NAMESPACE),
      z.dict(z.string()),
    )
  })
  void seedChatPreset(dshHomePath(USER_PRESET_ROOT), nodeSeedIo).catch((error: unknown) => {
    console.warn('[dsh-workbench] chat preset seeding failed:', error)
  })
}
