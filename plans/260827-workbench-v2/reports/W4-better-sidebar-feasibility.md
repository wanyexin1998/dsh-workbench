# W4 Feasibility — Better Sidebar Panel-Toggle Adapter (Pinned Fork Surface Audit)

> Read-only investigation. Cloned the pinned fork
> (`github.com/wanyexin1998/DSH-better-sidebar`, branch
> `feat/pane-scoped-panel-mounts`) into the session scratchpad
> (`<SCRATCHPAD>/better-sidebar-fork`) and audited its client-side public
> surface against `release-contract.json`'s `panelCompatibility` block and
> `plans/260827-shortcuts-open-actions/design.md` §3 L3 / §6 W4. Cross-checked
> against `packages/dsh-workbench-panel-compat/src/client/*` (this repo) to
> confirm no duplication. No file outside this report was modified.

## English summary

The clone's `HEAD` (`91e772a09e5f66a14c36036f69adb4d866f06ac3`) matches the
pinned `implementationCommit` exactly (no re-fetch needed), and `package.json`
version `0.16.1` matches the pinned `providerVersion`. Findings:

- **(a) No public toggle/open/close verb exists for the panel itself.** The
  only versioned capability (`panes`, protocol 1) is a pure DOM-mount face
  already fully consumed by `panel-compat`'s coordinator — it has no
  visibility control. `BetterSidebarService.openTab` can *incidentally*
  expand a collapsed panel, but only for content-bearing seeds (`path`/`url`),
  never closes it, and is not part of the declared `SIDEBAR_FEATURES` list.
  The real toggle (`togglePanel`/`toggleBottomPanel`, `state.ts:680-686`) is a
  private reducer over a `SidebarStore` that is never returned to any caller
  outside the fork's own React tree.
- **(b) The fork registers zero slash commands.** No dependency on
  `@deepseek-ai/dsh-commands`, no `CommandRuntime` reference anywhere in
  `src/`, and `dsh.plugin.json`'s `contributes` block only declares empty
  `tools`/`skills` arrays. W2's host-command bridge therefore surfaces
  **nothing** from Better Sidebar today — there is no redundancy to report,
  because there is no overlap at all.
- **(c) Minimal fix, owned by the fork:** register one input-less slash
  command (e.g. `/sidebar-toggle`) that calls the existing internal
  `togglePanel` reducer. This is recommended over a new versioned
  `sidebar.actions` capability face, because a command is picked up by W2's
  bridge automatically — zero Workbench-side code, no `release-contract.json`
  entry, no new fail-closed governance path to build and maintain.
- **(d) A Workbench-side W4 adapter, as originally scoped (a pinned
  capability-face adapter), is not warranted right now.** There is nothing
  public to adapt without either touching private DOM/store (forbidden by
  design.md principle 2) or shipping a brand-new versioned face on both sides
  for a feature a one-line fork-side command already gets for free through W2.
  Recommend re-scoping W4 to "patch the fork to register a command; rely on
  W1+W2" and dropping the Workbench-side adapter unless the maintainer later
  needs multi-verb panel control a single slash command cannot express.

---

## 方法说明

用 `git clone --depth 1 --branch feat/pane-scoped-panel-mounts` 把
`release-contract.json` 的 `panelCompatibility` 块锁定的分支拉到 scratchpad；
`HEAD` 直接等于锁定的 `implementationCommit`（`91e772a0...`），未发生分支漂移，
无需按 SHA 二次 fetch。随后对 `src/client/*`(客户端公开面)、`dsh.plugin.json`
(插件清单)、`src/index.ts`(host 半部)做了穷举式 grep + 通读，并与本仓库
`packages/dsh-workbench-panel-compat/src/client/*` 的现有消费方式做了交叉比对，
确认两者边界不重叠。

---

## 1. Fork 表面清单（含 file:line）

> 以下路径均相对于克隆目录根 `<SCRATCHPAD>/better-sidebar-fork`，除非另注明为
> 本仓库（`dsh-workbench`）内的路径。

### 1.1 版本与提交核对

- `package.json:3` — `"version": "0.16.1"`，与 `release-contract.json` 的
  `panelCompatibility.providerVersion` (`0.16.1`) 一致。
- `git log -1` HEAD = `91e772a09e5f66a14c36036f69adb4d866f06ac3`，与
  `panelCompatibility.implementationCommit` 完全一致（无需按 SHA 重新 fetch）。

### 1.2 Cordis Context 声明 / 服务发布

- `src/context-types.ts:590` — `declare module '@deepseek-ai/cordis' { … }`
  （Context 增强声明入口；`src/index.ts:60` 转出）。
- `src/client/index.tsx:119-129` — 每次客户端插件激活创建**一个**
  `sidebarStore`，构建 `service = createBetterSidebarService(sidebarStore)`，
  挂上 `service.panes = paneCapability`，最终 `ctx.provide('betterSidebar', service)`
  发布为 Cordis 服务键 `betterSidebar`（全局单例,按 session 的隔离靠内部
  `attachPaneStore`/`scope` 参数,不是多实例服务）。

### 1.3 公开服务接口 `BetterSidebarService`

`src/client/service.ts:346-432`（接口定义）：

- `registerTab` / `registerFileViewer` / `getTabs` / `getFileViewers` / `getTab`
  — 第三方 tab / 文件预览器注册面（与"面板可见性"无关）。
- `openTab(seed, scope?)` / `closeTab(tabId, scope?)` / `activateTab(tabId, scope?)`
  / `updateTab(tabId, patch, scope?)` — **tab 级**操作，非**面板级**。
- `getSnapshot()` / `subscribeState(listener)` — 只读快照订阅（`SidebarSnapshot`
  含 `state.panelOpen`/`state.bottomOpen`，但无写入口）。
- `openFile(scope, path, title?)` — `openTab` 的语法糖。
- `attachPaneStore(sessionId, store)` — 仅供 fork 自己的 `mountPane` 内部调用
  （`src/client/pane-mount.tsx:62`），非外部消费入口。
- `panes?: BetterSidebarPaneCapability` — 见 1.4。
- `readonly version: string`（`SIDEBAR_SERVICE_VERSION = '0.16.1'`,
  `service.ts:501`）与 `readonly features: readonly string[]`
  （`SIDEBAR_FEATURES`, `service.ts:520-533`）：monotonic 能力清单为
  `badge, tabLifecycle, updateTab, openFile, targetedOpen, stateSubscription,
  tabMeta, pluginSettings, urlTarget, settingSelect, floatWindows, paneMount`
  ——**没有任何 "panelToggle"/"panelVisibility" 字样的 feature**。

### 1.4 `panes` 能力面（`release-contract.json` 治理的对象）

- `src/client/service.ts:450-454`：
  ```ts
  export interface BetterSidebarPaneCapability {
    readonly protocol: 1
    readonly activeCount: number
    mountPane(target: BetterSidebarPaneTarget): BetterSidebarPaneAttachment
  }
  ```
  只有 `mountPane`（把 fork 自己的 React 根挂到 Pane 的 `rightHost`/`bottomHost`）
  和只读 `activeCount`。**没有 open/close/toggle 语义**——纯粹是"挂载点"协议,
  不是"可见性"协议。
- `src/client/pane-mount.tsx:26-117` — `createPaneCapability` 的实现：
  `mountPane` 内部为每个 `sessionId` 新建**私有** `SidebarStore`
  (`pane-mount.tsx:59`)，渲染 `<Sidebar store={store} .../>`，但返回给调用方的
  `BetterSidebarPaneAttachment` **只有** `update(target)`/`dispose()`
  (`pane-mount.tsx:99-110`)——那个私有 `store`（唯一能写 `panelOpen`/`bottomOpen`
  的入口）从未被返回或以任何方式暴露给挂载方。即便是**已经持有 `panes` 能力**的
  `panel-compat`，也拿不到它。

### 1.5 真正的面板开关（私有,不可达）

- `src/client/state.ts:680-681`：
  ```ts
  export function togglePanel(state: SidebarState): SidebarState {
    return { ...state, panelOpen: !state.panelOpen }
  }
  ```
  `state.ts:685-686` 同理有 `toggleBottomPanel`。两者都是**纯 reducer**，只在
  `src/client/service.ts:767,773`（`openTab` 内部,见 1.6）与
  `src/client/Sidebar.tsx:583,617,638,1408`（面板自己的展开/折叠图标按钮的
  `onClick`）里被调用——从未通过 `service.ts` 的公开接口、`index.ts` 的
  re-export，或任何 Cordis 事件对外暴露。

### 1.6 `openTab` 的"顺带展开"行为（非通用 toggle）

- `src/client/service.ts:744-776` — 仅当 `seed.path !== undefined ||
  seed.url !== undefined`（即"打开一个带内容的 tab"）且目标面板当前折叠时才
  `return togglePanel(landed)`/置 `bottomOpen: true`；**类型-only 的打开
  （+ 菜单式）明确不展开**（文档注释 `service.ts:384-386`:
  "Type-only opens … never expand"）。且**只会展开，从不折叠**——不是双向
  toggle，语义也是"打开一个 tab 顺带露出"而非"切换侧边栏可见性"。

### 1.7 斜杠命令 / Host commands 依赖（回答问题 b 的证据）

- `package.json` 全文 grep：仅 `pnpm-lock.yaml` 里因传递依赖出现
  `dsh-commands` 字样，**本包自身 `dependencies`/`peerDependencies` 不含
  `@deepseek-ai/dsh-commands`**。
- `src/` 全目录 grep `dsh-commands|CommandRuntime|registerCommand`
  — **零匹配**。
- `dsh.plugin.json:1-15`：
  ```json
  "contributes": { "tools": [], "skills": [] }
  ```
  没有任何 `commands` 键，manifest 层面确认零斜杠命令声明。

### 1.8 Cordis 事件

- 全 `src/client` grep `$on|.emit(|events.` 仅命中 `index.tsx:311-312`
  （消费 `remote.$on('settings/document-updated', …)`，是 fork **订阅**
  host 的设置变更事件,不是 fork **发出**任何面板相关事件）与若干无关的
  `onClick`/`onChange` 等 React props 命名噪音。没有 `panel-toggle` 之类的
  自定义 Cordis 事件。

### 1.9 panel-compat 侧确认（本仓库,`packages/dsh-workbench-panel-compat/src/client/*`）

- `better-sidebar.ts:14-24` — `betterSidebarAdapter()` 只结构化检查
  `panes.protocol === 1 && typeof panes.mountPane === 'function'`，**主动
  忽略** `service.ts` 上其余的方法（`openTab` 等）——现有治理先例本身就是
  "只认一个具名能力面,其余当作不存在"，而不是"拿到完整 service 就可以随意调用"。
- `coordinator.ts` 全文只调用 `adapter.attach(target)`（=`mountPane`）与
  `attachment.update/dispose`，**不涉及任何面板可见性状态**。
- `index.ts:4`（`dsh-workbench-panel-compat/src/index.ts`）—— host 半部
  `apply(_ctx) {}` 是空实现,确认整个适配是 browser-only。
- 结论：panel-compat 现有代码里**没有**已经做了、可能与假想 W4 重复的
  toggle 逻辑；两者完全不重叠,谈不上"重复建设"的风险。

---

## 2. 问题 (a)–(d) 直接回答

**(a) 是否存在一个公开的 toggle/open/close verb,adapter 可以不碰私有
store/DOM 直接调用?**

**否。** 在锁定版本 `0.16.1`/commit `91e772a0` 上：
- `panes`(protocol 1)只是挂载协议,没有可见性动词(1.4)。
- `BetterSidebarService.openTab` 只在"打开带内容的 tab 且面板当前折叠"这一
  单向、副作用性质的场景下顺带展开(1.6),既不是通用 toggle,也没有对应的
  "关闭"操作,更不在 `SIDEBAR_FEATURES` 的正式能力清单里(1.3)——不能被当作
  稳定契约来绑定快捷键。
- 真正的 `togglePanel`/`toggleBottomPanel` 是 `state.ts` 里的私有 reducer,
  持有它的 `SidebarStore` 从未被 `mountPane` 的返回值(`BetterSidebarPaneAttachment`)
  带出来(1.4/1.5)。要够到它,唯一路径是 DOM 查询 `Sidebar.tsx:1403-1409`
  的折叠/展开图标按钮再合成点击——这正是 design.md 原则二和本任务命令都
  明确禁止的"私有 DOM 推断"。

**(b) fork 是否注册了任何 W2 host bridge 已经能桥接的斜杠命令?若有,点名。**

**没有,fork 注册的斜杠命令数量是零。**(证据见 1.7)因此不存在
"W4 对 toggle 用例而言是冗余的,因为命令已可绑定"这种情况——W2 今天对
Better Sidebar 完全没有覆盖,不是重叠,是空集。

**(c) 若不存在公开动词,fork(维护者拥有的仓库)最小需要加什么?**

推荐**注册一个不带 `input` 的斜杠命令**(例如 `/sidebar-toggle`),命令处理器
内部直接调用已经存在的 `togglePanel`(`state.ts:680-681`)去 reduce 对应
session 的 `SidebarStore`。理由——对比另一个可选方案"新增一个版本化的
`sidebar.actions` 能力面"(结构上模仿 `BetterSidebarPaneCapability`,例如
`{ protocol: 1, toggle(sessionId): void }`):

| | 斜杠命令 | `sidebar.actions` 能力面 |
|---|---|---|
| fork 侧改动 | 一次 `commands.register(...)` 调用 | 新接口 + 版本号 + 在 `service.ts` 上暴露 |
| Workbench 侧改动 | **零**——W2 的 `remoteCommands.list()` 自动发现 | 需要新写一个 L3 adapter(结构检查 + `release-contract.json` 登记 + fail-closed) |
| 治理负担 | 复用 W2 已built 的 fail-soft/订阅/绑定机制 | 复制一遍 panel-compat 那一整套"精确版本锁定"治理 |
| 用户可绑定 | 立刻可绑定(W1 的 provider 分组会自动出现 "host" 组下的新命令) | 要等 W4 adapter 上线才可绑定 |

**斜杠命令路线在两侧代码量、治理复杂度、上线时间上都更优**,推荐这条。

**(d) 综合 (a)-(c),Workbench 侧 W4 适配器是否仍然值得做?范围应该是什么?**

**按原设计(为 `panes` 或某个未来能力面写一个 pinned-version L3 adapter)不再
值得做**——因为当前压根没有可适配的公开动词((a)),而"造一个能力面来适配"
比"让 fork 直接注册一条命令"成本更高、收益相同((c))。

**建议重新定界 W4**:
> W4 = 在 fork 仓库(维护者自己的 repo,不在 dsh-workbench 树内)补一条
> input-less 斜杠命令,调用其已有的 `togglePanel`;dsh-workbench 侧
> **不写任何新代码**,完全依赖已经交付的 W1(动态目录 + provider 分组 UI)
> 与 W2(host 命令桥,已合并)自动发现并允许绑定。`release-contract.json` 的
> `panelCompatibility` 块保持不变(它治理的仍然只是 `panes` 挂载,与这条命令
> 无关,无需新增字段)。

只有当维护者后续需要**单个字符串参数表达不了的多动词面板控制**(例如
分别独立开关 right/bottom 面板、指定 Pane 而非仅隐式作用于"当前 focused
session")时,才值得回头考虑一个真正的 `sidebar.actions` 能力面 + 对应的
Workbench 侧 L3 adapter——到那时它的治理形状应完全复刻
`better-sidebar.ts` 现有的 `betterSidebarAdapter()` 写法:结构化检查
`actions.protocol === 1 && typeof actions.toggle === 'function'`,版本不符
fail closed,零 DOM 推断。

---

## 3. 风险与未决点

1. **命令应保持 input-less。** 若 fork 把 `/sidebar-toggle` 声明成带
   `input` 的命令,W2 会强制其永远走"插入 composer"路径而不允许直接执行
   (`packages/dsh-workbench/src/native-ux/client/host-commands.ts:150-153`
   的 has-input 命令禁止 direct-execute 规则)——这会让"快捷键切换侧边栏"
   变成"快捷键把 `/sidebar-toggle ` 打进输入框,还要再按一次 Enter",体验上
   基本失去了"快捷键"的意义。这是 fork 维护者需要注意的设计细节,不是
   Workbench 侧能补救的。
2. **`command/run`/`command/done` 会落会话日志。** 即便命令本身
   input-less、用户开启了 direct-execute,每次按快捷键仍会在会话记录里
   留下一条痕迹(W2 的既有设计,`host-commands.ts` 顶部注释已说明)——对于
   一个纯 UI 状态切换(不产生任何"给模型看的"内容)而言,这是可接受但值得
   跟维护者提一句的副作用,W2 v1 默认"插入 composer"正是为了让用户在按
   Enter 前看到这一点。
3. **多 Pane 场景下命令应该切哪个 SidebarStore,是 fork 自己要处理好的事。**
   `attachPaneStore`(`service.ts:428`)按 `sessionId` 维护多个独立
   `SidebarStore`(`pane-mount.tsx` 里每个 mounted Pane 一个);W2 捕获的是
   "keypress 那一刻聚焦 Pane 的 sessionId"
   (`host-commands.ts` 的 async-identity 规则)。命令处理器若不小心切到了
   `attachPaneStore` 之外的那个"主"`sidebarStore`(`index.tsx:119`),在双 Pane
   下就会切错侧边栏。这是 fork 侧需要验证的正确性问题,本次只读调查未做
   端到端验证,留作未决点。
4. **本报告的"公开面"结论只对 `0.16.1`/`91e772a0` 这一个精确版本成立。**
   与 `panelCompatibility` 现有治理方式一致——分支或版本一旦漂移即需要
   重新走一遍本次的表面审计,不能假设结论对后续版本仍然成立。
