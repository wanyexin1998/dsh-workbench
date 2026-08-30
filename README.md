<p align="center">
  <img src="docs/assets/dsh-workbench-banner.png" width="100%" alt="DSH Workbench 双 Pane 工作台视觉：两个独立会话面板、中央分隔线与两侧 Navigator 轨迹">
</p>

<p align="center">
  面向 DeepSeek Harness Web 的双 Pane 工作台：并行处理两个 Session，并为每个 Pane 提供独立导航、快捷键与可选侧边面板。
</p>

<p align="left">
  <strong>简体中文</strong> · <a href="README_EN.md">English</a>
</p>

<p align="center">
  <img alt="状态：源码预览" src="https://img.shields.io/badge/status-source%20preview-5865F2">
  <img alt="版本：0.2.0-rc.2" src="https://img.shields.io/badge/version-0.2.0--rc.2-2563EB">
  <img alt="Session Presentation：protocol 2" src="https://img.shields.io/badge/Session%20Presentation-protocol%202-0891B2">
  <img alt="可见 Pane：2" src="https://img.shields.io/badge/visible%20Panes-2-0F766E">
  <a href="LICENSE"><img alt="许可证：MIT" src="https://img.shields.io/badge/license-MIT-334155"></a>
</p>

> [!IMPORTANT]
> 当前版本是 `0.2.0-rc.2` 源码预览，不是即装即用的 npm 正式版。分屏能力依赖固定版本的 Harness fork；Better Sidebar 及其兼容包完全可选。本项目不会自动安装、更新或修改任何第三方插件。

> [!TIP]
> **一句话安装（Release-first）：复制下面整句发给 DeepSeek Harness Agent**
>
> ```text
> 请安装 DSH Workbench。先检查当前 Harness：兼容双 Pane 就直接安装；不兼容时保留通用插件功能，并告诉我如何并行安装不覆盖官方 Harness 的自装补丁路径（bootstrap）。若沙箱不能写入 DSH_HOME，只给我一条最终终端命令。
> ```
>
> 完整判定规则与命令见 [`docs/INSTALL.md`](docs/INSTALL.md)。`v0.2.0-rc.2` GitHub Release 已发布，通用插件与分屏 bootstrap 两条路径均可直接使用；当前状态仍是 `0.2.0-rc.2` 源码预览（见 [`release-contract.json`](release-contract.json)），不是 npm 正式版。想自己审计源码可用下方「高级：从源码构建」。

## 它解决什么问题

DeepSeek Harness 默认以单一当前 Session 驱动界面。DSH Workbench 在不复制 Conversation、不修改 Agent loop 的前提下，为 Web 端增加两个稳定、彼此独立的 Session Pane。

| 能力 | 用户体验 |
| --- | --- |
| 双 Pane | 同时查看和操作两个 Session；切换聚焦不会重新挂载另一侧 |
| Pane 独立状态 | 草稿、滚动位置、Navigator 和可选面板分别保留 |
| Navigator | 按真实输入条目显示导航横线，悬浮预览并快速定位消息 |
| 全局快捷键 | 简体中文 / English 名称随 Harness 全局语言切换，可修改和持久化；新建会话、打开设置、切换上一个会话、跳到最新消息等动作见下方「默认快捷键」 |
| 随手问 | 快捷打开零工具聊天，并把已完成消息的选区加入原会话或 fork 到侧聊 |
| Pane-local 面板 | 安装兼容包后，每个 Pane 可独立展开右侧、底部面板 |
| 安全降级 | Presentation protocol 不兼容时不启用双 Pane 容量 |

## 界面预览

### 双 Session Pane

<p align="center">
  <img src="docs/assets/dsh-workbench-split-pane.png" width="100%" alt="DSH Workbench 浅色模式双 Pane 界面，分别打开 wyx_code 与 data-warehouse Session">
</p>

两个 Session 使用独立的标题、工作区、模式、输入框和 Pane 面板控制；中央分隔线保持各自的 SessionProvider 生命周期。

### 跟随全局语言的快捷键设置

<p align="center">
  <img src="docs/assets/dsh-workbench-shortcuts.png" width="100%" alt="DSH Workbench 快捷键设置页面，使用简体中文名称展示 Navigator、输入框、侧边栏、停止会话与关闭 Pane 操作">
</p>

快捷键名称跟随 Harness 全局语言切换；冲突、浏览器保留键和持久化状态会在设置界面中明确显示。

## 兼容性一览

| 组件 | 是否必需 | 当前支持 | 说明 |
| --- | --- | --- | --- |
| DeepSeek Harness | 必需 | fork `fix/plugin-spec-quoting`，固定提交 `1a8cf5b…` | 提供 Session Presentation `protocol 2` |
| DSH Workbench | 必需 | `0.2.0-rc.2` | 最多两个可见 Pane |
| Better Sidebar | 可选 | fork `0.16.1`，固定提交 `1685770…` | 提供 Pane capability `protocol 1`；含面板快捷键 actions（`actionsProtocol 1`） |
| Panel Compatibility | 可选 | `0.1.0-rc.1` | 只连接显式兼容的面板提供方 |

完整 SHA、分支和分发状态以 [`release-contract.json`](release-contract.json) 为准。原版 Harness `0.1.1-rc.2` 尚未提供此分屏接口；原版 Better Sidebar `0.16.1` 也没有多实例 Pane capability。

没有安装 Better Sidebar 时，Workbench 的双 Pane、Navigator 和快捷键仍可正常使用。Panel Compatibility 不会启动 Pane observer，也不会改变 DOM、布局或样式。

## 快速开始

> [!NOTE]
> `v0.2.0-rc.2` GitHub Release 已发布，附带两个 TGZ、两个分屏 bootstrap 脚本、`SHA256SUMS` 与 `release-manifest.json`；下面两条路径今天就能照抄执行。Release 产物经 SHA256 校验，不是 GPG 签名产物（`release-contract.json` 的 `sourceVerification.signedReleaseAvailable` 仍为 `false`）。`release-contract.json` 状态本身仍是 `0.2.0-rc.2` / `source-preview`——这是既定的分发模型（只发源码与本地 TGZ，不发 npm），不代表安装路径不可用。想自己从源码逐字审计，仍可用下方折叠区「高级：从源码构建（审计路径）」（即 [`docs/INSTALL.md` § Advanced: source build](docs/INSTALL.md#advanced-source-build)）。

### 通用插件（stock Harness，默认）

从 GitHub Release 下载不可变的 Workbench TGZ、核对 SHA256、用 `dsh plugin --profile web add file:<path>` 安装（Windows 上安装路径不要含空格，否则会遇到 `ENOENT`，详见下方链接）。分屏（双 Pane）在 stock Harness 上不会激活——官方接口尚未合并（见 [discussion #4718](https://github.com/deepseek-ai/deepseek-harness/discussions/4718)）；其余功能不受影响。完整命令块见 [`docs/INSTALL.md` § Quick Install](docs/INSTALL.md#quick-install-default)。

### 分屏（bootstrap，一条命令）

想用分屏，按你的平台复制运行下面这一条命令（与官方 Harness 并存，零改动官方安装；要求 Node.js `^22.19`/`>=24`、`pnpm@11`、`git`，Windows 需 PowerShell 7+）：

Windows（PowerShell 7+ / `pwsh`）：

```
& { $ErrorActionPreference = 'Stop'; $rel = 'https://github.com/wanyexin1998/dsh-workbench/releases/download/v0.2.0-rc.2'; Invoke-WebRequest "$rel/dsh-workbench-bootstrap.ps1" -OutFile dsh-workbench-bootstrap.ps1; Invoke-WebRequest "$rel/SHA256SUMS" -OutFile SHA256SUMS; $expectedLine = (Select-String -Path SHA256SUMS -Pattern 'dsh-workbench-bootstrap\.ps1$').Line; if (-not $expectedLine) { throw 'SHA256SUMS 中未找到 dsh-workbench-bootstrap.ps1 的记录，已中止' }; $expected = ($expectedLine -split '\s+')[0].ToLower(); if ($expected -notmatch '^[0-9a-f]{64}$') { throw "SHA256SUMS 中的哈希格式不合法：$expected" }; $actual = (Get-FileHash dsh-workbench-bootstrap.ps1 -Algorithm SHA256).Hash.ToLower(); if ($actual -ne $expected) { throw "SHA256 校验失败：期望 $expected，实际 $actual" }; pwsh -NoProfile -ExecutionPolicy Bypass -File .\dsh-workbench-bootstrap.ps1 }
```

macOS（Terminal）：

```
rel='https://github.com/wanyexin1998/dsh-workbench/releases/download/v0.2.0-rc.2'; if curl -fsSLO "$rel/dsh-workbench-bootstrap.sh" && curl -fsSLO "$rel/SHA256SUMS"; then expected=$(grep 'dsh-workbench-bootstrap\.sh$' SHA256SUMS | awk '{print $1}'); actual=$(shasum -a 256 dsh-workbench-bootstrap.sh | awk '{print $1}'); if [ -n "$expected" ] && printf '%s' "$expected" | grep -qE '^[0-9a-f]{64}$' && [ "$actual" = "$expected" ]; then chmod +x dsh-workbench-bootstrap.sh && ./dsh-workbench-bootstrap.sh; else echo 'SHA256 校验失败，已中止，不会执行未校验脚本' >&2; false; fi; else echo '下载失败，已中止，不会执行未校验脚本' >&2; false; fi
```

脚本做了什么、如何卸载、哈希何时生效等完整说明见 [`docs/INSTALL.md` § 分屏（bootstrap）](docs/INSTALL.md#b-split-pane-bootstrap)。

<details>
<summary><strong>高级：从源码构建（审计路径）</strong></summary>

完整版见 [`docs/INSTALL.md` § Advanced: source build](docs/INSTALL.md#advanced-source-build)。这条路径依旧有效，面向想要逐字审计每一行代码的用户；它不再是默认路径，仅因为现在已经有不可变的 Release 产物可用。

> [!TIP]
> **一句话安装（源码审计路径）：复制下面整句发给 DeepSeek Harness**
>
> ```text
> 请从 https://github.com/wanyexin1998/dsh-workbench 安装 DSH Workbench：首先向我索取并确认一个从独立可信渠道获得的完整 40 位 Workbench commit，若我未提供则停止；要求目标目录不存在，使用 git clone --no-checkout 后 checkout --detach 该提交，每个 Git 命令失败都立即停止，并验证 detached HEAD、完整 clean worktree 以及 git rev-parse --verify HEAD 与输入提交的大小写无关精确相等；只有全部验证成功后才读取仓库中的执行性说明并运行 pnpm install --frozen-lockfile 和 pnpm release:check，将生成的 Workbench TGZ 安装到 web profile；仅当我已安装兼容的 Better Sidebar fork 时再安装 Panel Compatibility，不要自动安装或替换第三方插件，不要发布 npm，最后报告实际提交、TGZ SHA256 以及双 Pane、Navigator 和快捷键的验证结果。
> ```

### 环境要求

- Node.js `^22.19` 或 `>=24`
- pnpm `11`
- 已按固定提交构建的 Harness fork

### 构建并验证 Workbench

先从独立可信渠道获得并人工确认完整的 40 位 Workbench commit。不要把当前分支、短 SHA、普通 tag 或仓库自身的可变文档当作信任锚。

```powershell
$WorkbenchCommit = Read-Host '输入已从独立可信渠道确认的完整 40 位 Workbench commit'
if ($WorkbenchCommit -notmatch '^[0-9a-fA-F]{40}$') { throw 'Workbench commit 必须是完整的 40 位十六进制值' }
$WorkbenchCommit = $WorkbenchCommit.ToLowerInvariant()
if (Test-Path -LiteralPath 'dsh-workbench') { throw '目标目录 dsh-workbench 已存在；为避免执行旧工作树，请使用空目录重试' }
git clone --no-checkout https://github.com/wanyexin1998/dsh-workbench.git
if ($LASTEXITCODE -ne 0) { throw '克隆 Workbench 失败' }
cd dsh-workbench
git checkout --detach $WorkbenchCommit
if ($LASTEXITCODE -ne 0) { throw '检出 Workbench commit 失败' }
$ResolvedCommit = (git rev-parse --verify HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0) { throw '无法解析 Workbench HEAD' }
if ($ResolvedCommit -ne $WorkbenchCommit) { throw "Workbench commit 不匹配：期望 $WorkbenchCommit，实际 $ResolvedCommit" }
$HeadRef = git symbolic-ref -q HEAD
if ($LASTEXITCODE -eq 0) { throw "Workbench 必须处于 detached HEAD，当前为 $HeadRef" }
if ($LASTEXITCODE -ne 1) { throw '无法验证 detached HEAD' }
$WorktreeState = git status --porcelain=v1 --untracked-files=all
if ($LASTEXITCODE -ne 0) { throw '无法验证 Workbench 工作树' }
if ($WorktreeState) { throw 'Workbench 工作树不是 clean 状态' }
# WORKBENCH-SOURCE-VERIFIED-BEFORE-REPOSITORY-CODE
pnpm install --frozen-lockfile
pnpm release:check
```

成功后，`dist/` 中会生成：

- `wanyexin1998-dsh-workbench-0.2.0-rc.2.tgz`
- `wanyexin1998-dsh-workbench-panel-compat-0.1.0-rc.1.tgz`
- `release-manifest.json`
- `SHA256SUMS`

`release:check` 会执行隐私/密钥扫描、发布契约校验、类型检查、241 项包测试与安装契约/引导脚本测试套件、依赖审计、干净重建、生成代码扫描、TGZ 打包和 SHA256 校验，不会执行 npm 发布。

> 完整安装顺序、Harness fork 构建方式和可选面板接入步骤见 [`docs/INSTALL.md`](docs/INSTALL.md)。

</details>

## 交互约定

- 普通点击 Session：替换当前聚焦 Pane。
- `Ctrl` / `Command` + 点击 Session：在另一侧打开。
- 打开第三个 Session：替换当前聚焦 Pane，不增加第三个 Pane。
- 聚焦变化：只改变交互路由，不打开、关闭或重挂载面板。
- 两个 Session 使用同一工作区时：显示非阻断提醒；插件不提供文件写入隔离。
- 刷新页面：恢复一个 Pane；多 Pane 成员关系当前为进程内状态。

## 默认快捷键

`Primary` = macOS 上的 `⌘`，Windows / Linux 上的 `Ctrl`。所有动作均可在设置页重新绑定、清除或禁用；下表为出厂默认值，与 `packages/dsh-workbench/src/native-ux/client/shortcuts.tsx` 逐一核对。

| 动作 | 默认快捷键 | 说明 |
| --- | --- | --- |
| 切换 Navigator | `Primary+Shift+O` | |
| 聚焦输入框 | `Primary+/` | |
| 切换侧边栏 | `Primary+B` | 与浏览器书签快捷键冲突，设置页会提示 |
| 停止当前会话 | `Primary+Shift+X` | |
| 关闭聚焦 Pane | `Primary+\` | 仅 Presentation protocol 2 可用（需分屏 bootstrap 路径） |
| 随手问（Workbench Ask） | `Primary+Shift+C` | 与浏览器 DevTools「检查元素」冲突，设置页会提示；默认键位未更换 |
| 新建会话 | `Primary+N` | 浏览器普通标签页会保留为「新建窗口」，设置页会提示；桌面壳环境下可正常触发 |
| 打开设置 | `Primary+Space` | 需要 Harness 提供 `ctx.layout.openSettings()`，目前只有本项目固定的 Harness fork 提供，stock Harness 上不会注册该动作 |
| 切换到上一个会话 | `Alt+Q` | 跨平台从 `event.code` 派生按键，macOS 上不受 Option 字符合成影响 |
| 跳到最新消息 | `Primary+Shift+L` | |

## 可选：Pane 独立面板

需要每个 Pane 独立显示右侧或底部面板时，再安装：

1. 固定提交的 [Better Sidebar fork](https://github.com/wanyexin1998/DSH-better-sidebar)。
2. `@wanyexin1998/dsh-workbench-panel-compat` 本地 TGZ。

兼容包只消费版本化 Pane capability 和公开的 `data-session-pane*` host marker，不会修补 Better Sidebar 私有 store，也不会推断未知 DOM。

## 随手问 / Workbench Ask

`Ctrl+Shift+C`（macOS 为 `Command+Shift+C`）打开一个使用 **聊天模式 / Chat mode** 预设的全新或当天最近空白会话。在 Workbench Edition 中，它会在来源 Pane 旁边打开并聚焦；已有两个 Pane 时，Workbench 先确认，再只替换非来源 Pane。原版 Harness 不支持双 Pane 时，动作仍可用，但会原位切换到聊天会话并只提示一次降级原因。会话优先归入标题为 `chat` 的 Workspace；没有该 Workspace 时使用来源会话所属 Workspace。没有可解析的 Workspace 时安全停止，不自动创建目录或 Workspace。

在一条已完成消息中选择文字后，Workbench 提供三项动作：

- **添加到对话**：把选区作为结构化 reference 加入来源 Pane 的 composer；保留普通草稿，可聚合多段并附加评论，不自动发送。原版 Harness 也可用。
- **更多详情**：从选区所在会话的已完成 Turn fork child，在第二 Pane 打开，并恰好发送一次带 reference-only boundary 的本地化解释请求。仅 Presentation protocol 2 可用。
- **在侧边聊天中提问**：同样 fork child，但只放入带 boundary 的选区 reference 和空普通草稿；用户显式输入问题并发送前，不发生模型调用。仅 Presentation protocol 2 可用。

侧聊 child 继承父会话的 cwd、模型、预设、Workspace、工具与 approval 流程。它不是零工具聊天；任何工具副作用都是真实的。关闭 Pane 只关闭呈现，Session 继续保留在侧栏。fork 已成功但 Pane 或输入操作失败时，界面会报告保留的 child id，不会静默删除。

### 三种模式的边界

| | 极简模式（官方内置） | 聊天模式（Workbench 分发） | 侧聊（Workbench fork child） |
| --- | --- | --- | --- |
| 会话来源 | 新会话 | 新建或复用当天空白 `chat` 会话 | 从选区所在父会话的已完成 Turn fork |
| 上下文 | 轻量 Agent 脚手架 | 干净会话，无父会话上下文 | 继承父会话已完成历史，并以 boundary 标明当前任务 |
| 工具 | 2 个：持久 shell + `str_replace_editor` | 0 个 | 继承父预设的工具 |
| 能否改动你的系统 | 能——仍会改文件、跑命令 | 不能——架构上没有工具 | 能否修改取决于父预设与 approval；副作用真实存在 |
| 适用场景 | 轻量编码任务 | 问答、探讨方案、随手提问 | 针对现有会话内容追问、解释或继续工作 |

### 聊天模式预设的安装与删除

安装 Workbench 后，Host 启动时会把 **聊天模式 / Chat mode** 预设写入 `~/.dsh/.agent-presets/chat/`（只创建、绝不覆盖；你删除后不会重建）。它是零工具预设：模型只对话，不读写文件、不执行命令、不加载项目上下文；模型与供应商仍按会话自由选择。实测示例的首轮输入为 181 token。

不想要它时，删除 `~/.dsh/.agent-presets/chat/` 目录即可；Workbench 记录你的删除意图，不会重新写入。

## 安全与隐私

- 除聊天模式预设的一次性写入（只创建、绝不覆盖、尊重删除，见 [`docs/PRODUCT_CONTRACT.md`](docs/PRODUCT_CONTRACT.md)）外，不新增 Host filesystem、subprocess、credential 或任意网络权限。
- 不在 Harness 自有存储之外持久化 Prompt、工具调用或 Session 内容。
- 两个 package 均为 `private: true`，防止意外 npm 发布。
- 仓库不包含 GitHub Actions；发布检查只在本地运行。
- 支持 GitHub Private Vulnerability Reporting。

安全问题请阅读 [`SECURITY.md`](SECURITY.md)，不要在公开 Issue 中提交凭证、私有 Session 内容、专有源码或可利用细节。

## 项目结构

```text
packages/
├─ dsh-workbench/               # 双 Pane、Navigator、快捷键、同工作区提醒
└─ dsh-workbench-panel-compat/  # 可选的 Pane-local 面板适配层
docs/
├─ INSTALL.md                   # 完整安装流程
├─ PRODUCT_CONTRACT.md          # 产品与运行时不变量
├─ COMPATIBILITY_MATRIX.md      # 精确兼容范围
└─ SECURITY_STATEMENT.md        # 安全边界
```

## 文档导航

| 想了解 | 文档 |
| --- | --- |
| 完整安装步骤 | [`docs/INSTALL.md`](docs/INSTALL.md) |
| 产品行为与边界 | [`docs/PRODUCT_CONTRACT.md`](docs/PRODUCT_CONTRACT.md) |
| 第三方插件注册快捷键动作 | [`docs/ACTIONS_API.md`](docs/ACTIONS_API.md) |
| 版本兼容关系 | [`docs/COMPATIBILITY_MATRIX.md`](docs/COMPATIBILITY_MATRIX.md) |
| 已知限制 | [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md) |
| 卸载与残留状态 | [`docs/UNINSTALL.md`](docs/UNINSTALL.md) |
| 安全声明 | [`docs/SECURITY_STATEMENT.md`](docs/SECURITY_STATEMENT.md) |
| 参与贡献 | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

## 常见问题

<details>
<summary><strong>必须安装 Better Sidebar 吗？</strong></summary>

不需要。Better Sidebar 和 Panel Compatibility 只负责可选的 Pane-local 右侧/底部面板；双 Pane、Navigator 和快捷键不依赖它。
</details>

<details>
<summary><strong>可以同时打开 5 个 Pane 吗？</strong></summary>

当前公开契约最多为两个可见 Pane。扩展到 5 个需要重新设计布局、容量与性能验收，不属于 `0.2.0-rc.2`。
</details>

<details>
<summary><strong>为什么不能直接使用原版 Harness？</strong></summary>

本版本依赖 Session Presentation `protocol 2`、稳定的 `visible` / `focused` 状态和每个 Pane 独立的 SessionProvider。原版 `0.1.1-rc.2` 尚未提供这些接口。
</details>

## 项目声明

DSH Workbench 是独立的社区维护项目，不是 DeepSeek 官方项目，也不代表 DeepSeek 或 Better Sidebar 维护者的认可。

Banner 中的鲸鱼标识取自 DeepSeek Harness 官方资源，仅用于说明产品兼容关系；DeepSeek 名称与标识的相关权利归其权利人所有。

本项目使用 [MIT License](LICENSE)。第三方归属与说明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
