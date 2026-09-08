# rc.6 结果与对前两份记录的更正

> 写于 2026-09-08，`v0.2.0-rc.6` 发布之后。
> 同目录的 [`root-cause.md`](root-cause.md) 与 [`rc6-brief.md`](rc6-brief.md)
> **有两处归因是错的**，本文更正；两份原文保留不改，因为它们是当时认知的记录。

---

## 1. 更正：随手问和划词不是同一个根因

两份记录都断言随手问「走同一层适配器读会话面，同样失效」
（`root-cause.md:56`、`rc6-brief.md:61-62`）。**错的。**

随手问根本不碰 chat 节点面。它走会话创建 RPC
（`chat-actions.ts` → `remote.session.create({ workspaceId, agentPreset: 'chat' })`）。
把每一项能力对着 pin 核过之后，RPC、请求形状、workspace 与会话列表读取、
和弦解析**全部完好**。

真因在磁盘上：`$DSH_HOME/.agent-presets/chat/` 里只有 `preset.yml`，缺宿主真正
mount 的 `agent.cordis.yml`（09-06 事故的残留），宿主回 `agent-preset/invalid`。
而播种器判「目录在 → 已播过」，于是**永久自认已播过，产品里没有任何一条路径能
自救**。修在 `5e3bf7e`：判据改成组合文件、只补缺的文件、报 `repaired`。

### 更贵的一条：现象记录混了「静默」和「有错但没细节」

`root-cause.md:10-11` 把随手问记成「没反应」「全程零报错」。它其实**弹了对话框**，
写着「无法创建聊天模式会话」。正是这一句把它并进了划词那条静默 fail-closed 的
叙事里，让第一轮排查整个跑偏。

**记现象时必须区分这两者**：有可见失败信息的路径和真正静默的路径，根因空间完全
不同。

## 2. 更正：rc.5 不是一个缺陷，是四个

`root-cause.md` 的标题是「根因」（单数），只钉住了第一个。实际有四个互不相干的：

| # | 缺陷 | 修在 |
|---|---|---|
| 1 | chat 节点表搬进 `ui-chat`，插件仍读 `snapshot.chat.nodes` | `a379cca` |
| 2 | `steering` 行不在可划词 kind 集合里（两份记录都没提过） | `a379cca` |
| 3 | 引用 span 用 clipboard 坐标传给只认 detect 坐标的 `insertReference` | `fa1d776` |
| 4 | chat 预设缺 `agent.cordis.yml` | `5e3bf7e` |

**只修 (1) 的话，用户看到的是「能划词、能加第一条引用，然后什么都不行」。**

(3) 尤其值得记：草稿里没有 chip 时 clipboard 与 detect 两套投影**逐字相同**，
所以第一条引用永远成功，这个缺陷在 rc.5 的排查里完全隐身；它是**发布之后**用户
报「保存备注说草稿已变化」才被钓出来的。

> **教训：单点插桩证明了 A 是坏的，不等于证明了只有 A 坏。**
> `root-cause.md` 用一次带日志的构建钉死了 (1)，就此收工，(2)(3) 都在同一条
> 用户可见路径上却没被看到。

## 3. brief §1.1 那个没查清的点，答案是

`uiConversation` 的注册处是 `ui-conversation/src/client/conversation/assembly.ts`
的 `super(ctx, 'uiConversation')`——cordis `Service` 构造即注册。它与插件已注入的
`'conversation'` 是**两个服务**，且**不需要**子路径条目（不同于 `remote` /
`remote.session`：`binding` 只是服务对象上的方法，不是另一个注册服务）。

选的是 `binding(sessionId).target('chat')`，没有用 `views.get('chat')`。
收窄点只有一处：`harness-adapter.ts` 的 `chatNodeSource()`。

## 4. brief §2 那三条门禁，实际交付了多少

| 门禁 | 状态 |
|---|---|
| 1. 替身按真宿主形状写 | **做了一半** |
| 2. 端到端覆盖「划词出工具栏」 | **没做** |
| 3. fail-closed 静默加日志 | **做了两条** |

- **门禁 1**：`packages/dsh-workbench/tests/host-double.ts` 已落地——15 个键逐字
  抄进 `SESSION_SNAPSHOT_KEYS`、未知 override 直接抛、`hostUiConversation()` 复刻
  「未知会话抛 / 目标未激活给 undefined」两条真行为，输入机替身也建了两套坐标并
  做过 kill test。但**它是约定不是门禁**：全仓 15 个含 `getSnapshot` 的测试文件只
  有 2 个 import 了它，没有任何检查禁止再写一个宽松的对象字面量。
- **门禁 2**：**没有自动化端到端。** `e2e/harness-web/` 里那两个文件自 rc.4 起一行
  没改，它们自己的 README 就写着是 "carriers, not a runnable suite"；
  `scripts/release-check.mjs` 九步里没有任何一步跑它；而且现存 carrier 用的正是
  brief 判定「不算数」的合成事件（`document.dispatchEvent(new Event('selectionchange'))`）。
  rc.6 真正做的是**一次人工浏览器验证**（`left_click_drag` + 真实按键，记在
  RELEASE_NOTES 的表里）。**这条门禁下一次仍然拦不住同类回归。**
- **门禁 3**：加了两条互相区分的诊断（「拿不到 chat 面」/「面在但没有 nodes」），
  按消息去重。其余 fail-closed 出口仍全部静默——包括 (2) `steering` 走的那一条，
  也就是「有的行能划有的不能」这种最难查的形态。

## 5. brief §6「还没做的」现状

| 项 | 状态 |
|---|---|
| 桌面 Tauri 壳（就绪探测认 200 / 窗口 URL 不带 token） | **已修**，见 §7 |
| 三个文档修复没推 | **已完成**，`4215409` 已在 `origin/main` |
| macOS / 只读 `$DSH_HOME` / stock 通用插件路径 | **仍未跑** |
| — 缺的第四条 → | **固定的 Better Sidebar fork 在当前基线上根本加载不了** |

最后一条是这次才发现的：`dsh-better-sidebar` 0.16.1 @ `1685770` 是对着
`0.1.1-rc.1` 建的，仍 import 上游已删的 `settingsNamespace`，加载即抛、
**整个 harness 起不来**（不是侧栏降级）。讽刺的是同一个上游删除，本仓库自己在
round 1 就适配掉了并写了长注释（`packages/dsh-workbench/src/index.ts`），
fork 从没做过这一遍。已在 `release-contract.json`、`docs/INSTALL.md` §4、
`docs/KNOWN_ISSUES.md`、两个 README、COMPATIBILITY_MATRIX 全部标注拦截。

流程侧的补救写在
[`../260906-rc4-upstream-0.1.2/round3-release-chain.md`](../260906-rc4-upstream-0.1.2/round3-release-chain.md)
新增的第 2 条：**上游基线一动，契约点名的每一个 fork 都要在新基线上真启动一次。**

## 6. 一句必须说清的话

`pnpm release:check` 九步里**没有任何一步碰浏览器、碰真实宿主、或跑 `e2e/`**。
所以「rc.6 已端到端验证」在本仓库里**不可复现**——重跑门禁只能证明单测和打包。
写结论时不要把 RELEASE_NOTES 那张手工表说成门禁产物。

## 7. 桌面 Tauri 壳已修（2026-09-08）

`E:\wyx_code\dsh-desktop`（当时**不是 git 仓库**；已于同日 `git init`，见文末）。

brief §6 记的两处，实际是同一个病根的两面：**`0.1.2-rc.1` 之后裸 `GET /` 返回
401**——根路径要鉴权，只有带 `?token=` 的 URL 才会种 cookie。

- `http_ready` 只认 `HTTP/1.x 200` → 就绪永远不成立 → 90 秒超时后 `handle.exit(1)`，
  窗口从来没机会打开。这就是「点了图标什么都没有」的真相。
- 窗口 URL 是裸的 `http://127.0.0.1:{port}/` → 就算开了也是 401。

**修法没有去猜 token，而是去读它。** CLI 每次运行都会把
`dsh web: http://127.0.0.1:<port>/?token=<token>` 打到 stdout（壳本来就把 stdout
重定向进日志），所以：

- `wait_for_ready_url()` 轮询日志尾部拿这一行——**就绪信号和 URL 一次拿到**。
  只读本次运行追加的部分（记下 spawn 前的文件长度），且按端口匹配，
  免得上一次运行恰好复用同一端口时读到旧行。
- `http_ready` → `http_answering`：接受**任何** HTTP 状态行。实测证明这是必须的：
  裸根 401，而带 token 的 URL 返回 **303**（种完 cookie 再跳 `/`）——
  **两个都不是 200**，旧判据两条路都走不通。
- 加了 4 个单元测试钉 `parse_ready_url`（取对端口、忽略别的端口、拒绝空 token、
  行没出现时返回 None）。

实测：`cargo test` 4/4 绿；release 构建出 `dsh-desktop.exe`；真跑一次——
壳进程存活（旧代码此刻早已退出）、WebView2 起来了、日志里有 token URL、
`curl` 跟随重定向落到 `200` 且页面是 `DSH Local Build`、boot 图里有
`dsh-workbench`。

### 部署与版本控制（同日完成）

- exe 从 `src-tauri/target/release/` **复制到 `dsh-desktop/` 根目录**再让快捷方式
  指过去——`target/` 是构建产物目录，`cargo clean` 一下快捷方式就断了。
  日志也跟着写在 exe 旁边。
- **桌面快捷方式已切回 Tauri 壳**，并通过快捷方式本身跑通验证（不是只验 exe）。
  旧的 cmd 启动器备份成 `DeepSeek Harness (launch-harness.cmd).lnk`——原来那个
  `.lnk.bak` 扩展名不合法，Windows 的 COM 接口读不出来。
- `git init`（`7c5a040`，62 文件 / 522K）。忽略 `target/`、`gen/schemas`、
  部署用的 exe 与日志、以及所有 `.lnk`（二进制且写死本机绝对路径）。
  补了 `src-tauri/empty/.gitkeep`——`frontendDist` 指着那个空目录，
  git 不跟踪空目录，少了它新克隆构建会失败。
- 新增 `README.md` 记住三件不写下来就会丢的事：**401/303 那条宿主契约**、
  本机 `~/.cargo` 已失而 `~/.rustup` 完好因而工具链可直接用、
  以及**验证时 curl 必须开 cookie 引擎**（`-c`/`-b`），否则 303 种的 cookie 被丢、
  跟到 `/` 报 401，看着像壳坏了——这个坑我踩过一次。

**工具链没有重装。** `~/.rustup/toolchains/stable-x86_64-pc-windows-msvc` 完好，
09-06 事故只带走了 `~/.cargo`（shim 与 registry 缓存），`target/` 那 3.3G 也在，
所以只重下了依赖源码。
