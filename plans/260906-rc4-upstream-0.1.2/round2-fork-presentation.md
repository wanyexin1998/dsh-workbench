# Round 2 · fork：在 0.1.2-rc.1 上重做多会话呈现协议

> 给实现者的设计简报。基线事实全部对着 `dsh-v0.1.2-rc.1` 与 fork 原提交核过，引用形式 `tag:path:line` 或 `<sha>:path`。原则：**上游已有的原语一律复用，fork 只补它没有的三样东西。**

## 0. 你要交付什么

在分支 `rc4/presentation-on-0.1.2`（worktree `E:\wyx_code\Vibe coding\harness-rc4`，基线 `a66e47020` + round 1 的 5 个小提交之上）实现 Session Presentation protocol 2，使 DSH Workbench 的分屏模块能在这个 fork 上激活。**验收面**是 Workbench 的启动守卫（`packages/dsh-workbench/src/client/guard.ts`）：它要求 `sessions.presentation` 存在、`protocol === 2`、`requestCapacity` 是函数、`state.getSnapshot()` 返回 `{ visible: Array, capacity: number }` 且不抛。

## 1. 上游 rc.1 已经有的（复用，别重造）

| 原语 | 位置 | 用途 |
|---|---|---|
| `sessions.binding(id): SessionBinding \| undefined` | `api/session-controller/src/client/contract/sessions.ts`；`SessionBinding = { sessionId, session: SessionFace, eventSource, ctx: AgentContext }` | 按 id 取一个会话的绑定 |
| `UiSession`（服务名 `uiSession`）：`bindings: Map<SessionId, MaterializedBinding>`、`adapter.resolve(key)`、`adapter.renderArea` | `client/ui-session/src/client/index.ts:213-256, 343, 405` | 每个已物化会话一份 `ScopedStandardSourceBinding` |
| `SlotScopeAdapter { current; resolve(key); renderArea? }` | `client/ui-slots/src/renderer.ts:90` | 渲染器的作用域适配器契约 |
| `ctx.slots.installScope('session', service.adapter)` | `client/ui-session/src/client/index.ts:513` | 'session' 作用域只安装这一份适配器 |
| `ScopeProvider({scope})` 订阅 `adapter.current` | `client/ui-renderer/src/client/bindings.tsx:130-143` | **当前只有一个**，跟着 `list.current`（= focused）走 |
| `renderSessionArea(binding, {empty, children})` | `client/ui-session/src/client/session-provider.tsx:13-19` | 已经接受**显式 binding** 作为参数 |
| `ObservableSnapshot`、`notifySubscribers` | `@deepseek-ai/dsh-client-store` | 快照引擎 |

**结论**：fork 原来的 `provideInfoOf(id)`、`PerIdProvideCell`、`refreshPerIdProvides`、`SessionProvider sessionId=` 改写、`ui-slots/renderer.ts` 的 `provideInfoOf` 管道、`runtime/slots.ts` 的转接——**全部删掉**，被 `binding(id)` + `adapter.resolve(id)` 取代。

## 2. fork 要补的三样东西

### 2.1 状态机 + 契约面（原样移植）

- `<82de604af>:packages/client/runtime/src/client/sessions/presentation.ts`（143 行，纯函数）→ 放到 `packages/api/session-controller/src/client/sessions/presentation.ts`。只改一处 import：`SessionId` 从 `@deepseek-ai/dsh-session/types`（rc.1 里它定义在 `packages/core/session/src/types.ts:17`）。
- 契约：`<82de604af>` 对 `contract/sessions.ts` 的追加（`SessionPresentation` 接口：`protocol: 2`、`state`、`open(id, {disposition?})`、`focus`、`close`、`requestCapacity`）→ 追加到 `api/session-controller/src/client/contract/sessions.ts` 的 `ISessions`，**去掉** `provideInfoOf` 那一段。
- 服务：`<adac43f6a>:packages/client/runtime/src/client/sessions/service.ts` 的呈现部分 → `api/session-controller/src/client/sessions/service.ts`。要移植的成员：
  - `presentationSnapshot`、`presentationCapacityRequests`（max-wins）、`watched`
  - `presentation` 面的构造（`state` 直接复用 `list` 的订阅：`getSnapshot: () => this.list.getSnapshot().presentation`）
  - `openPresentation / focusPresentation / closePresentation / requestPresentationCapacity`
  - `followPresentation()`：成员进入 visible 时 `record.session.open()` + `refreshSubagents`，**由成员关系而非焦点决定事件窗口生命周期**
  - list 投影里的 `reconcile` → `focus`/`open` 那段，把 `presentation` 并进 `SessionListState`
  - **`9a9c327a6` 的修正必须带上**：被顶掉的 pane 一律 `retireScope`，不只限于 `beside` 分支（原 diff 见该提交 service.ts）
  - 选子代理（`selectSubagent`）与清空列表（`clear`）时的呈现状态处理（原 diff 里有）
- `SessionListState` 新增字段 `presentation: SessionPresentationState`（`service.ts` 里的 interface）。
- 不变量审计：`<adac43f6a>:packages/client/runtime/src/invariant.ts` 的 `ctx.inject(['sessions'], …)` 审计块（visible 去重、≤ capacity、focus 与 visible 空性一致、focused ∈ visible、`current === focused`）→ rc.1 客户端侧不变量文件在 `packages/client/ui-renderer/src/invariant.ts`；如果那里的模式不同，就近放到 session-controller 的 client invariant，**但审计逻辑一行不少**。

### 2.2 按 pane 的作用域绑定（新写，这是唯一的"设计"）

rc.1 只有一个 `ScopeProvider`，绑定 = `adapter.current`。双 pane 需要**每个 pane 用自己的 binding 渲染 session 作用域的 seat 树**。

做法（最小改动）：

1. `ui-renderer` 导出一个显式绑定的 provider：`ScopeProviderFor({ binding: ScopedStandardSourceBinding; children })`，内部就是 `<ScopeBindingContext.Provider value={binding}>`。`bindings.tsx` 里 `ScopeBindingContext` 已经存在，只是没导出这个形态。
2. **必须核实** `registry.ts:326 bindStoreScope(binding)` 与 `:539` 的调用时机：它在哪一步把绑定的 store scope 登记进去？如果它只在 `adapter.current` 变化时登记，那么按 id `resolve()` 出来的第二个 binding 也要走一遍 `bindStoreScope`，否则第二个 pane 的 store hook 会读到未登记的 scope。把结论写进代码注释。
3. `AppFrame` 双栏：`<adac43f6a>` + `<9a9c327a6>` 的 `AppFrame.tsx` 补丁（`+109` 行）按 rc.1 的 `AppFrame.tsx`（218 行，三栏网格，`CenterColumn` 在 L31）重做。原补丁里 `<SessionProvider sessionId={sessionId}>` 换成：`const binding = uiSession.adapter.resolve(sessionId)`，`binding` 为 undefined 时渲染空态，否则 `<ScopeProviderFor binding={binding}>{renderSlot('conversation', {})}</ScopeProviderFor>`。`AppFrameInjected`（`presentationActions`、`splitRatio`、`hooks.splitRatio`、`t`）沿用 `9a9c327a6` 定型后的 `InjectFace` 形态。
4. `data-session-pane={sessionId}`、`data-focused`、`data-session-split`、`data-split-narrow`、`onPointerDownCapture → focus` 这些 DOM 契约**一个字都别改**——Workbench 的 panel-compat 与 e2e 快照都靠它们。
5. `session.pane.right` / `session.pane.bottom` 两个 seat：`<adac43f6a>` 对 `ui-layout/src/client/index.ts` 与 `cordis-client-runner/src/client/slot-catalog.ts` 的追加。slot-catalog 上游改了 51 次，**对着现在的目录格式重写条目**，不要硬贴旧 diff。
6. 分割比持久化（`splitRatio`，clamp 0.30–0.70）与 `ui-layout/src/client/locales.ts`（`pane.untitled` / `pane.focus` / `pane.close`）原样带上；rc.1 的 `ui-layout` 是否已经有 locales 文件，先看再决定合并还是新建。
7. `columns.ts` 的 `SPLIT_MIN_CENTER` 常量与 `splitNarrow` 降级（窄屏只显示 focused pane）原样带上。

### 2.3 拖放隔离与 Settings 动词

round 1 已经把 `5adeadf3d`、`be23380af`、`82de604af` 挑上来了（分支上现在是 5 个提交：`a250ed6fb`、`22e6d46ae`、`f6e36224c`、`cd82db7f4`、`16b869097`，全部通过各自包的测试与类型检查）。你这轮只需确认双 pane 下 `DropOverlay` 的监听确实按 `data-session-pane` 隔离——round 1 之前 `[data-session-pane]` 在分支上根本不存在，那条路径只被替身测过；你的 AppFrame 落地之后它才第一次对着真 DOM 跑。

**round 1 纠正过的三处，别再照旧文本做**：

- `ui-settings-general/src/client/stores.ts` 是 `be23380af` **新增**的文件，上游没有同名文件；§3.1 表里"两份 stores.ts 要合并"是探针跳过前一条提交造成的假象。它已经落地，不用碰。
- fork 自己的代码也会踩 B3：round 1 已把 `stores.ts` 的 `defineStore`/`EngineStoreHandle` 从被删的 `dsh-client-runtime/client` 改到 `@deepseek-ai/dsh-client-store`。**你移植的每一段 fork 代码都要做同样的检查**——旧 fork 的 import 里凡是 `client/runtime`、`dsh-client-runtime` 的，一律换到 rc.1 的新家（`api/session-controller`、`dsh-client-store`、`dsh-session/types`）。
- 上游 `ILayout` 除 `toggleSidebar` 外还有 `openDetails` / `closeDetails`（`ui-layout/src/client/service.ts:23-30`）；结论不变（上游没有 Settings 动词），但别在注释里写"上游只有 toggleSidebar"。

## 3. 测试

- `<adac43f6a>:packages/client/runtime/tests/presentation.client.spec.ts`（111 行）原样移植到 session-controller 的 tests。
- `<adac43f6a>` 对 `sessions-service.client.spec.ts` 的 +101 行：改到 rc.1 的测试替身（`packages/test-support/client-runtime/src/sessions.ts` 仍在，fork 原补丁给它 +101 行——同样按 rc.1 现状重写，不硬贴）。
- `ui-layout/tests/app-frame.client.spec.tsx`：双栏、窄屏降级、分割比、关闭/聚焦按钮。
- **新增**：`ui-renderer` 一条 spec，证明两个 `ScopeProviderFor` 并存时各自的 `useSession`/store hook 读到各自的会话（这是 #4718 评论区点名要的"session 作用域 seat 按可见 pane 各实例化"）。
- 不变量：把 `<adac43f6a>` 的 `tests/invariant.client.spec.ts` +20 行移植。
- e2e：`<53015a6f3>` 的 `apps/web/tests/cordis-tool-round.e2e.ts` 追加段（Ctrl+click 侧栏行 → `[data-session-pane]` 数量为 2 → 对 `[data-session-split]` 做 aria 快照）；快照文件在 rc.1 搬到了 `snapshots/web/cordis-tool-round/`，`split.expected.md` 放那里。e2e 需要真实浏览器，跑不了就把它写好、在报告里说明没跑。

## 4. 验收（我会亲自跑）

1. `pnpm --filter` 触及的每个包 `test` + `typecheck` 绿：`dsh-api-session-controller`、`dsh-client-ui-renderer`、`dsh-client-ui-session`、`dsh-client-ui-layout`、`dsh-client-ui-slots`、`dsh-cordis-client-runner`。
2. `pnpm build` 通过；`pnpm dsh --profile web --dump-config` 正常。
3. 把 round 1 产出的 Workbench TGZ 装进一个**新的、隔离的** profile（`DSH_HOME` 指到临时目录），`dsh --profile web` 启动后：守卫通过（浏览器控制台无 `guard` 失败日志）、Ctrl+click 侧栏第二个会话出现两个 `[data-session-pane]`、两边各自能输入。
4. `git log --oneline dsh-v0.1.2-rc.1..HEAD`：round 1 的 5 条 + 你的若干条，每条一件事，提交信息说明"为什么这样落位"。
5. **不许**：推送；改 fork 主 checkout；在 `session-maybe` 根作用域上做任何行为改变（单 pane 时必须与 stock 逐字节同行为——`capacity: 1` 默认值是这条协议的向后兼容承诺）。

## 5. 已知的坑

- `UiSession.publishCurrent()` 只跟 `list.current`；`current` 在双 pane 下 = focused。根 `session-maybe` 作用域继续跟 focused 走，这是对的——不要为了双 pane 去改它。
- `createMaterializedBinding` 的 release effect（`index.ts:388-394`）在 binding 被回收时把 `currentBinding` 退回 absent；第二个 pane 的 binding 被 `retireScope` 时要确认没有把**另一个** pane 的 store scope 一起清掉（`clearStoreScope(key)` 按 key 清，应该没事，但要有测试钉住）。
- `followPresentation` 里 `record.session.open()` 是幂等的（原注释）；rc.1 的 `SessionFace.open` 是否仍幂等，读一下再依赖。
- 上游 `ChatView` 每个实例都挂一条 `TurnNavigator`（sticky 右沟槽）。双 pane 会有两条，各自独立——这是期望行为，不要处理。
