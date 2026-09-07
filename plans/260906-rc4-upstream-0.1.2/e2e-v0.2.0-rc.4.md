# Windows 隔离端到端 · v0.2.0-rc.4（2026-09-07）

> rc.2 之后第一次真跑。**结论：安装链全部通过，但已发布的 rc.4 插件本体是死的**——
> 客户端半边一个东西都不注册。缺陷已定位、已修、已在同一套隔离安装里验证修复生效。

## 环境

| 项 | 值 |
|---|---|
| 目标目录 | `E:\rc4-e2e\dsh workbench target`（**路径含空格**，复现 rc.2 的场景） |
| 安装器 | 从 Release 下载的 `dsh-workbench-bootstrap.ps1`，SHA256 按 INSTALL 的命令核过 = `dcce00e2…` |
| `-TgzSha256` | **不传**，走脚本自己刻的摘要 |
| Node | v24.18.0（在 24.12+ 的正常档，不是 24.0–24.11.1 那个坏档） |

## 安装链：通过

第一次跑在 GitHub 传输重置上失败（`curl 56 Recv failure`），**安装器行为正确**：
失败即停，吐出合法的 `{"state":"failed",...}` 并 exit 1。**重试一次成功**。

**这次没有用本地裸镜像替换传输层——是真的从 GitHub 克隆的**，所以 rc.2 那条
"GitHub 可达性未被证明"的保留，这次可以去掉。

| 检查 | 结果 |
|---|---|
| 结果 JSON | `state: installed`，exit 0 |
| fork HEAD | `c5a387cd2f781d4d9914ea0271ebb507984ca3f4`，**detached**，工作树干净 |
| TGZ 摘要 | 下载到的 = `5bdaf6b2…` = 已发布摘要 = 安装器刻的那个 |
| `<target>/home` | 已创建 |
| 启动器 | 自相对（`set "DSH_HOME=%~dp0home"`），不碰 PATH / 注册表 |
| 真实 `~/.dsh` | `sessions/`、`storages/` 之外**零改动**（那两处是用户自己在跑的 Harness 写的，不是本次运行） |
| 启动 web | 20~90 秒起，打印带 token 的 URL |
| token 围栏 | 裸 `http://127.0.0.1:<port>/` → **401**；带 `?token=` → 200。与本轮写进 INSTALL 的描述一致 |
| 客户端模块图 | 47 条，非空（Node 24 那个空图 bug 不复现，本机在已修的 Node 档） |

## 发现的缺陷：已发布的 rc.4 什么都不做

浏览器控制台唯一的一行：

```
[dsh-native-ux] shortcuts-apply-failed: shortcuts module failed to register:
Error: cannot get property "remote.session" without inject
```

**根因**：cordis 按路径逐段放行（`vendor/cordis/src/reflect.ts:144`）。客户端入口
`packages/dsh-workbench/src/client/index.tsx` 的 inject 只写了 `'remote'`，而代码读的是
`ctx.remote.session.create(...)`。上游自己两条都写（`ui-deliverables`、`ui-model-selection`
都是 `[..., 'remote', 'remote.session']`）。

**是 rc.4 的回归**：rc.3 注入的是 `'connection'`，能工作；round 1 的 B2（`34a2f65`）
换成 `'remote'` 时只搬了根、漏了命名空间。

**炸掉多少**：Navigator 退役后 `applyShortcuts` 是插件**唯一**的 apply 入口，它一抛，
GA-043 的 fail-soft try/catch 把异常吞掉——页面照常，插件静默地不注册任何东西：
没有词条、没有快捷键、没有随手问、没有设置区、没有分屏。装出来的包是活的，功能是死的。

**为什么门禁没拦住**：当时**有**一条单元测试断言 `inject` 含 `'remote'`——它是绿的，
因为那确实在里面。而且 ctx 测试替身对每个服务都返回 `undefined`，比真宿主宽松，
所以在一个开机即死的构建上照样满分。

## 修复与验证

- `4a5313d` 修的是真入口 `src/client/index.tsx`（前一个提交 `3e7608e` 修错了文件，
  改的是子模块 `native-ux/client/index.ts`——**是靠对着构建产物核对才发现的**，
  不是靠读源码）。
- 新门禁 `packages/dsh-workbench/src/client/inject.test.ts`：扫本包源码里代码实际
  解引用的每个 `ctx.remote.<ns>`，逐个要求 inject 里有 `'remote.<ns>'`。不写手写清单，
  清单跟不上代码正是这次的教训。**杀验过**：去掉 `remote.session` 就红，且报错点名它。
- `apply.test.ts` 的 ctx 替身改成按 cordis 规则抛异常，杀验时复现的是**线上一模一样的
  报错字符串**。

把修好的包（`85e2751f…`）装进**同一套隔离安装**后重启：

- 控制台**干净**，那条 warn 消失
- boot 图里有 `@wanyexin1998/dsh-workbench`
- 设置里出现「快捷键」页，内容是插件自己的：「工作台」分组、`Ctrl+\` 关闭聚焦分屏、
  `Ctrl+Shift+C` 随手问、`Ctrl+N` 新建会话
- 中文词条正常渲染 → locale 注册跟着活了
- 设置那条写的是「**打开或关闭**设置」→ 这个 pin 上 `toggleSettings()` 被识别到最高档，
  与 COMPATIBILITY_MATRIX 的三档表一致

## 仍未验证（如实记录）

- **分屏本身**（Ctrl+点第二个会话出两个 `[data-session-pane]`）：隔离 home 是空的，
  建会话需要配好模型/供应商，本次没有配。
- **划词徽标不与上游 TurnNavigator 重叠**：同上，需要一段真实对话。
- **`Ctrl+,` 开关**：设置面板打开后，自动化发的合成按键没到达处理器（大概率被面板的
  焦点陷阱吃掉）。快捷键**注册**是验到了（面板里那一行），**按下去生效**没验到。
- macOS、只读 `$DSH_HOME`、stock 通用插件路径：一如既往，从没跑过。

## 对已发布 rc.4 的影响

`v0.2.0-rc.4` 现在挂在 GitHub 上，装了就是个不做事的插件。要么重切 rc.4，要么发 rc.5。
这是用户的决定。文档里那几段"未验证"的措辞在修复发布前不要改成"已验证"。
