# B2 — Fork Async Identity Capture Audit / fork 异步身份捕获审计

## English summary

We audited the `codex/presentation-v2` fork (commit `53015a6f39710dac52ed08f05aca0c6bad7444ac`) against denial123789's requirement: async interactions must capture the target pane's session id **at initiation**, not resolve a global "current session" **after an await**. All six audited paths — send, paste, upload (drag-and-drop), model selection, question, approval — are **SAFE**: every one binds its session identity into a stable, session-scoped closure or an immutable server-pushed carrier at creation time, before any async gap, and never re-reads a mutable "current" pointer on settlement. However, one concrete **UNSAFE** finding stands: `ComposerAttachments` (`packages/client/ui-attachment/src/client/ComposerAttachments.tsx`) attaches its drag-and-drop listeners to `document`, not to its own pane's DOM subtree. In split view this component mounts once per pane, so a single file drop anywhere on the page fires every mounted pane's handler and adds the same image to **every open pane's composer at once** — a pre-existing single-session-era convenience ("drop anywhere") that the multi-pane patch never reconciled. This is exactly the class of defect the commitment asked us to surface, found by inspecting the interaction path the diff did not touch rather than the diff itself.

## 审计范围与 fork commit

- **来源**：`https://github.com/wanyexin1998/deepseek-harness.git`，分支 `codex/presentation-v2`
- **本地浅克隆位置**：`<SCRATCHPAD>\harness-fork`（脚手架目录内，非本仓库文件，未修改 dsh-workbench 仓库任何文件）
- **HEAD commit**：`53015a6f39710dac52ed08f05aca0c6bad7444ac`（`test(web): snapshot multi-session presentation`，2026-08-26T03:50:16+08:00）——与 `task_plan.md` §3.5 记录的参考实现 commit 一致
- **审计对象**：
  1. 协议 2 补丁触及的客户端包：`packages/client/runtime`、`packages/client/ui-layout`、`packages/client/ui-renderer`、`packages/client/ui-slots`
  2. 五条交互路径的异步身份解析：send、paste、upload（附件上传）、model-selection、question、approval
  3. 特别检查：per-pane `SessionProvider` 是否真的把这些路径纳管，还是有路径绕过它走了补丁未触及的全局 store
- **方法**：静态代码追踪（未运行测试/构建），沿每条交互路径从 UI 触发点一路跟到 RPC 调用点，确认"会话身份"这个值是在哪一行、哪个时刻被固定下来的。以下每条分类都给出可复核的 file:line 证据。

以下路径均以文件路径 + 行号引用，均相对于上述 fork 克隆根目录。

## 架构基线：SessionProvider 的两种绑定模式

`packages/client/ui-renderer/src/client/session-provider.tsx:152-156`：

```ts
export function SessionProvider({ empty, children, sessionId }: SessionProviderProps) {
  const host = useHost()
  const source = sessionId === undefined
    ? host.sessions.provideInfo          // 全局"当前会话" observable
    : host.sessions.provideInfoOf(sessionId)  // 显式按 id 寻址的 observable
  ...
```

`SessionProvider` 本身有两种模式:不传 `sessionId` 时退化为全局 "current" 源;显式传入 `sessionId` 时通过 `host.sessions.provideInfoOf(id)`(`packages/client/runtime/src/client/sessions/service.ts:641-649`,按 id 建立/复用独立的 `perIdProvideCells` 条目,与 "current" 完全解耦)寻址。

`packages/client/ui-layout/src/client/AppFrame.tsx:264,278` 在分屏(`presentation.visible.length > 1`)时,对每个 pane 显式传入 `sessionId`:

```tsx
<SessionProvider sessionId={sessionId}>
  {() => ( ... renderSlot('conversation', {}) ... )}
</SessionProvider>
```

单 pane(`visible.length <= 1`)时则直接 `renderSlot('conversation', {})`,不包一层显式 `SessionProvider`,落到根部 `SessionMaybeProvider`(`session-provider.tsx:125-133`)代理的全局 "current" 源——这在单 pane 下是安全的,因为此时"当前会话"在定义上就是唯一可见会话,不存在身份歧义(分类为 N/A 场景,详见下表)。

**关键的架构事实**(对分类结论至关重要):无论会话 id 的值来自哪个 observable(全局 "current" 还是显式按 id 寻址),这个值都会在 `ui-renderer/src/client/scoped-slots.tsx` 的 `runInject()`(第 102-111 行)里作为**位置参数**一次性传给每个 slot 的 `inject(sessionId)` 工厂函数,其返回结果按 `(entry, info)` 身份缓存(`cachedSessionInject`/`cachedSessionMaybeInject`,第 185-215 行)。也就是说,composer、model-select 等组件拿到的 `send`/`select`/`addImages` 等回调,都是**在渲染时就已经把 sessionId 值烘焙进闭包**的稳定函数——不是"每次调用时查一下当前是谁"的动态查询。这正是 denial123789 要求的"在发起时捕获"模式,和 SessionProvider 走哪条 observable 无关。

## 每路径分类表

| 交互路径 | 分类 | 证据 file:line | 说明 |
| --- | --- | --- | --- |
| **send**(文本发送,含图文混合) | **SAFE** | `packages/client/ui-conversation/src/client/input/hub.ts:71-121`(`shellFor` 按 `binding.sessionId` 创建并缓存 `SessionInputShell`,`defaultSink` 闭包捕获具体 `session: SessionFace`);`packages/client/ui-conversation/src/client/input/hub.ts:165-174`(`sink()` 调用 `this.conversation().sendSession(session, ...)`,`session` 为闭包捕获对象,非查询);`packages/client/ui-conversation/src/client/service.ts:145-162`(`sendSession(session: SessionFace, ...)` 直接对传入的 session 对象调用 `session.prompt(...)`) | 每个 session 一个 `SessionInputShell` 实例(Map 缓存于 `InputHub.shells`),创建时即绑定该 session 的 `SessionFace` 对象;`await session.prompt(...)` 结算后不重新解析任何 "current" 指针。 |
| **paste**(剪贴板文本 / 图片) | **SAFE** | `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:479-503`(`onPaste` 绑定在具体 `<textarea>` DOM 元素的 React 事件上,`keyboard.pasteBegin(...)` 走同一个 session-bound `shell`);`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:482-486`(粘贴的文件走 `intakeImages` → `addImages`,与上传路径同源) | 纯文本粘贴由 DOM 元素级 React 事件处理,天然按 pane 隔离(每个 pane 是独立 React 组件实例,`onPaste` 闭包各自持有各自 pane 的 `keyboard`/`addImages`)。剪贴板中的图片文件复用下方"upload"路径。 |
| **upload — 剪贴板/拖拽图片写入草稿** | **SAFE**(附件绑定本身) | `packages/client/ui-conversation/src/client/apply.ts:307-316`(`const shell = inputHub.shell(sessionId)`;`addImages` 闭包对该 `shell` 调用 `shell.addImages(...)`);`packages/client/ui-model-selection` 之外——见下方 UNSAFE 行 | `addImages`/`removeImage` 回调本身在 `conversation.composer.bar` 的 `inject(sessionId)` 里按 sessionId 绑定(`session-maybe` scope,第 291-330 行),值正确。但触发这些回调的**拖放事件源**不安全,见下方 UNSAFE 单独列出。 |
| **upload — 拖放(drag-and-drop)事件源** | **UNSAFE** | `packages/client/ui-attachment/src/client/ComposerAttachments.tsx:67-70`(`document.addEventListener('dragenter'/'dragover'/'dragleave'/'drop', ...)`);同文件 `:60-66`(`onDrop` 未做任何 DOM 边界/目标校验,只要 `canAcceptDrop` 为真就调用 `onAddImages`);测试文件显式承认此设计:`packages/client/ui-attachment/tests/composer-attachments.client.spec.tsx:68`(`it('accepts file drops anywhere on the document and keeps non-file drags native', ...)`) | 见下方专门小节,这是本次审计发现的唯一具体缺口。 |
| **model-selection** | **SAFE** | `packages/client/ui-model-selection/src/client/index.ts:157-174`(`inject: (sessionId) => { const directory = models.directoryFor(sessionId); ...; select: (selection) => directory.select(selection)... }`);`packages/client/ui-model-selection/src/client/service.ts:69-108`(`directoryFor(sessionId)` 按 sessionId 缓存 `ModelDirectory` 实例);`packages/client/ui-model-selection/src/client/directory.ts:52-99`(`ModelDirectory` 构造时把 `sessionId` 存为私有字段,`select()` 内部 `await this.sessions.models({ sessionId: this.sessionId, ... })` 用的是构造时绑定的字段,不是运行时查询) | 每 session 一个 `ModelDirectory` 单例,`sessionId` 在构造函数里就是 `private readonly` 字段;`select()` 内部的 RPC 调用永远打向构造时绑定的那个 session。 |
| **question**(用户问答 / plan review) | **SAFE** | `packages/client/runtime/src/client/sessions/pending.ts:34-65`(`PendingWait` 构造函数注释:"Minted by Session **on a requested frame**"——服务端推送 `question/requested` 帧时,由 Session 立即铸造这个不可变对象,`sessionId` 作为 `readonly` 字段永久绑定);`packages/client/ui-user-questions/src/client/contract/slots.ts:94-125`(`PendingQuestion.answer()` 调用 `this.wait.respond({..., value: { sessionId: this.wait.sessionId, answer }})`);`packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx:21`(`const pending = useSession(s => s.pending) ?? []`,来自该 pane 自己 SessionProvider 绑定的会话快照) | 身份捕获点甚至早于"用户点击回答"——在服务端推送交互请求、runtime 铸造 `PendingWait` 的那一刻就已经把 `sessionId` 冻结为不可变字段;UI 层再迟钝也不可能污染它。且每个 pane 的 `pending` 列表本就只来自该 pane 自己会话的快照,不会看到别的 pane 的问题。 |
| **approval**(审批 / 工具调用放行) | **SAFE** | 同上 `pending.ts:34-65`(approval 与 question 共享同一个 `PendingWait` 机制,`kind: 'approval'`);`packages/client/ui-conversation/src/client/contract/slots.ts:682-723`(`PendingApproval.answer()` → `this.wait.respond({..., value: { sessionId: this.wait.sessionId, ... } })`);`packages/client/ui-conversation/src/client/skeleton/ApprovalPanel.tsx:41-64`(`useMemo(() => new PendingApproval(props.matched), [props.matched])`,`props.matched` 来自该 pane 的 composer chain 选择器,选择器本身在 session-scope 内运行) | 与 question 完全同构,同一套不可变 carrier 机制,身份捕获点在服务端事件到达时,而非 UI 交互时。 |

**分类计数**:SAFE 6 项(send / paste / upload-绑定本身 / model-selection / question / approval)、UNSAFE 1 项(upload 的拖放事件源)、N/A 1 项(单 pane 场景下 `renderSlot('conversation', {})` 退化到全局 `provideInfo`,定义上无歧义)、UNKNOWN 0 项。

## UNSAFE 发现详解:拖放上传绕过了 per-pane 边界

**现象**:`ComposerAttachments`(挂载于 `conversation.input.attachments` 插槽,`scope: 'session-maybe'`,由每个 pane 各自的 `conversation.composer.bar` 渲染一份)在 `useEffect` 里把 `dragenter`/`dragover`/`dragleave`/`drop` 监听器挂在 `document` 上(`ComposerAttachments.tsx:67-70`),而不是挂在自己这个 pane 的 DOM 子树上。分屏时两个 pane 各自独立挂载一份 `ComposerAttachments`,于是 `document` 上同时存在两组监听器,每组各自闭包捕获了**正确的、各自 pane 的** `onAddImages`(这一步本身没问题,见上表)。

但 `onDrop` 处理函数(`:60-66`)对触发它的这次 drop 事件**不做任何目标 / 坐标校验**——只要 `dataTransfer.types` 里有 `'Files'` 且 `canAcceptDrop` 为真,就无条件调用 `onAddImages(...)`。因为监听器挂在 `document` 而非各 pane 自己的 DOM 节点,一次 drop 事件会**同时触发两个 pane 的监听器**,导致同一个被拖拽的文件被**同时添加进两个 pane 各自的草稿附件列表**——不是"落到了错误的 pane",而是"同时落到了所有 pane"。

这不是"await 后重新解析全局 current" 这种最典型形态的身份错位(这里 sessionId 值本身从未被污染,两个闭包各自的 sessionId 都是对的);它属于同一类根因的另一种呈现——**触发信号的作用域(document 全局)与状态目标的作用域(单个 pane)不匹配**,后果同样是"一次用户操作产生了跨 pane 的意外副作用"。测试文件 `composer-attachments.client.spec.tsx:68` 的用例名(`'accepts file drops anywhere on the document'`)证明这是单会话时代刻意设计的"整页可拖放"便利特性,补丁引入多 pane 展示时未回头核对这个假设——这正是任务要求特别注意的"补丁未触及的路径是否仍然安全"的典型例子:`ui-attachment` 包本身并不在协议 2 补丁触及的四个包(`runtime`/`ui-layout`/`ui-renderer`/`ui-slots`)清单里,但它是审计范围内明确要求覆盖的交互路径(upload),而且行为随分屏而质变。

需要说明的是,这是一个**真实但影响面较小**的缺陷:被"污染"的是错误 pane 的**草稿态**(用户发送前可撤回),不是已发送的消息内容或审批/问答决策(那三类走的是完全独立、经过硬化的 `PendingWait` 机制,不受影响)。

## UNKNOWN 项

无。六条路径的关键调用链均可静态追踪到底(从 UI 事件处理函数到最终 RPC 调用),没有出现因动态 `ctx.get`、反射调用等原因无法确定绑定来源的情况。

## 修复建议(UNSAFE 项)

1. **最小修复**:把 `ComposerAttachments.tsx` 的拖拽监听器改为挂在组件自身渲染的容器 DOM 节点(通过 `ref`),而不是 `document`。分屏时每个 pane 只响应发生在自己视觉区域内的拖放,天然消除跨 pane 污染。这也是更符合直觉的 UX——把文件拖到 pane B 上不应该同时喂给 pane A。
2. **若要保留"整页可拖放"的原有便利性**(单 pane 场景下这确实是好体验):在 `onDrop`/`onDragEnter` 里增加一次 `document.querySelectorAll('[data-session-pane]').length <= 1` 式的短路判断——分屏(`length > 1`)时退化为要求文件必须落在触发这次事件的 pane 容器内(用 `event.target.closest('[data-session-pane]')` 校验),单 pane 时保留"整页接收"。这样两种模式的行为都不回退。
3. **测试**:在 `composer-attachments.client.spec.tsx` 里补一个"两个实例同时挂载,drop 事件只应触发目标实例的 `onAddImages`"的用例,防止回归。当前测试套件里没有任何用例模拟多实例并发挂载,这也是这个缺口长期未被发现的直接原因。

## 给提案契约条款的措辞建议

denial123789 的原始要求是"异步交互必须在发起时捕获 pane 的 session id,而不是在 await 之后解析全局焦点"。这次审计证实协议 2 补丁在**回调绑定**层面(send/paste/upload-绑定/model-selection/question/approval 六条路径的 sessionId 闭包捕获)完全符合这条要求,建议提案正文补一句更精确的表述,把审查范围从"回调闭包如何捕获 id"扩展到"触发信号本身的作用域是否与目标状态的作用域匹配",覆盖本次发现的这类缺口:

> 建议追加条款(中文,供正文条文化时选用或改写):
> "多 pane 展示下,任何绑定到会话状态的交互不仅其**回调闭包**必须在发起时捕获目标 session id(不得在 await 结算后重新解析一个可变的'当前会话'指针),其**触发该回调的事件源自身的作用域**也必须与目标 pane 一致——挂在 `document`/`window` 等全局对象上的事件监听器,如果其处理函数会修改某个 pane 的会话态,必须显式校验事件目标落在该 pane 的 DOM 子树内,否则视为违反本条款。"
>
> Suggested addition (EN, for the proposal body): "Under multi-pane presentation, a session-bound interaction must not only capture its target session id in the callback closure at initiation (never re-resolving a mutable 'current session' pointer after an await); the **scope of the event source that triggers the callback** must also match the target pane. A listener attached to a global object (`document`/`window`) whose handler mutates one pane's session state MUST verify the event's target lies within that pane's own DOM subtree, or it violates this clause."

这条补充能直接把本次发现的 `ComposerAttachments` 缺口纳入契约的可验收范围,避免同类"全局事件源 + 每 pane 独立挂载监听器"模式在后续迭代里重演。

## 附注:一处未接入 UI 的次要 API

`packages/client/ui-conversation/src/client/service.ts:130-134` 的 `ConversationController.send(text)`(单参数版本,依赖 `this.ctx` 走 cordis 的 caller-scope 追踪解析 session)在全仓库 `packages/client` 范围内未发现任何调用方(通过 InputHub 的实际发送路径走的是 `sendSession(session, ...)` 的显式对象版本,见上表)。这个方法目前是死代码/纯 API 表面,不影响本次六条路径的分类结论,故未单独列入分类表;如果未来有插件通过 `ctx.sessions.scope(id).conversation.send(text)` 显式按 id 调用它,其身份解析依赖 cordis 的 caller-context 追踪机制,建议后续若真正启用该调用方式时单独复核一次。
