# V1–V3 Verification Gates — Host Slash-Command Bridge (W2)

> Static analysis against the locally vendored `0.1.1-rc.2` packages under
> `node_modules/.pnpm` (pnpm content-addressed store; all citations below are
> repo-root-relative paths into that store). No files outside this report
> were modified. Companion design doc:
> `plans/260827-shortcuts-open-actions/design.md` (§3, §6).

## English summary

All three gates resolve favorably against the pinned `0.1.1-rc.2` packages, with concrete, line-cited evidence:

- **V1 — PASS.** `@deepseek-ai/dsh-api-gateway`'s client half installs a real Cordis service at key `remote` (`ClientRemote`); `@deepseek-ai/dsh-api-remotes`'s client half mounts `dsh-commands`'s generated `TYPERT_REMOTE` contribution into it via `ctx.remote.$mount(...)`, producing a live `ctx.remote.commands.{list,execute}` face plus a per-namespace Cordis service key `remote.commands`. `commands/change` is in the explicit forwarded-event allowlist, reachable via `ctx.remote.$on('commands/change', …)`. A sibling first-party package, `@deepseek-ai/dsh-client-ui-commands`, already consumes exactly this path in production (`static inject = ["inputTriggers","sessions","remote","remote.commands"]`), proving ordinary plugin-style client code can reach it.
- **V2 — PASS.** The focused pane's `SessionId` is already resolved by Workbench's own shipped code (`focusedSessionId()` in `shortcuts.tsx`). Turning that id into something `list`/`execute` accept is a fully public, documented path in `@deepseek-ai/dsh-client-runtime`: `ISessions.scope(id): AgentContext`, `.sessionOf(ctx): SessionFace`, `.binding(id): {session: SessionFace}`, and `SessionFace.command(line): Promise<RemoteResult<{matched:boolean}>>` — a purpose-built one-line wrapper around `remote.commands.execute`. This is cleaner than the design doc anticipated. One honest caveat: the `sessions.presentation.*` property Workbench's existing L0 code reads to find "focused" is **not** present anywhere in the published `ISessions` `.d.ts` — it is an untyped, harness-RC-only surface, but that risk is pre-existing (already load-bearing for today's five L0 actions), not something W2 introduces.
- **V3 — PASS (semantics fully confirmed from source).** `CommandRuntime.execute` (`lib/index.js:300-372`) appends `command/run` (including raw argument text, unless the command opts out with `recordInput:false` — a host-only flag never exposed to the client) strictly before invoking the handler, and `command/done` after settlement; a syntax or unknown-name miss returns before any log append (`lib/index.js:301-304`) — literally nothing logged. Recommended UX stance below.

Residual runtime risks are enumerated in the closing section; none block starting W2, but two are worth a cheap live-host smoke test before shipping.

---

## 方法说明

本报告只读地检查了本仓库锁定的 `0.1.1-rc.2` 版本包（`node_modules/.pnpm/@deepseek-ai+dsh-commands@0_...`、`dsh-api-remotes_...`、`dsh-api-gateway_...`、`dsh-typert-protocol_...`、`dsh-client-runtime_...`、`dsh-client-ui-commands_...` 等），交叉比对了它们的 `.d.ts` 声明与已编译的 `.js` 实现（因为很多关键行为——例如"谁真正安装了 `ctx.remote` 服务""`commands/change` 是否真的转发"——只在 `.js` 里可见，`.d.ts` 会隐藏实现细节）。同时用 `plans/260827-shortcuts-open-actions/design.md` §3/§6 的假设做锚点逐条核对。未修改除本报告外的任何文件。

---

## V1 — client 侧能否经公开 API 到达 `commands` 服务

**结论：PASS（可行）。**

### 证据链（file:line）

1. **服务归属声明**：`CommandRuntime` 继承 `TypertRemoteService`，把自己注册为 Cordis 服务 `commands`（host 端）。
   `node_modules/.pnpm/@deepseek-ai+dsh-commands@0_05fb320c97c78e40be77c6f59ade06c2/node_modules/@deepseek-ai/dsh-commands/lib/types/index.d.ts:58-62,75`

2. **client 侧生成的 remote face**：包通过 `./remote` 导出项暴露 `typert.remote-client.js`，声明了两个方法端点和一个"作用域"端点：
   - 直接端点：`commands/list(agentId: SessionId)`、`commands/execute(agentId: SessionId, line, images, signal?)`
   - 作用域端点：`agent:commands/list()`、`agent:commands/execute(line, images, signal?)`（agent 身份从调用方 Context 自动绑定，见 V2）
   `.../dsh-commands/lib/typert.remote-client.d.ts:1-26`
   `.../dsh-commands/lib/typert.remote-client.js:32-117`（`scope: { context: 'agent', wire: 'agentId' }`，`parameters[0].source === 'lookup'`）
   `.../dsh-commands/package.json:37-40`（`"./remote"` export 指向该文件）

3. **谁把这个 face 挂到 client 上**：`@deepseek-ai/dsh-api-gateway` 的 client 半部在 Cordis 根 Context 上安装了一个真正的 `Service`，key 就是 `'remote'`，类型即 `TypertClientRemote`：
   `node_modules/.pnpm/@deepseek-ai+dsh-api-gatewa_589a9bcbaefa93b267d467a3607f6172/node_modules/@deepseek-ai/dsh-api-gateway/lib/types/client/index.d.ts:1-22`
   实现里 `class ClientRemoteService extends Service { constructor(ctx){ super(ctx,'remote') } ... }`，`$mount()` 把一个 contribution 的每个 namespace 挂成独立的 Cordis 子服务 `remote.<namespace>`（例如 `remote.commands`），并把每个方法定义成该子服务上的访问器：
   `.../dsh-api-gateway/lib/types/client/index.js:6-14`（`inject=['typert','connection']`，`super(ctx,'remote')`）
   `.../dsh-api-gateway/lib/types/client/index.js:96-124`（`mountContribution`→`installNamespace`→`remoteServiceKey(name)='remote.'+name`）
   `.../dsh-api-gateway/lib/types/client/index.js:236-251`（`invokeMethod`：优先走 scoped 绑定，否则退回 direct 调用）

4. **谁把 `dsh-commands` 的 contribution 真正挂进去**：`@deepseek-ai/dsh-api-remotes` 的 client 半部 `inject=['remote']`，在 `apply(ctx)` 里对 `commandsRemote`（即 `dsh-commands/remote` 的 `TYPERT_REMOTE`）调用 `await ctx.remote.$mount(commandsRemote)`：
   `node_modules/.pnpm/@deepseek-ai+dsh-api-remote_58a2ebfba08fa3b155d07163932bd997/node_modules/@deepseek-ai/dsh-api-remotes/lib/types/client/index.js:1-37`
   同一文件的 `.d.ts` 还确认了 `Context { remote: TypertClientRemote }` 的模块增强，以及 `export type {} from '@deepseek-ai/dsh-commands/remote'`（把 `commands` namespace 合并进 `TypertRemoteNamespaceMap`）：
   `.../dsh-api-remotes/lib/types/client/index.d.ts:1-36`

5. **注册表变更通知可达**：`commands/change` 在应用级"允许转发的 Host 事件"白名单里，是 `ctx.remote.$on(...)` 的合法 key：
   `.../dsh-api-remotes/lib/types/remote-events.d.ts`（`API_REMOTE_FORWARDED_EVENTS` 数组含 `"commands/change"`）
   host 端触发点：`.../dsh-commands/lib/index.js:404-411`（`notifyChange()` 用 `ctx.events.dispatch('emit', ['commands/change'])`）

6. **已有生产代码走的正是这条路**（不是我推测出来的，是同仓库同版本姊妹包在这么用）：`@deepseek-ai/dsh-client-ui-commands` 的 `CommandUiRuntime`：
   ```
   static inject = ["inputTriggers", "sessions", "remote", "remote.commands"];
   ```
   `node_modules/.pnpm/@deepseek-ai+dsh-client-ui-_fe829a9a9e204125dfcb7f9b1c0235eb/node_modules/@deepseek-ai/dsh-client-ui-commands/lib/client.js:490-542`（含 `ctx.remote.commands.list(sessionId)`、`ctx.remote.$on("commands/change", …)`）
   同文件 `:777-790`（`ctx.remote.commands.execute(session.sessionId, line, images)`）
   这证明"以普通插件方式 `inject`/`ctx.get('remote')`"这条路径不是特权通道,是公开服务键上的普通消费方式。

### 最小 PoC（TypeScript，仅示意，风格照抄 dsh-client-ui-commands 的真实用法）

```ts
// 仅示意：镜像 dsh-client-ui-commands 的 CommandUiRuntime（lib/client.js:490-542, 777-790）
import type { Context } from '@deepseek-ai/cordis'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands/types'

export const inject = ['remote', 'remote.commands']

export function apply(ctx: Context & { remote: TypertClientRemote }) {
  // 注册表变更通知（白名单里的转发事件）
  const offChange = ctx.remote.$on('commands/change', () => {
    // 让快捷键设置页的 host-command 分组失效重拉
  })

  async function listFor(sessionId: SessionId): Promise<readonly CommandDescriptor[]> {
    const r = await ctx.remote.commands.list(sessionId)
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
    return r.value
  }

  return () => { offChange() }
}
```

---

## V2 — client 侧如何拿到 focused pane 对应的 Agent 句柄

**结论：PASS（可行，且比设计稿设想的更干净）。**

### 证据链（file:line）

1. **"谁是 focused pane"这一步，Workbench 自己已经在生产里解决了**（这不是要新建的能力）：
   `packages/dsh-workbench/src/native-ux/client/shortcuts.tsx:41-43`
   ```ts
   function focusedSessionId(services: HarnessServices): string | undefined {
     return services.sessions?.presentation?.state.getSnapshot().focused
   }
   ```
   该函数已被 `stopSession`（:62-67）、`pane.close-focused` 动作（:173-180）、导航器 toggle（:144）等 L0 动作在"按键即发起时刻"直接调用并捕获 session id——design.md §3 提到的"此刻捕获 session id"规则就是照抄这个既有实现,不是新发明。

2. **拿到 focused 的 `SessionId` 之后，如何变成 `list`/`execute` 需要的句柄**——这条路径由 `@deepseek-ai/dsh-client-runtime` 的**公开、有文档**的客户端契约提供,不需要触碰任何私有 store：
   - `ISessions.scope(id: SessionId): AgentContext | undefined` —— 把一个 session id 解析成"携带该 Agent 身份的 Cordis Context"：
     `node_modules/.pnpm/@deepseek-ai+dsh-client-run_43a79ee0d75aadb53bdaf9185de20745/node_modules/@deepseek-ai/dsh-client-runtime/lib/types/client/contract/sessions.d.ts:107`
   - `ISessions.sessionOf(ctx): SessionFace | undefined` 与 `.binding(id): SessionBinding | undefined`（`SessionBinding.session: SessionFace`）：
     同文件 `:120,126`；`SessionBinding` 定义在 `.../lib/types/client/sessions/service.d.ts:109-114`
   - **关键**：`AgentContext` 就是一个普通 `Context`,只是把 `.remote` 收窄成"已绑定 agent 作用域"的版本，此时调用 `list()/execute()` **不需要再显式传 SessionId**（走 V1 中提到的 `agent:commands/execute` 作用域端点，由 client 端的 Context Binder 自动补上身份）：
     `.../lib/types/client/agents/scope.d.ts:5-7`
     ```ts
     export type AgentContext = Omit<Context, 'remote'> & {
       readonly remote: TypertClientRemote & TypertRemoteScopeApi<'agent'>;
     };
     ```
   - **最干净的入口**：`ISession.command(line: string): Promise<RemoteResult<{matched: boolean}>>` —— 明确写在"对外会话面"契约里的一行封装，内部就是 `this.remote.commands.execute(this.sessionId, line, [])`：
     声明：`.../lib/types/client/contract/session.d.ts:81-89`（JSDoc："Execute one slash-command line against this session's agent — pure admission semantics"）
     实现：`.../lib/client.js:7358-7372`

3. **"插入 composer"默认路径同样有公开入口，不必依赖 DOM hack**：`ctx.conversation`（`IConversation`）把 `input: SessionInputResolver` 暴露为"其他插件可达的" 面；`SessionInputResolver.for(actx: ClientContext): SessionInput` 接受的正是上面拿到的 `AgentContext`（它是一个 `Context`），`SessionInput.setDraft(text)` 即可把 `/name ` 写入该会话的 composer 草稿而不触发执行：
   `node_modules/.pnpm/@deepseek-ai+dsh-client-ui-_46dbffc986e4f0288f91ef6dd4443da5/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/types/client/service.d.ts:20-32`
   `.../lib/types/client/input/contract.d.ts:26-57`

### 一处诚实的缺口（不阻塞开工，但要记下来）

`shortcuts.tsx` 读取的 `services.sessions?.presentation?.state.getSnapshot().focused` 这个 `presentation` 属性，**在 `dsh-client-runtime@0.1.1-rc.2` 已发布的 `ISessions` `.d.ts` 契约里完全不存在**——我对本仓库解析出的两份 `dsh-client-runtime` 副本（`...run_43a79ee0.../lib/types/client/contract/sessions.d.ts` 与 `...run_ca14d682.../` 同名文件）都做了逐行核对，`presentation` 一词只出现在无关的 prose 注释里,从未作为字段声明出现。`harness-adapter.ts:25-29` 也把它标成可选（`presentation?:`）并在文件头注释里承认"harness 在 RC 阶段、API 会漂移……本插件刻意不复刻完整 SDK 类型树"。也就是说：**焦点面板识别本身依赖一个未公开、无类型契约背书的运行时属性**——但这是 L0 现状就有的风险（5 个既有动作都靠它），W2 只是复用同一条路径,不新增暴露面。

### 最小 PoC（TypeScript，仅示意）

```ts
// 仅示意：把既有 focusedSessionId()（shortcuts.tsx:41-43）接到 dsh-client-runtime 的公开会话面
async function runHostCommandOnFocusedPane(
  services: HarnessServices,
  name: string,
): Promise<void> {
  const sessionId = focusedSessionId(services) // 既有 L0 helper，按键此刻捕获
  if (sessionId === undefined) return // fail-closed：无焦点面板

  // ISessions.binding(id): SessionBinding | undefined — dsh-client-runtime
  // contract/sessions.d.ts:126，SessionBinding.session: SessionFace（service.d.ts:109-114）
  const binding = services.sessions?.binding?.(sessionId)
  if (binding === undefined) return // provider 缺席：原则三，灰显 + 跳过

  // ISession.command(line) — contract/session.d.ts:81-89，等价于composer里手敲后回车
  const outcome = await binding.session.command(`/${name}`)
  if (!outcome.ok) {
    // 展示为一次性 composer 提示；对应 dsh-client-ui-commands 的"transport/admission
    // 失败才走提示，正常路径由持久化日志承担反馈"的既有约定
  }
}
```

---

## V3 — 会话日志语义 + "直接执行"文案建议

**结论：PASS（语义已从源码完全确认）。**

### 证据链（file:line）

`CommandRuntime.execute` 的完整控制流：`node_modules/.pnpm/@deepseek-ai+dsh-commands@0_05fb320c97c78e40be77c6f59ade06c2/node_modules/@deepseek-ai/dsh-commands/lib/index.js:300-372`

- **:301-304** — `parseCommand` 失败或 `name` 未解析到已注册命令时，直接 `return void 0`，此时**还没有调用 `mintCommandId()`/`appendLifecycle()`**——语法错误或未知命令名**完全不落日志**（design.md §3 的"admission misses log nothing"在这里逐字对应）。
- **:306-312** — 只要通过了名字解析，`command/run` 就在调用 handler **之前**追加，字段包含 `commandId`、`name`、`source:{kind:'user'}`，以及 `args: parsed.rawInput`——除非该命令定义显式声明 `recordInput === false`。
- **:313-324**（`settle`）— handler 结算后追加 `command/done`，带 `kind`/`text`/`sourceEventSeq`。
- **:326-355** — 图片校验失败（未声明 `input.images`、无附件 store、超限）在进入 handler **之前**就 `settle({kind:'error',...})`——这些失败**照样会记进 `command/done`**（因为已经过了 `command/run` 那一步），与"admission miss 不落日志"是两个不同阶段：语法/未知名字→不落日志；已解析但业务校验失败→落日志。
- **:347,352,368**（`settleThrown`，定义于 `:374-384`）— handler 抛出或取消，`command/done` 的追加失败被吞掉（只记 warn log），确保 handler 自身的错误才是最终报出的失败——但这层"contained"只保护 append 失败本身，不改变"这次执行已经落了 `command/run`"的既成事实。

### 对快捷键场景的具体含义

1. **"直接执行"选项在设计里只对未声明 `input` 的命令开放**（design.md §3 规则 1）。这类命令由快捷键触发时，`line` 恒为 `/${name}`（无用户自由文本），所以 `command/run.args` 字段要么是空字符串、要么该命令本身就 `recordInput:false`——**不存在"快捷键悄悄把不该记的文字记进日志"的风险**，风险只是"记录了一次命令名 + 时间戳"。
2. **client 端拿不到 `recordInput` 这个字段**——`commands/list` 的 wire schema（`typert.remote-client.js:23-30`）里 `CommandDescriptor` 只有 `name`/`description`/`input?`，`recordInput` 是 host-only 的实现细节，从不透出。所以设置页/文案不能承诺"这条命令不会记参数"，只能笼统承诺"命令名会记，参数字段可能记也可能不记，取决于命令自身"。
3. **日志里这条记录和用户手敲 `/name` 回车产生的记录逐字节相同**（`source:{kind:'user'}` 是写死的，没有"来自快捷键"的溯源标记）——其他协作者事后看会话记录时**分辨不出**这是快捷键触发的还是手敲的。这既是"不吓人"（长得和正常操作一模一样）也是"要说清楚"（用户自己也要知道：按这个键 == 在输入框打字回车,不是什么静默的后台动作）的双刃点。

### UX 文案建议

- **默认值维持 design.md 既定方案**：v1 里所有 host 命令默认映射为"插入 composer"（`SessionInput.setDraft('/name ')`，不触发 `execute`，因此不产生任何 `command/run`）；"直接执行"是每个动作可单独打开的选项，且仅对无 `input` 的命令提供该选项。
- **"直接执行"开关的说明文案**（放在该选项旁的次要文字/tooltip，中英双语）：
  - 中文：「开启后，按下快捷键会立即执行该命令，并像手动输入后回车一样记入当前会话的记录（其他协作者可见）。」
  - English: "When enabled, pressing this shortcut runs the command immediately and adds it to the current session's history — visible to collaborators, exactly as if you had typed it and pressed Enter."
- **不要**承诺"不会留痕"或"静默执行"——源码证实每一次成功解析的调用都至少落一条 `command/run` + 一条 `command/done`；文案应该反过来把"和手敲等价"当作卖点（消除"这是不是后台偷偷干的"疑虑），而不是掩盖它。
- 由于 client 端看不到 `recordInput`，**不要在文案里区分"这条命令记参数/那条不记"**——统一按"命令名必记，参数不确定"处理；反正 direct-execute 只开放给无 `input` 命令，参数字段本来就是空的，这条差异对用户几乎不可见，不必展开解释以免文案变复杂。

---

## 综合结论：W2 是否可以开工

**可以开工。** V1、V2 的可达性和 V3 的日志语义都已经从本地 `0.1.1-rc.2` 源码里拿到了确凿、可复核的证据，且关键路径（`ctx.remote.commands.*`、`ISessions.scope/sessionOf/binding`、`ISession.command`）不是靠零散拼凑，而是同一版本、同一仓库里已经有生产代码（`dsh-client-ui-commands`、`dsh-client-runtime` 自身的 `Session.command`）在完全相同地使用——这比"类型声明存在"要强得多的证据等级。

### 剩余运行时风险（开工前建议做的轻量验证，不构成阻塞）

1. **`ctx.get('remote')` / `ctx.get('remote.commands')` 在 Workbench 自己的插件 fiber 里确实解析成功**——静态证据只能证明"这是同一棵 Cordis 树上的公开服务键"，无法证明 Workbench 挂载点与 `dsh-api-gateway`/`dsh-api-remotes` 挂载点之间没有作用域隔离。建议：在真实 Harness 里跑一次 `ctx.get('remote')` 断言非 `undefined`。
2. **`sessions.presentation.state.getSnapshot().focused` 的稳定性**——如 V2 所述，这个字段不在已发布 `.d.ts` 里，只能靠运行时观察。建议：W2 落地时给它包一层跟 `harness-adapter.ts` 现有其它字段一致的"缺席即 fail-closed"防御（其实现状代码已经是这么写的，W2 只需继续沿用,不需要新写）。
3. **`commands/change` 事件在真实多插件环境下的抖动频率**——静态代码只能确认"事件会被转发",无法确认它在插件频繁装卸时是否会高频触发,建议设置页对该事件做防抖后再重拉目录（`dsh-client-ui-commands` 自己也是直接 `invalidateAll()`，可以照抄同样的节流策略）。
4. **`CommandDescriptor.description` 的本地化/长度**——未在本次范围内检查，纯 UI 细节，留给 W1 的分组/搜索 UI 实现阶段处理即可。

以上四条都是"建议在真机上花几分钟确认"级别的风险，没有一条动摇 V1/V2/V3 的静态结论。
