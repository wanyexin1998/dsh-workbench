/** Host registrations for Workbench browser preferences. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// 只为把 dsh-settings 的 `declare module '@deepseek-ai/cordis'` 增广拉进本编译单元
// （它声明了 `Context.settings`）。0.1.2-rc.1 之前这条增广是搭 `settingsNamespace`
// 的值导入顺带进来的；那个函数删掉之后就没有值可导入了，改成显式的类型副作用导入，
// 与本仓库对 `@deepseek-ai/dsh-client-ui-slots` 的用法同形。
import type {} from '@deepseek-ai/dsh-settings'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { nodeSeedIo, seedChatPreset } from './preset-seed.ts'

/** Legacy shortcut section retained as the source for the 0.2 migration. */
export const LEGACY_SHORTCUT_NAMESPACE = 'dsh-native-ux-shortcuts'

/**
 * 宿主 home 下的用户 preset 根目录，与 `dsh-agent-presets` 推导出的同名。
 *
 * 这里钉死字面量而不是导入常量，是因为 Workbench 根本不依赖
 * `@deepseek-ai/dsh-agent-presets`（宿主半边只往那个目录里播一个文件），不为
 * 一个字符串新增一条 peer。0.1.2-rc.1 上已核：
 * `@deepseek-ai/dsh-agent-presets/lib/discovery.d.ts:38` 声明
 * `USER_PRESET_DIR = '.agent-presets'`。
 * （上一版 0.1.1-rc.2 的注释把理由写成"宿主没导出这个常量"——那条理由在 rc.1
 * 上已经不成立了，常量现在是公开的，不成立的是"值得为它加依赖"。）
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
    // 0.1.2-rc.1 删掉了 `settingsNamespace()`：命名空间退化成品牌字符串
    // （`SettingsNamespace = Branded<'SettingsNamespace'>`，见
    // `@deepseek-ai/dsh-settings/lib/types/types.d.ts:13`），改由 `register()`
    // 自己在类型层校验字面量——`register<const Namespace extends string, T>(
    // ns: Namespace & SettingsNamespaceInput<Namespace>, …)`
    // （`.../lib/types/index.d.ts:19,216`）要求首字符是小写字母、其余只能是
    // 小写字母 / 数字 / 连字符。`LEGACY_SHORTCUT_NAMESPACE` 满足这条模式，所以
    // 直接把常量传进去即可：既不用那个已删除的构造函数，也不必写
    // `as SettingsNamespace` —— 那个断言会把宿主刚给我们的这层校验绕过去。
    settingsCtx.settings.register(LEGACY_SHORTCUT_NAMESPACE, z.dict(z.string()))
  })
  void seedChatPreset(dshHomePath(USER_PRESET_ROOT), nodeSeedIo).catch((error: unknown) => {
    console.warn('[dsh-workbench] chat preset seeding failed:', error)
  })
}
