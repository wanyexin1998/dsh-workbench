# rc.4 评估：把 DSH Workbench 适配到上游 deepseek-harness 0.1.2

> 评估日期 2026-09-06。本文是**评估与方案**，不是执行记录。所有"上游如何"的断言都对着本地 fork 克隆里已拉取的三个 tag 逐一核过（`dsh-v0.1.1-rc.2` = 我们的基线 `b150a551b`；`dsh-v0.1.2-rc.1` = `a66e47020`；`dsh-v0.1.3-alpha.1` = `d347e7039`），引用形式为 `tag:路径:行`。没核到的放在文末「未验证」，不混进正文。

---

## 0. 一句话结论

**rc.4 的目标定在上游 `dsh-v0.1.2-rc.1`，不是 `0.1.3-alpha.1`。** 插件本体适配是"一天以内"的活；真正的工作量在 **fork 必须重做而不是 rebase**——上游把我们打补丁的那些包整个搬了家、拆了、并（意外地）自己实现了我们一半的东西。同时上游 rc.1 自带了一条回合导航栏，和我们的 Navigator 画在同一条右侧沟槽里，**这是 rc.4 唯一需要你拍板的产品决定**。

---

## 1. 上游现状（事实）

| 项 | 数值 | 出处 |
|---|---|---|
| 我们的基线 | `0.1.1-rc.2` @ `b150a551b`，2026-08-21 | `release-contract.json` |
| 上游最新 rc | `0.1.2-rc.1` @ `a66e47020`，2026-09-03，**1735 commits** 之后 | `gh api compare` |
| 上游 HEAD | `0.1.3-alpha.1` @ `d347e7039`，2026-09-04，2063 commits | 同上 |
| 发布节奏 | alpha 几乎日更；rc 约两周一次（08-21 → 09-03） | release 列表 |
| `0.1.3-alpha.1` | 官方标注 **破坏性变更**（Session 持久化改为 `SessionHandle`、`agentLoop.create()` 异步、Session 锁、Session 格式 v2）+ 官方承认的性能回退 | 该版本 release notes |
| 外部 PR | **不接受**："We are sorry that we cannot accept external pull requests at the moment." | `CONTRIBUTING.md` 第 9 行；仓库无任何外部 PR |
| Issues | 关闭；只有 Discussions | `has_issues=false` |
| 我们的提案 #4718 | 3 条社区评论，**0 条维护者回复**，未采纳 | discussion 元数据 |
| 同类提案 | #2418（8-16，starsmaplee，带原型，0 回复）、#5192（8-31，导航原子操作）、#4234（右侧伴随面板）、#4879（侧栏视图切换缝） | 搜索结果 |
| 维护者会回什么 | #4815（9+ 个消费者的普查帖）得到 tianyicui 一句"我们正在积极考虑相关设计"；#5120 是维护者**主动**征集插件升级 skill 的帖子，18 条回复 | 同上 |
| Windows 参数拆断 | #1343 / #1420（8-14 社区定位根因）；**rc.1 源码仍未修**：`spawnSync('pnpm', …, { shell: process.platform === 'win32' })` 原样 | `dsh-v0.1.2-rc.1:apps/cli/src/plugin.ts:264-271` |
| 社区升级资料 | `oh-my-dsh/dsh-plugin-upgrade-skill`：58 张升级卡，覆盖到 0.1.2-rc.1；rc.1 卡片结论是"alpha.5 → rc.1 零源码变更" | 该仓库 `skills/plugin-upgrade/references/` |

**推论**：上游没有"上游化"这条路，fork 是长期现实。维护者对 Discussions 的响应模式是"多消费者、有普查、有生产损失"的帖子才回。

---

## 2. 插件本体在 rc.1 上会断在哪（逐项核过）

### 2.1 硬断点（装上就炸或功能失效）

| # | 断点 | 现状（我们） | rc.1 事实 | 修法 | 量级 |
|---|---|---|---|---|---|
| B1 | **Host 半边启动即抛** | `src/index.ts:4,29` 值导入 `settingsNamespace()` | 该函数**已删除**。`SettingsNamespace` 退化为品牌字符串类型（`packages/settings/settings/src/types.ts:15`），命名空间改写成字面量常量（`AGENT_LOOP_SETTINGS_NAMESPACE = 'agent-loop'`） | `'dsh-native-ux-shortcuts' as SettingsNamespace`；社区卡 R-11 同款 | 分钟 |
| B2 | **随手问建会话失效** | `chat-actions.ts:367` 走 `services.connection.api.sessions.create({workspaceId, agentPreset:'chat'})` | `connection.api.*` 在 rc.1 客户端 **0 处使用**（基线 4 处）；客户端统一改走 `ctx.remote.<ns>.<method>()`；wire 端 `session/create` 仍读 `request.agentPreset`（`api/session-controller/src/commands.ts:94`） | 改 `ctx.remote.session.create(...)`。**注意** #5120 第 5 条：网关按描述符严格校验参数布局（`assertExactArguments`），多一个字段直接 `arguments-invalid`，fake 也要按同一张表编 | 小时 |
| B3 | **`dsh-client-runtime` 包被删** | `src/client/index.tsx:1`、`harness-adapter.ts`、panel-compat 的 `index.ts:1` 从它 type-import `ClientContext`/`SessionId`；两个 package.json 把它列为 peer | rc.2 → alpha.1 删了 5 个包，它是其一（社区卡 R-05 逐 tag 比过）；`ClientContext` = cordis `Context` 别名；`SessionId` 在 `@deepseek-ai/dsh-session/types`，`@deepseek-ai/dsh-api-remotes/client` 也再导出（`packages/api/remotes/src/client/index.ts:59`） | 改导入源；删 peer。**只有类型导入**，编译产物 `lib/client.js` 里没有任何 `@deepseek-ai/*` 运行时 require（已核） | 分钟 |
| B4 | **peer 钉死 `0.1.1-rc.2`** | 10 个 `@deepseek-ai/dsh-*` peer + dev 全是精确版本 | semver 预发布规则下 `^0.1.1-rc.2` 与 `>=0.1.1-rc.2 <0.2.0` **都不匹配** `0.1.2-rc.1`（用仓库自带 semver 7.8.5 实测） | 全部改 `0.1.2-rc.1`（精确，保持 `release-contract-check.mjs:166-169` 的等值门禁），或 `^0.1.2-rc.1` + 改门禁为 `satisfies` | 分钟 |
| B5 | `ReferenceCodec` 类型从 `/client` 索引撤下 | `selection-reference.ts:2` 导入 | 仍在 `ui-input-trigger/src/types.ts:131`，但 `/client` 不再导出；包 exports 只有 `.`、`./client`、`./src/*` | 本地内联该接口（我们本来就在实现它），或走 `./src/types` 子路径 | 分钟 |

### 2.2 没断的（核过，写下来免得再查）

- `sessions.create / open / fork / clear / scope` 在 rc.1 契约上都在（`api/session-controller/src/client/contract/sessions.ts`）；`fork` 签名 `{sessionId, atSeq?, increaseTitle?}` 与我们兼容。`sessions.list` 现在是 `ObservableSnapshot<SessionListState>` 属性——我们已经是 `.getSnapshot().current` 的用法（`chat-actions.ts:217,340`），兼容。
- 我们读的宿主 DOM 全部存活，只是从 `ui-conversation` 搬进了新包 `ui-chat`：`data-chat-anchor-key`（3 文件）、`data-chat-flow-key`（2）、`data-chat-flow`（3）、`data-chat-flow-kind`（`ui-chat/src/client/chat/ChatNodeSeat.tsx:130`）、`data-conversation-scroll`（5）、`data-composer-seat`（2）、`data-streaming`（1）。文件数与基线逐一相同。
- 4 个宿主 seat 仍在：`conversation.input.dock`（9 文件）、`conversation.session.header.utilities`（4）、`settings.section`（11）、`shell.overlay`（3）。其余 8 个"NOT FOUND"的 id 是我们自己的翻译键 / 动作 id，不是宿主 seat。
- 设计 token：我们用 23 个 `--dsw-alias-*`，rc.1 定义了 19 个；另 4 个（`state-error`、`surface-l2/l3`、`text`）**在基线上也从未定义过**，我们全部带 fallback 使用，无回归。定义文件位置不变：`packages/client/ui-theme/src/styles/design-platform.css`。
- `ctx.settingsScope.bind`（我们的 settingsPersistence 探针）在 rc.1 仍是官方用法（`client/locale/src/client/index.ts:540` 等）。
- `ctx.layout` 上游只有 `toggleSidebar`（`ui-layout/src/client/service.ts:25`），**没有任何 Settings 动词**——`openSettings/toggleSettings` 继续 fork-only。
- CSS Custom Highlight API 是平台能力，与宿主版本无关。
- 命令面（bootstrap/launcher 用到的）全部原样：根脚本 `dsh`、`pnpm build`、`plugin --profile web add`、`--dump-config`、`web` 别名、`--trusted-host`、`packageManager: pnpm@11.7.0`、`engines.node ^22.19.0 || >=24.0.0`。
- 我们**不**按显示文字锚定任何宿主 UI（社区卡 R-13 的坑），grep 为空。

### 2.3 需要真机验证、静态查不出的

- `ctx.remote.session.create` 的参数布局与返回形状（B2）。
- `waitForSessionListed` 对 rc.1 `SessionListState.phase` 的语义（新字段，"empty-with-ready 才是真的没有会话"）。
- cordis 双副本：#5120 报告 alpha.2 起宿主要求 `^4.0.2`，本地若解析出两份 cordis，`declare module '@deepseek-ai/cordis'` 增广**静默失效、typecheck 全绿**。我们有两处增广（`src/client/index.tsx:39`、panel-compat `index.ts:9`）。在 profile 里 cordis 是宿主符号链接过来的单副本，理论上没事，但要在真机上确认增广生效（例如 `ctx.workbench` 一类的自定义服务能否取到）。

---

## 3. Fork：不是 rebase，是在搬过家的树上重做

### 3.1 探针结果（在临时 worktree 上把 8 个 fork 提交按顺序 cherry-pick 到 `dsh-v0.1.2-rc.1`，冲突即跳过继续）

| 提交 | 结果 | 冲突 | 性质 |
|---|---|---|---|
| `adac43f6a` 多会话呈现协议 | **冲突** | 46 文件 / 69 块；其中 6 个 `DU`（上游删了我们改的文件） | 见 3.2 |
| `9a9c327a6` 回收被替换的 pane scope | 冲突 | 6 / 8 | 依赖上一条 |
| `53015a6f3` e2e 快照 | 冲突 | 4 / 2 | 快照路径整个搬了（`snapshots/web/...`） |
| `5adeadf3d` 拖放监听按 pane 隔离 | 冲突 | 3 / 5 | 只有 README 与 CSS，源码 `DropOverlay.tsx` 上游 0 次改动 |
| `be23380af` `openSettings()` | 冲突 | 9 / 15 | `ui-settings-general` 上游改了 5 次 |
| `8b5c7992b` cmd.exe 引号 | **干净** | — | 唯一一个 |
| `1a8cf5ba4` 不安全参数拒绝 | 冲突 | 仅 `knip.json`（上游删了 knip） | 丢掉这一块即可 |
| `82de604af` `toggleSettings()` | 冲突 | 6 / 11；含 2 个 `DU`（我们新增的 `stores.ts` 上游同名新增了） | 需要合并两份 |

### 3.2 为什么大的那条不能 rebase：树搬家了

| 我们打补丁的位置（基线） | rc.1 位置 |
|---|---|
| `packages/client/runtime/src/client/sessions/{service,presentation}.ts`、`contract/sessions.ts` | `packages/api/session-controller/src/client/...`（**runtime 包整个不存在了**，`packages/client/runtime` 目录消失） |
| `packages/client/ui-renderer/src/client/session-provider.tsx` | `packages/client/ui-session/src/client/session-provider.tsx`（**新包** `@deepseek-ai/dsh-client-ui-session`） |
| `packages/client/ui-conversation/.../chat/*` | `packages/client/ui-chat/...`（**新包**；release notes 里的"会话视图工程大幅拆分"） |
| `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` | 同路径，但上游改了 **51 次** |

总计：基线 234 个包 → rc.1 256 个；9 个路径消失、31 个新增。

### 3.3 意外：上游自己实现了我们一半的东西

rc.1 有一层**按 id 的会话绑定**，是 #2418（seam 1 + 3）、#4718 里 denial123789 的第 1 条、以及我们 fork 的 `provideInfoOf(id)` 三方各自独立发明的同一个原语：

- `sessions.binding(id: SessionId): SessionBinding | undefined`（`api/session-controller/src/client/contract/sessions.ts`）；`SessionBinding = { sessionId, session: SessionFace, eventSource, ctx: AgentContext }`
- `UiSession` 服务：`bindings = Map<SessionId, MaterializedBinding>`，`adapter.resolve(key)`、`adapter.renderArea`（`client/ui-session/src/client/index.ts:213-256`）
- 渲染器侧 `SlotScopeAdapter { current; resolve(key); renderArea? }`（`client/ui-slots/src/renderer.ts:90`）
- 上游自己的消费者：`ui-chat/src/client/apply.ts:107`、`ui-conversation/.../apply.ts:142,345`、`historical-images.ts`、`ui-goal`

**这意味着 fork 的呈现协议在 rc.1 上可以瘦一大圈**：

| fork 原来做的 | rc.1 上 |
|---|---|
| `provideInfoOf(id)` 按 id 的渲染包 | **删掉**，改用 `sessions.binding(id)` |
| 改写 `SessionProvider` 支持显式 id | **删掉**，`UiSession.adapter.resolve(key)` + `renderArea` 已经是这个 |
| `presentation.ts` 状态机（visible/focused/capacity）+ 契约面 `sessions.presentation` | **保留**，搬到 `api/session-controller/src/client/sessions/` |
| `AppFrame` 双栏网格 + 分割比持久化 | **保留**，重做（`AppFrame.tsx` 上游改了 2 次，+109 行的补丁要重新对齐） |
| 渲染器：session 作用域 seat 按可见 pane 各实例化一份 | **保留但形态变了**：现在是让 `SlotScopeAdapter.current`（单一"当前"）变成按 pane 解析——`bindings.tsx:141` 只订阅 `adapter.current` 这一处是要改的点 |
| `slot-catalog.ts` 新增 seat 声明 | 重做，对着 51 次改动之后的目录 |

### 3.4 量级估计

| 块 | 估计 | 依据 |
|---|---|---|
| 呈现协议重做（含单测、e2e 快照） | **2–4 天** | 原补丁 ~600 行生产代码；一半被上游原语替代，另一半要在陌生的新目录里重新落位；e2e 快照路径整个变了 |
| 拖放隔离、两个 Settings 动词 | 半天 | 冲突多但机械；`stores.ts` 要和上游同名文件合并 |
| Windows 引号两条 | 1 小时 | 一条干净，一条只丢 `knip.json` |
| **合计** | **3–5 天** | 假设由熟悉原设计的人做 |

---

## 4. 产品重叠：上游做了什么我们也做了的

### 4.1 回合导航（**需要你决定**）

上游 rc.1 新增 `TurnNavigator`（`ui-chat/src/client/chat/TurnNavigator.tsx`，222 行）：

- 挂在**每个 `ChatView` 的滚动容器内**（`ChatView.tsx:756`）——天然每个 pane 一条，不需要我们的 per-Pane 处理
- `position: sticky` 贴在**右侧沟槽**，宽 28px，`z-index: 7`（`TurnNavigator.module.css`）
- 悬停 / 聚焦有预览卡（提示词一行 + 回复三行）
- **覆盖尚未加载的历史回合**（`item.anchor.kind === 'unloaded'` 会先翻页再跳）——我们的 Navigator 做不到，我们只索引已渲染 DOM

我们的 Navigator：注册在 `conversation.session.header.utilities`，rail 用 `position: fixed` 贴右侧（`navigator.tsx:335-338`）。**两条栏画在同一条沟槽里。**

| 选项 | 后果 |
|---|---|
| **A. rc.4 退役 Navigator（推荐）** | 上游版本每一维都不弱于我们（每 pane、预览、未加载回合），且是宿主自己维护；我们少一块 DOM 启发式代码。快捷键 `Primary+Shift+O` 与 `conversation.navigator.toggle` 动作一起退；README 能力表一行删掉；`docs/assets` 的 Navigator 截图作废 |
| B. 保留并避让 | 得给 rail 让出 28px + 一条与上游栏不同的位置；两条平行导航栏对用户是噪音 |
| C. 保留、隐藏上游的 | 不可能——没有 seam 关掉宿主的栏，硬盖是 DOM 篡改 |

**同一条沟槽还影响划词徽标**：`placeQuoteBadge` 把徽标放在 `rowRect.right + 4`（`quote-highlight.ts:325-342`），现在那里有一条 28px 的 sticky 栏。无论 Navigator 去留，**徽标落点必须避开这条带**（比如落在栏左侧、或改到行内末尾）。这是 rc.4 的必做项，不是可选项。

### 4.2 其他重叠

| 上游变更 | 对我们 | 结论 |
|---|---|---|
| "关闭设置窗口后焦点回到入口" | 只是焦点归还，**没有**新增任何 open/close/toggle 动词 | Settings 动词继续 fork-only |
| "输入框中的引用在相邻编辑后仍保持有效" | `ReferenceInsert`/`TokenSpan` 仍导出；`ReferenceCodec` 撤出索引（B5） | 类型修一下；语义上对我们只有好处，但要真机验证我们的 token 在编辑后是否还被识别 |
| "会话流正文宽度可自适应/拖拽" | 沟槽宽度变成用户可变 | 徽标落点计算要读实时 `rowRect`（已经是），并避让 TurnNavigator 带 |
| 连接状态 UI + 自动重连 | 我们读 `services.connection` 只为拿 `api`（B2 会改掉） | 无额外影响 |
| 第三方界面语言 | 我们自带 zh/en 字典，通过 `t` 注入 | 未核；见「未验证」 |
| 插件列表分组 / 模型页登录 | 不涉及 | — |

---

## 5. 安装链与发布门禁（rc.4 要动的位置）

来自完整跑通的安装链审计，逐条有 `file:line`：

1. **peer 与契约**：10 个 peer + dev → `0.1.2-rc.1`；`release-contract.json` 四个字段（`workbenchVersion` 0.2.0-rc.4、`harness.upstreamVersion` 0.1.2-rc.1、`harness.upstreamCommit` a66e4702…、fork 重做后的 `branch` + `implementationCommit`）；`packages/dsh-workbench/src/client/contract.ts:11` 的 `version: '0.1.1-rc.2'`（启动守卫展示给用户的字符串）及其 3 处测试字面量；panel-compat 的两处 `dsh-client-runtime` 钉点整个删掉。
2. **两个 bootstrap 脚本**各 6 个常量：fork 分支、`HARNESS_COMMIT`、`HARNESS_UPSTREAM_BASE_COMMIT`、`WORKBENCH_VERSION`、`RELEASE_BASE_URL`、TGZ 摘要（第二趟盖章）。`bootstrap.test.mjs:225` 那个硬编码的 `HARNESS_COMMIT` 常量手改。
3. **文档扫描会自动变红**（这是 rc.3 加的绊线在起作用）：`upstreamVersion` 一改，README×2 / COMPATIBILITY_MATRIX / KNOWN_ISSUES 里 7 处 `0.1.1-rc.2` 全部报错，逐条改成 `0.1.2-rc.1`；INSTALL.md 的 `$HarnessCommit = '…'` 字面量与契约钉死。
4. **门禁补洞**（rc.3 审计发现、本次再确认）：`harness.upstreamCommit` 没有任何检查读它但两个安装器都刻了它；`e2e/harness-web/README.md:11-12` 在扫描名单之外；`bootstrap.test.mjs:225` 应改为从契约读取。三处都是小时级。
5. **`dsh web` 现在打印并打开带一次性 token 的 URL**（`bundle/web-app/src/index.ts:271-284`），裸 `http://127.0.0.1:<port>` 回 401。launcher 不用改；INSTALL.md「装完之后」加一句"复制打印出来的 `?token=` URL"。
6. **升级路径**：安装器拒绝已存在的目标目录（`ps1:311-315`），UNINSTALL 让用户删整个 `<target>`（含 `home/` 里的 Session）。rc.1 本身**不做不可逆迁移**（Session 格式两侧都是 v0；投影缓存按记录引导、旧文件不删）——所以 rc.3 → rc.4 只需写一段"把 `<target>/home` 挪开、装、挪回"的说明，或给安装器加 `--keep-home`。**格式 v2 只在 0.1.3-alpha.1**，这是不选它的又一个理由。
7. **Node 24.0–24.11.1**：rc.1 修了一个上游 loader bug（`vendor/README.md:51`：这些 Node 版本上 `dsh web` 会给出空的客户端模块图，插件客户端半边永远不挂载）。rc.3（基于 rc.2）**受此影响**——应补进 KNOWN_ISSUES，并在 rc.4 notes 里说明修复来自 pin 推进。
8. **fork 保护 tag**：`dsh-workbench-v0.2.0-rc.4-pin` 打在重做后的提交上；rc.2/rc.3 的两个 tag 与 `fix/plugin-spec-quoting` 分支照旧不删。
9. **Windows 隔离端到端**：rc.3 没做过（文档已如实写明）。rc.4 换了 pin、换了树，**必须做一次**，否则又是"小 diff 不是证据"。

---

## 6. 上游策略

没有 PR 通道，只有 Discussions；维护者回的是有普查、有多个消费者的帖子。rc.1 已经把"按 id 的渲染绑定"做出来了，这改变了我们该提什么：

1. **在 #4718 追加一楼**（不开新帖）：指出 rc.1 的 `sessions.binding(id)` / `UiSession` / `SlotScopeAdapter.resolve(key)` 已经覆盖了帖内 denial123789 第 1 条与 #2418 的 seam 1/3；把剩余诉求收窄到三件确定还缺的东西：① session 作用域 seat 按可见 pane 各实例化（`bindings.tsx:141` 只订阅 `adapter.current`）；② 一个能放第二列的布局 seat（#2418 seam 2、#4234 都要这个）；③ 一个薄的 `presentation` 面（visible/focused/capacity）。引 #2418、#5192、#4234、#4879 做普查——这是维护者会回的那种帖。
2. **#1420 追加一楼**：rc.1 源码仍是 `shell: true` 不加引号（`apps/cli/src/plugin.ts:264-271`），我们的 fork 有带测试的修复（`8b5c7992b` + `1a8cf5ba4`），链接过去。不求合并，求被看见。
3. 把我们的 fork 分支公开命名为"对着 rc.1 的参考实现"，在 #5120（维护者征集升级经验的帖子）里补一条 Workbench 的迁移记录——那个帖子维护者在看。

---

## 7. rc.4 范围与顺序建议

```
阶段 0  产品决定（你）：Navigator 退役与否（§4.1）。其余都不需要拍板。
阶段 1  fork 重做（3–5 天，最大块，§3）
        目标 dsh-v0.1.2-rc.1；新分支名建议 rc4/presentation-on-0.1.2
        产出：presentation 状态机 + 契约面、双栏 AppFrame、按 pane 的 scope adapter、
              拖放隔离、两个 Settings 动词、两条 Windows 引号提交
        验收：fork 自己的单测 + e2e 快照绿；`--dump-config` 能列出 workbench
阶段 2  插件适配（1 天，§2）
        B1–B5 五处；徽标避让 TurnNavigator 带；Navigator 退役（若选 A）；
        capabilities.ts 的探针跟着新 seam 走；真机验证 B2 与 cordis 增广
阶段 3  安装链 / 文档 / 门禁（半天到一天，§5）+ Windows 隔离 E2E（必做）
阶段 4  两趟盖章发布（rc.3 流程原样）
```

**不进 rc.4 的**：`0.1.3-alpha.1`（破坏性变更 + 官方承认的性能回退 + Session 格式 v2 迁移）；上游 alpha 追踪（日更，追不动）。

**pin 策略建议**：只钉上游 **rc** tag；每个上游 rc 出来后评估一次是否推进（约两周一次）；alpha 一律不钉。把这条写进 `docs/COMPATIBILITY_MATRIX.md`，免得下次再问。

---

## 8. 风险

| 风险 | 概率 | 缓解 |
|---|---|---|
| fork 重做期间上游又出 rc.2 | 中（两周节奏） | 先对着 rc.1 做完、发 rc.4；rc.2 单独评估。别追着动目标做 |
| `ctx.remote.session.create` 参数布局与描述符不符（B2） | 中 | 先在真机上打一次，拿到 wire 形状再写 fake（#5120 第 5 条的教训） |
| 徽标与 TurnNavigator 带重叠的几何在不同宽度下不稳 | 中 | 用真实 `getClientRects` 测三档宽度；这块本来就是 jsdom 测不到的 |
| cordis 双副本静默杀掉增广 | 低（profile 单副本） | 真机验证一次自定义服务可取 |
| Windows E2E 又因 GitHub 传输重置失败 | 中（rc.2 时发生过） | 本地裸镜像替换传输层的方案已有，照做；文档里如实写"未证明可达 GitHub" |

---

## 9. 未验证（写在这里，不写进正文当事实）

- `ctx.remote.session.create` 的客户端调用是否要求 `{ request }` 包装还是扁平参数（#5120 提到 `session/list` 的单参名是 `_request`）。
- 我们的 zh/en 字典注入方式在 rc.1 的"第三方语言"机制下是否仍生效（没读 `client/locale` 的新注册路径）。
- `SessionListState.phase` 对 `waitForSessionListed` 的影响（只看了类型，没看状态机）。
- TurnNavigator 在双 pane（两个 `ChatView`）下是否各自正确——上游自己没有双 pane，无从验证；只能等 fork 重做后真机看。
- rc.3（rc.2 基线）在 Node 24.0–24.11.1 上"空客户端模块图"的复现：来自上游 `vendor/README.md:51` 的自述，没有本机复现。
- 上游有没有在 rc.1 → HEAD 之间再动 `TurnNavigator` / `ui-session`（只核了 rc.1，0.1.3-alpha.1 没逐文件看）。

---

## 附：本次评估的方法与证据位置

- 上游三个 tag 以 `--depth=1` 拉进本地 fork 克隆（`E:\wyx_code\Vibe coding\deepseek-harness`），所有 `tag:path:line` 均可用 `git show` 复核。
- rebase 探针在临时 worktree 完成后已删除；fork 主 checkout 未动（`82de604af`，`feat/toggle-settings-verb`）。冲突文件快照留在会话 scratchpad，未入库。
- 社区资料：`oh-my-dsh/dsh-plugin-upgrade-skill`（R-05 删包清单、R-11 类型迁移表、R-13 文字锚定）、#5120 首楼（20 个插件的迁移实录，B1/B2/B3 的修法与它一致）。
