/** Host registrations for Workbench browser preferences. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Legacy shortcut section retained as the source for the 0.2 migration. */
export const LEGACY_SHORTCUT_NAMESPACE = 'dsh-native-ux-shortcuts'

/**
 * Register Workbench preference schemas when the Host composes settings.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      settingsNamespace(LEGACY_SHORTCUT_NAMESPACE),
      z.dict(z.string()),
    )
  })
}
