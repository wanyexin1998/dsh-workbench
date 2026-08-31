# Codex 式划词动作与 Workbench 侧聊功能调研

> - 调研日期：2026-08-28
> - 状态：方案调研，尚未授权实施
> - 目标功能：`添加到对话`、`更多详情`、`在侧边聊天中提问`
> - 推荐落点：DSH Workbench 的 Pane-scoped 选区动作与第二个原生 Session Pane

## 1. 结论摘要

1. **截图中的 Codex Desktop 划词菜单没有开源 UI 源码。** OpenAI 维护者已明确说明 Codex Desktop 不是开源组件；Desktop 与 IDE Extension 建立在公开的 Codex App Server API 之上。当前 `openai/codex` 仓库可以核查 CLI、TUI、App Server、SDK 与协议，但不能从中还原 Desktop 的 Selection/Range、浮动菜单、annotation composer 或选区侧聊 UI。
2. **可借鉴的官方开源基础是 TUI `/side`。** 它把侧聊实现为父 Thread 的 ephemeral fork，继承模型配置，在 fork 后注入一条 reference-only boundary，再提交侧聊问题；主 Thread 不被 steer 或 interrupt。
3. **DeepSeek Harness 已具备大部分底层能力。** `sessions.fork()` 能从已完成 Turn 的事件前缀创建 child Session；Conversation 的 scoped input 与 InputTrigger reference 可以实现“添加到对话”；Presentation protocol 2 可以把 child 作为第二个稳定 Pane，以原生 `SessionProvider(sessionId)` 复用完整 Conversation。
4. **GitHub 上已有一份很接近的 DSH 实现。** `AHGGG/dsh-side-chat@0.7.2` 已实现三项动作、选区校验、结构化 composer reference 与 Session fork，可作为实现参考；但它使用全局 current Session、全局第一个 `[data-chat-flow]`，并自建 Conversation renderer，不能原样用于双 Pane Workbench。
5. **推荐 v1 只改 Workbench。** 划词工具条注册到 `shell.overlay`；所有动作在捕获时固定 `parentSessionId`；“更多详情”和“在侧边聊天中提问”通过 `sessions.fork()` 创建 child，并使用 Workbench 的第二个原生 Pane。无需修改 Agent loop、ACP、底层 JSON-RPC 或 SDK。

## 2. 调研范围与证据分级

### 2.1 调研基线

| 对象 | 固定基线 | 用途 |
|---|---|---|
| OpenAI Codex | [`ec9620c231396895194329c410f3ec360b4cadef`](https://github.com/openai/codex/commit/ec9620c231396895194329c410f3ec360b4cadef) | 开源边界、TUI `/side`、App Server 调用链 |
| DeepSeek Harness stock | [`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e) | Session fork、Conversation、InputTrigger 公开面 |
| Presentation protocol 2 | [`53015a6f39710dac52ed08f05aca0c6bad7444ac`](https://github.com/wanyexin1998/deepseek-harness/commit/53015a6f39710dac52ed08f05aca0c6bad7444ac) | `visible + focused`、第二 Pane、显式 SessionProvider |
| DSH Workbench | [`95a08cc15ec2b893f4d85917ddad425aa7de63dd`](https://github.com/wanyexin1998/dsh-workbench/commit/95a08cc15ec2b893f4d85917ddad425aa7de63dd) | 当前插件扩展点与 Pane-scoped 约束 |
| DSH Side Chat 参考实现 | [`e7cd447d97825a944b3d83e2a34488485dc1f088`](https://github.com/AHGGG/dsh-side-chat/tree/e7cd447d97825a944b3d83e2a34488485dc1f088) | 三项动作的既有实现与兼容性问题 |

### 2.2 证据等级

- **A — 官方明确事实：** OpenAI 官方文档、OpenAI 维护者答复、固定 SHA 的官方源码。
- **B — 第一方仓库产品行为记录：** `openai/codex` Issue 中的可复现行为；可说明产品现象，但不等于源码证明。
- **C — 外部安装包观察：** Issue 作者对生产包的检查或逆向观察；只作为实现线索，不能表述为 OpenAI 已公开的内部实现。
- **D — 当前本地/固定 fork 源码：** DeepSeek Harness、Workbench 与第三方 DSH 插件的可执行代码事实。

## 3. Codex 上游调研

### 3.1 Desktop UI 的开源边界

OpenAI 维护者 `etraut-openai` 在 accepted answer 中明确写道：

> “The Codex desktop app is not open source.”

维护者同时说明，可以基于 Codex CLI 提供的 App Server API 自行实现客户端，Codex Desktop 与 IDE Extension 也构建在该接口上。来源：[Discussion #16538 accepted answer](https://github.com/openai/codex/discussions/16538#discussioncomment-16424745)。

OpenAI 的[开放组件清单](https://learn.chatgpt.com/docs/open-source#open-source-components)列出了 Codex CLI、SDK、App Server、Skills、Plugins 等公开组件；[App Server 文档](https://learn.chatgpt.com/docs/app-server)将 Thread、Turn、Item、`thread/fork`、`turn/start` 等定义为构建 rich client 的公开协议。

在固定 SHA `ec9620c` 上精确搜索以下文案或符号，没有发现 Desktop 菜单实现：

- `Add to chat`
- `Ask in side chat`
- `添加到对话`
- `更多详情`
- `在侧边聊天中提问`
- `selectedTextOverlay`
- `responseAnnotationTargetId`

因此，本报告不会把 Issue 中出现的客户端符号写成开源源码事实。

### 3.2 三项动作可确认的产品语义

#### 添加到对话

根据 [Issue #37560](https://github.com/openai/codex/issues/37560#L176-L219)：

- 选区被作为结构化 annotation 加入当前未发送的 composer 草稿；
- 用户可以连续收集多个选区并补充普通文本；
- 选择动作本身不自动发送；
- 用户最终只发送一次组合消息；
- 主 Turn 仍在运行时，该组合消息进入正常队列，不应中断当前 Turn。

Issue 中的 `responseAnnotationTargetId`、`item.completed` guard 和 DOM attributes，是作者检查生产安装包后的观察，属于 C 级证据，不是 OpenAI 发布的源码。

#### 更多详情

产品行为是：选中内容后打开解释型 Quick/Side Chat，并立即提交解释请求。[Issue #36114](https://github.com/openai/codex/issues/36114#L173-L181)记录了该用户流程。

另一个 Windows 生产包检查指出，该入口会立即提交 “Tell me more about this”，并在当时版本中走 ChatGPT consumer Quick Chat，而不是 Codex Thread；该结论来自安装包观察，应视为版本相关线索，而不是公开源码事实。[Issue #34164](https://github.com/openai/codex/issues/34164#L164-L213)

#### 在侧边聊天中提问

该动作允许用户围绕选区自由补充问题，并让结果留在侧聊上下文中，避免打断或污染主对话。[Issue #37520](https://github.com/openai/codex/issues/37520#L164-L173)

### 3.3 可借鉴的官方开源实现：TUI `/side`

Desktop 菜单本身闭源，但 Codex TUI 已公开一套可靠的侧聊引擎实现：

```text
/side 或 /btw
  → AppEvent::StartSide
  → App::handle_start_side
  → 复制 parent 模型、reasoning effort、service tier
  → 设置 ephemeral
  → AppServerSession::fork_side_thread
  → JSON-RPC thread/fork
  → thread/inject_items 注入 reference-only boundary
  → 切换 child 后提交用户问题
```

关键事实：

- [`side.rs`](https://github.com/openai/codex/blob/ec9620c231396895194329c410f3ec360b4cadef/codex-rs/tui/src/app/side.rs#L1-L40)把 side conversation 定义为保持主 Thread 聚焦的 ephemeral fork，并明确继承历史只作为参考材料。
- [`side.rs`](https://github.com/openai/codex/blob/ec9620c231396895194329c410f3ec360b4cadef/codex-rs/tui/src/app/side.rs#L595-L607)继承模型、reasoning effort 和 service tier，并设置 `ephemeral = true`。
- [`side.rs`](https://github.com/openai/codex/blob/ec9620c231396895194329c410f3ec360b4cadef/codex-rs/tui/src/app/side.rs#L703-L727)先 fork child，再通过 `thread/inject_items` 写入边界项。
- [`app_server_session.rs`](https://github.com/openai/codex/blob/ec9620c231396895194329c410f3ec360b4cadef/codex-rs/tui/src/app_server_session.rs#L817-L870)负责组装 `thread/fork` 请求。

对 Workbench 最重要的设计启示是：

1. side child 继承 parent 历史，但继承历史不是当前指令；
2. child 的问题必须位于明确的 side boundary 之后；
3. 主 Session 不应被 steer、interrupt 或切换任务所有权；
4. 是否持久化 child，与工具副作用是否发生，是两个不同问题。

## 4. DeepSeek Harness 与 Workbench 现状

### 4.1 当前没有任意文本 Range 的动作扩展点

Harness 的 Assistant 文本由 `MarkdownText` 正常渲染；Chat Node 外层暴露 `data-chat-anchor-key`、`data-chat-flow-key` 和 `data-chat-flow-kind`，但当前没有 selection callback、源文本 offset 或浮动动作 owner。[ChatNodeSeat.tsx](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx#L43-L60)

现有 `conversation.chat.assistant-actions` 只针对已经完成的整条 Assistant message，owner 只有稳定 `messageId`，适合整条消息按钮，不足以表达任意文字 Range。[slots.ts](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-conversation/src/client/contract/slots.ts#L142-L152)

Workbench 当前没有 `window.getSelection()`、`selectionchange` 或这三项动作。现有 `shell.overlay` 已用于兼容失败与同 Workspace 警告，因此它是划词工具条最自然的现有挂载点。[Workbench client/index.tsx](https://github.com/wanyexin1998/dsh-workbench/blob/95a08cc15ec2b893f4d85917ddad425aa7de63dd/packages/dsh-workbench/src/client/index.tsx#L138-L167)

### 4.2 “添加到对话”的底层机制已经存在

Harness 已提供 scoped composer 与结构化 reference 管线：

- `IConversation` 暴露 Session-scoped input 与 `send()`。[service.ts](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-conversation/src/client/service.ts#L24-L43)
- `SessionInputResolver.for(scope)` 按 Agent/Session scope 解析输入实例；`SessionInput` 提供 `insertReference()`、`setDraft()`、`submit()` 与 observable state。[input/contract.ts](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-conversation/src/client/input/contract.ts#L25-L65)
- `ReferenceInsert` 保存 source、opaque ref、label 与 clipboardText；`ReferenceCodec.serialize()` 在提交时生成模型可见表示。[ui-input-trigger/types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-input-trigger/src/types.ts#L84-L98)
- Agent loop 最终把被接受的用户输入写入 durable `user/message`；因此 selection reference 在发送时通过正常输入路径进入日志，不需要修改 agent-loop。[agent.ts](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/agent.ts#L279-L284)

该机制符合 `model-visible ⟺ logged`：草稿阶段不启动模型 Turn；用户发送后，序列化的选区上下文与普通用户文本一起成为可重放的会话事实。

### 4.3 Session fork 与第二 Pane 已经存在

Stock Harness 的 `ISessions.fork()` 可以从已完成 Turn 的事件前缀创建 child Session，`atSeq` 会定位到包含该事件的第一个 `turn/end`；child 继承 cwd、model target 与 parent lineage。[ISessions.fork](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/runtime/src/client/contract/sessions.ts#L88-L104)、[Host fork](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/host/apiproxy/src/api-proxy.ts#L2263-L2358)

Workbench Edition 使用 Presentation protocol 2：

- `visible` 是稳定的空间成员列表；
- `focused` 只管理交互所有权，不重排或重挂载 Pane；
- 每个可见 Pane 都以稳定 `key=sessionId`、显式 `SessionProvider(sessionId)` 渲染同一个 stock Conversation。

来源：[presentation.ts](https://github.com/wanyexin1998/deepseek-harness/blob/53015a6f39710dac52ed08f05aca0c6bad7444ac/packages/client/runtime/src/client/sessions/presentation.ts#L10-L24)、[AppFrame.tsx](https://github.com/wanyexin1998/deepseek-harness/blob/53015a6f39710dac52ed08f05aca0c6bad7444ac/packages/client/ui-layout/src/client/AppFrame.tsx#L233-L279)。

Workbench 当前已请求 capacity 2，并对 protocol、`requestCapacity()`、`visible` 和 capacity fail closed。[Workbench client/index.tsx](https://github.com/wanyexin1998/dsh-workbench/blob/95a08cc15ec2b893f4d85917ddad425aa7de63dd/packages/dsh-workbench/src/client/index.tsx#L41-L47)、[guard.ts](https://github.com/wanyexin1998/dsh-workbench/blob/95a08cc15ec2b893f4d85917ddad425aa7de63dd/packages/dsh-workbench/src/client/guard.ts#L17-L93)

## 5. 现成 DSH 插件调研

### 5.1 可复用部分

`AHGGG/dsh-side-chat@0.7.2` 已实现非常接近的行为：

- `ConversationSelection` 包含 `parentSessionId`、fragment、node/turn key、seq、文本 offsets、`atSeq` 与 viewport rect。[contracts.ts](https://github.com/AHGGG/dsh-side-chat/blob/e7cd447d97825a944b3d83e2a34488485dc1f088/src/shared/contracts.ts#L34-L62)
- 选区必须处于一个已完成、model-visible 的消息内，并受 UTF-8 byte limit 约束。[selection-normalizer.ts](https://github.com/AHGGG/dsh-side-chat/blob/e7cd447d97825a944b3d83e2a34488485dc1f088/src/client/selection/selection-normalizer.ts)
- `Add to chat` 使用 InputTrigger reference，保留既有 draft，并支持聚合多个 annotation。[add-to-conversation.ts](https://github.com/AHGGG/dsh-side-chat/blob/e7cd447d97825a944b3d83e2a34488485dc1f088/src/client/parent-composer/add-to-conversation.ts#L227-L264)
- `More details` 打开 child 后立即发送固定解释提示；`Ask in side chat` 只打开草稿，不自动发送。[Rc6SideChatOverlay.tsx](https://github.com/AHGGG/dsh-side-chat/blob/e7cd447d97825a944b3d83e2a34488485dc1f088/src/client/rc6/Rc6SideChatOverlay.tsx#L359-L390)
- Host provider 从已完成 Turn 边界复制 parent prefix，建立 child lineage，继承 model/preset/workspace，并在关闭时归档和释放 Agent。[archived-fork-service.ts](https://github.com/AHGGG/dsh-side-chat/blob/e7cd447d97825a944b3d83e2a34488485dc1f088/src/host/archived-fork-service.ts#L162-L245)

### 5.2 不能原样安装进 Workbench 的原因

1. 它从 `sessions.currentSessionId()` 获取 Session，却用全局 `document.querySelector('[data-chat-flow]')` 获取 conversation root。双 Pane 时，全局查询会命中 DOM 顺序中的第一个 flow，可能形成“右 Session + 左 DOM”的错配。[Rc6SideChatOverlay.tsx](https://github.com/AHGGG/dsh-side-chat/blob/e7cd447d97825a944b3d83e2a34488485dc1f088/src/client/rc6/Rc6SideChatOverlay.tsx#L97-L123)
2. Composer 适配器同样要求 selection 的 parent 等于全局 current，再通过 current scope 获取 input；异步 focus 变化会使动作失效或命中错误 Pane。[sessions-adapter.ts](https://github.com/AHGGG/dsh-side-chat/blob/e7cd447d97825a944b3d83e2a34488485dc1f088/src/client/rc6/sessions-adapter.ts#L242-L270)
3. `focusParentComposer()` 通过全局查询聚焦输入框，无法保证命中 selection 所属 Pane。[Rc6SideChatOverlay.tsx](https://github.com/AHGGG/dsh-side-chat/blob/e7cd447d97825a944b3d83e2a34488485dc1f088/src/client/rc6/Rc6SideChatOverlay.tsx#L45-L62)
4. 它自建了 Conversation、Tool、Reasoning 和 Pending Interaction 的 renderer；Workbench 的既有规则要求在显式 `SessionProvider(sessionId)` 下复用 stock Conversation，不能复制 renderer。[ArchivedConversation.tsx](https://github.com/AHGGG/dsh-side-chat/blob/e7cd447d97825a944b3d83e2a34488485dc1f088/src/client/rc6/ArchivedConversation.tsx)

结论：**复用协议和算法，不直接复用整体 UI。** 如果移植 MIT 代码，必须保留许可证声明并更新 Workbench 的 third-party notices。

## 6. 推荐产品行为

### 6.1 共同选区约束

v1 的合法选区应满足：

- 可见、非空；
- start/end 属于同一个 `[data-chat-flow]`；
- start/end 属于同一个 `[data-session-pane]`；
- 位于同一个已完成的 user、assistant 或 context message；
- 对应 node 仍存在、仍 model-visible、仍 settled；
- UTF-8 编码后不超过 16 KiB；
- action 执行前重新验证 parent Session 与 source node，过期则 fail closed。

v1 不支持跨消息或跨 Pane 选择，也不接受仍在 streaming 的消息。这样可以避免把尚未落定的文本或错误 Session prefix 带入 child。

### 6.2 添加到对话

1. 从选区捕获 `ConversationSelection`。
2. 根据 `selection.parentSessionId` 获取 `sessions.scope(id)`。
3. 使用 `conversation.input.for(scope)` 获取来源 Pane 的 composer。
4. 通过 `input.insertReference()` 写入或更新聚合 annotation occurrence。
5. 保留用户原有 draft；动作完成后聚焦来源 Pane 的 composer。
6. 不自动发送、不启动模型 Turn。
7. 用户发送时，reference codec 序列化成带来源标记的 `<selected_context>`，通过正常输入路径进入 Session 日志。

支持多个选区时，建议一个聚合 capsule 内保存有序 annotation 列表，每项包含 selected text、可选 comment 与源定位；移除一项不能破坏其他项或普通 draft。

### 6.3 更多详情

1. 捕获并验证 selection。
2. 从 `selection.parentSessionId` 与 `selection.atSeq` fork child。
3. 把 child 作为第二个 Pane 打开。
4. 给 child 的首条输入加入 reference-only boundary 与 selected context。
5. 自动发送固定、本地化提示，例如“请结合父会话上下文，更详细地解释这段内容。”
6. 主 Session 不被 steer、interrupt，也不写入该问题与回答。

### 6.4 在侧边聊天中提问

前四步与“更多详情”一致，但行为不同：

- 选区作为 child composer 的结构化 reference；
- 不自动发送；
- 用户可以编辑问题、添加普通文本或调整模型设置；
- 用户显式发送后才开始 child Turn。

### 6.5 Child Session 语义

- 使用 fork，而不是创建一个无上下文 fresh chat；
- 继承父会话的已完成事件前缀、cwd、model target、preset 与 Workspace；
- 当前 Workbench 的零工具 Chat preset 表示另一种“新建轻量会话”产品语义，不应暗中替代 fork；
- boundary 必须告诉模型：继承历史是 reference，只有 boundary 之后的新问题是当前任务；
- child 的命令、文件写入和外部副作用都是真实副作用，关闭 Pane 不会回滚；
- child 继续使用既有权限和 approval 流程，UI 与文档必须明确这一点。

## 7. 推荐技术方案

### 7.1 总体调用链

```text
Browser Selection
  → PaneSelectionController
      capture nearest pane + chat node
      normalize text + offsets + rect
      freeze parentSessionId + atSeq
  → SelectionActions
      ├─ addToConversation
      │    → PaneComposerAdapter
      │    → InputTrigger reference
      ├─ moreDetails
      │    → SideChatActions.fork
      │    → Presentation.open(child, beside)
      │    → child scoped send(fixed explanation)
      └─ askInSideChat
           → SideChatActions.fork
           → Presentation.open(child, beside)
           → child scoped draft/reference
```

### 7.2 Pane-scoped 来源解析

任何动作都不能在执行时重新读取全局 `focused/current` 作为来源。应在捕获选区时解析并固定身份：

```text
Range.startContainer / Range.endContainer
  → nearest [data-chat-anchor-key]
  → nearest [data-chat-flow]
  → nearest [data-session-pane]
  → data-session-pane = parentSessionId
```

规则：

- 两端 Pane 或 message anchor 不同则拒绝；
- 双 Pane 下找不到最近 Pane 时拒绝，不允许退化到文档第一个 `[data-chat-flow]`；
- 单 Pane 模式可使用唯一 `presentation.visible[0]` 作为受控 fallback；
- `parentSessionId`、source key、seq 和 offsets 写入 selection value，后续 focus 变化不影响动作路由。

该设计沿用 Workbench 已有的异步身份规则：动作以发起时捕获的 Session 为权威，而不是 await 完成后的 focus。

### 7.3 推荐接口

```ts
interface ConversationSelection {
  readonly parentSessionId: SessionId
  readonly nodeKey: string
  readonly nodeKind: string
  readonly atSeq: number
  readonly text: string
  readonly startOffset: number
  readonly endOffset: number
  readonly rect: SelectionRect
}

interface SelectionActions {
  addToConversation(
    selection: ConversationSelection,
    comment?: string,
  ): void

  moreDetails(
    selection: ConversationSelection,
  ): Promise<SessionId>

  askInSideChat(
    selection: ConversationSelection,
  ): Promise<SessionId>
}
```

选择三个显式动词的原因：

- 调用者只需传 selection，不需要理解 intent/options 组合；
- 模块内部隐藏 stale validation、composer CAS、fork、Pane capacity、错误提示与回滚；
- 当前只有 Workbench 自身一个动作提供者，不需要提前建设 action registry；
- 将来出现第二个真实第三方 action provider 时，再考虑开放版本化 registry。

### 7.4 Child Pane 打开与容量策略

```ts
const childId = await sessions.fork({
  sessionId: selection.parentSessionId,
  atSeq: selection.atSeq,
  increaseTitle: true,
})

sessions.presentation.open(childId, { disposition: 'beside' })
sessions.presentation.focus(childId)
```

容量规则：

- **只有来源 Pane：** 在来源旁打开 child。
- **已有两个 Pane：** 不自动替换。显示“替换另一 Pane / 取消”；用户确认后只替换非来源 Pane。
- **来源 Pane 已不可见：** 操作失败并提示重新选择，不猜测目标。
- **fork 成功但 Pane 打开失败：** 明确报告 child 已创建；不得把创建成功伪装成整体失败，也不得悄悄删除 Session。

Presentation protocol 2 保证 focus 不重排 Pane，因此打开 child 后来源 Pane 的 React subtree、draft、滚动与 Navigator 状态不会因为 focus 切换而重挂载。

### 7.5 Model-visible 日志

实现不需要新增 SessionEvent：

- `添加到对话` 在发送时由 reference codec 生成模型文本，随普通用户消息写入 `user/message`；
- side child 的 boundary、selected context 与用户问题同样通过现有用户输入或 context injection 写入 child 日志；
- parent 日志不记录 side child 的问题和回答；
- 不允许直接在调用模型时拼接一个未记录的隐藏字符串。

## 8. 预计文件变更地图

### 8.1 Workbench 新增模块

建议新增：

```text
packages/dsh-workbench/src/native-ux/client/
  selection-contract.ts
  selection-controller.ts
  selection-actions.tsx
  selection-reference.ts
  side-chat-actions.ts
```

职责：

- `selection-contract.ts`：Selection value、错误码、动作结果。
- `selection-controller.ts`：DOM Range 捕获、Pane/message 解析、stale 校验、事件生命周期。
- `selection-actions.tsx`：浮动工具条、键盘/触屏、optional annotation editor。
- `selection-reference.ts`：InputTrigger source、codec、聚合 annotation occurrence。
- `side-chat-actions.ts`：fork、容量决策、child draft/send、失败状态。

### 8.2 Workbench 修改点

- [`src/client/index.tsx`](https://github.com/wanyexin1998/dsh-workbench/blob/95a08cc15ec2b893f4d85917ddad425aa7de63dd/packages/dsh-workbench/src/client/index.tsx#L36-L38)
  - 注入 `conversation`、`inputTriggers`；
  - 创建 selection controller；
  - 在 `shell.overlay` 注册工具条；
  - 通用 Add 能力与 Presentation-dependent side actions 分别做 capability gate。
- [`harness-adapter.ts`](https://github.com/wanyexin1998/dsh-workbench/blob/95a08cc15ec2b893f4d85917ddad425aa7de63dd/packages/dsh-workbench/src/native-ux/client/harness-adapter.ts)
  - 声明公开 `fork`、`visible/focused/open/focus` 与 per-session input face。
- [`conversation-dom.ts`](https://github.com/wanyexin1998/dsh-workbench/blob/95a08cc15ec2b893f4d85917ddad425aa7de63dd/packages/dsh-workbench/src/native-ux/client/conversation-dom.ts#L6-L40)
  - 增加 Range → 最近 flow/Pane 的严格解析；
  - 增加按 Session 定位并聚焦 composer；
  - DOM 只用于来源解析和 focus，不用于写 draft。
- `dictionaries.ts`
  - 增加三项动作、错误提示、容量确认与 side boundary 的中英文文案。
- `package.json`
  - 增加 `dsh-client-ui-input-trigger`；
  - 如复用原生 Menu/Markdown primitives，同步相应 peer/dev dependency 与 client inject。
- 文档
  - 更新 `docs/PRODUCT_CONTRACT.md`；
  - 新增 Pane-scoped selection ADR；
  - README 说明 side child、共享 Workspace、持久化和权限风险；
  - 若移植 MIT 代码，更新 `THIRD_PARTY_NOTICES.md`。

### 8.3 Harness 变更

对已经绑定 Presentation protocol 2 的 Workbench Edition，v1 不需要额外修改 Harness：

- `sessions.fork()` 已公开；
- Presentation 已支持 capacity 2、`visible + focused` 与 beside open；
- AppFrame 已按显式 SessionProvider 渲染 stock Conversation；
- InputTrigger 与 scoped Conversation input 已存在。

Stock Harness 没有双 Pane Presentation；在 stock 模式下可以启用“添加到对话”，侧聊动作必须 capability-gate 并明确提示需要 Workbench Edition。

## 9. 风险与产品决策

| 风险/决策 | 建议 |
|---|---|
| 选区被当成指令 | 使用 reference-only boundary；XML/文本转义；选区进入 `<selected_context>`，用户问题单独表达 |
| Streaming 文本不稳定 | v1 只允许 settled message；未来有稳定 response target 后再扩展 |
| 双 Pane 路由错误 | 捕获时冻结 parentSessionId；所有 scoped API 显式传 id；禁止全局第一个 flow fallback |
| await 后 focus 改变 | 不重读 focus；使用发起时 identity |
| 两 Pane 已满 | 用户确认是否替换非来源 Pane；默认不替换 |
| fork 与 Pane 打开部分成功 | 独立报告 child 创建、Pane 打开两个结果；不自动删除 child |
| Side Chat 产生写操作 | 共享 Workspace 的副作用真实存在；沿用 approval；UI 和文档明确提示 |
| 关闭 Pane 的含义 | v1 只关闭 presentation；是否 archive 是独立产品选择，不等同删除 |
| 草稿刷新恢复 | 聚合 reference 需要与 draft signature/sessionId 一致；不按纯文本模糊恢复 |
| 第三方代码复用 | 固定 SHA、保留 MIT notice、只移植必要模块并独立复核 |

建议在实施前明确两个产品选择：

1. 关闭 side child Pane 后是否保留为普通 fork Session；推荐保留，用户可从 Session 列表重新打开。
2. “更多详情”是否允许工具执行；推荐继承正常 approval，但 boundary 默认要求轻量、非修改性解释，任何实际修改仍需用户在 side child 中明确提出。

## 10. 验证计划

### 10.1 Selection 与 Pane 路由

- 左、右 Pane 分别划词，必须命中各自 Session。
- 右 Pane 不能读取左 Pane 的 `[data-chat-flow]` 或 composer。
- 跨 Pane、跨 message、collapsed、仅控件文本、超过 byte limit 的选区 fail closed。
- inline emphasis、链接、inline code、多个文本节点能按可见顺序规范化。
- 捕获后切换 focus，动作仍命中捕获时的 `parentSessionId`。
- Escape、scroll、resize、Session replacement 与 plugin dispose 清理浮层和 listeners。

### 10.2 添加到对话

- 保留已有普通 draft。
- 连续加入多个选区，只产生一个聚合 capsule。
- 可选 comment 与选区保持一一对应。
- 删除/编辑一项不影响其他项。
- 发送失败时 draft/reference 保留；成功后才清理。
- codec 缺失或序列化失败时阻止发送，不静默丢弃选区。
- 最终日志顺序与模型输入可由 Session replay 重建。

### 10.3 更多详情与侧聊提问

- 每次动作最多创建一个 child。
- fork boundary 包含选中消息所在的完整已完成 Turn。
- 主 Session 正在运行时不调用 parent steer/interrupt。
- “更多详情”只自动发送一次固定提示。
- “在侧边聊天中提问”只写 child draft，不自动发送。
- child 继承 parent cwd、model、preset、Workspace 与 lineage。
- boundary 与 selected context 在 child 日志中可重建。
- fork、open、draft、send 的错误均有可见状态与重试路径。

### 10.4 Presentation 与真实组合

- 单 Pane beside open。
- 两 Pane 满容量时先确认，再只替换非来源 Pane。
- focus 变化不重排 Pane，不重挂载来源 Conversation。
- 两个 Pane 的 draft、滚动、Navigator、streaming 和 pending interaction 相互独立。
- Cordis effect dispose 后所有注册、DOM listener 与 controller 释放。
- 通过真实 Loader composition 与浏览器 E2E 验证，不只做手工 Context 单测。
- 产品可见行为增加 keyless assembled-app snapshot；沿用 protocol 2 snapshot 的验证层级。

建议实施期命令：

```powershell
pnpm --filter @wanyexin1998/dsh-workbench typecheck
pnpm --filter @wanyexin1998/dsh-workbench test
pnpm --filter @wanyexin1998/dsh-workbench build
pnpm release:check
```

本调研阶段未运行上述命令。

## 11. 推荐实施阶段

### P0 — 产品与接口冻结

- 确认关闭/保留策略、满容量确认文案、权限提示。
- 写 ADR 与 `ConversationSelection`/`SelectionActions` 接口。
- 固定参考实现 SHA 与许可证范围。

### P1 — Pane-scoped selection 与添加到对话

- 实现 DOM capture/normalize/stale validation。
- 实现 `shell.overlay` 工具条。
- 接入 scoped composer 与 InputTrigger reference。
- 完成双 Pane 路由、draft/recovery 与 HMR 生命周期测试。

### P2 — Forked side child

- 实现 `sessions.fork()`、capacity 处理和 child Pane 打开。
- 注入 boundary 与 selection context。
- 分别实现 auto-send 的“更多详情”和 staged 的“在侧边聊天中提问”。
- 验证主 Session 不受影响及 partial-success 错误状态。

### P3 — 真实应用验收与文档

- 真实 Loader/Web E2E、keyless snapshot、Windows/macOS/Linux 浏览器验证。
- 更新产品契约、README、风险说明与 third-party notices。
- 完成独立复核后，再决定 commit、发布与 Workbench Edition 集成。

## 12. 不在本次实现范围内

- 不修改 Agent loop。
- 不新增 SessionEvent 类型。
- 不新增 ACP 或 SDK side-chat 方法。
- 不实现跨消息或跨 Pane 选区。
- 不支持 streaming response 选区。
- 不自动安装第三方 side-chat 插件。
- 不自动删除或迁移已有 Session。

## 13. 最终建议

按 **P0 → P1 → P2 → P3** 分阶段实施，先交付 Pane-scoped selection 与“添加到对话”，再接入 forked child Pane。这样可以先验证最核心的 Selection→Composer 路由与持久化语义，再增加 Session 生命周期和模型调用，问题定位更清晰。

实现时应把 `AHGGG/dsh-side-chat` 当作经过实践的算法参考，而不是可直接安装的 Workbench 组件；最终 UI 与 child Conversation 必须复用 Workbench/Harness 现有 Pane、SessionProvider 和 stock Conversation。

本报告只完成方案调研和实施地图，不构成代码修改、commit、发布或安装授权。
