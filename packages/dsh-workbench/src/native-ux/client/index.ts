// DSH Workbench client entry — one Cordis plugin, one business module.
// Loader consumes this entry via exports["./client"] + the dsh.client manifest.
import { applyShortcuts } from './shortcuts.js'
import { type HarnessContext } from './harness-adapter.js'
import { logCapabilityReport, probeCapabilities, warnOnce } from './capabilities.js'

/**
 * Services required by this plugin (cordis fiber inject).
 *
 * `remote` 的每个命名空间都要**单独声明**，光写 `'remote'` 不够：cordis 的
 * `reflect.ts` 在 `ctx.remote.session` 这一步就抛 `cannot get property
 * "remote.session" without inject`。上游自己也是这么写的（`ui-deliverables`、
 * `ui-model-selection` 等都是 `['...', 'remote', 'remote.session']`）。
 *
 * rc.4 的 B2 迁移把 `'connection'` 换成 `'remote'` 时漏了命名空间那半，
 * 于是 applyShortcuts —— Navigator 退役后插件唯一的 apply 入口 —— 整个注册失败，
 * 被 GA-043 的 fail-soft 兜住，只在控制台留一行 warn：插件静默地什么都不做。
 * 单元测试当时只断言 `inject` 含 `'remote'`，所以没拦住；现在 apply.test.ts
 * 改成从源码推导要求。
 */
export const inject = ['remote', 'remote.session', 'slots', 'locale', 'layout', 'sessions', 'workspaces', 'settingsScope']

/**
 * Plugin apply: registers the shortcuts settings section. GA-043 fail-soft
 * (§9A.11): the module registers inside its own try/catch so a seam failure
 * never crashes the page — it logs once and the rest of the host keeps
 * working. Slot declarations are awaited via ctx.slots.inject so activation
 * order does not matter.
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
    applyShortcuts(ctx)
  } catch (error) {
    warnOnce('shortcuts-apply-failed', 'shortcuts module failed to register (fail-soft): ' + String(error))
  }
}
