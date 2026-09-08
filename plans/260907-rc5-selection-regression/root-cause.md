# rc.5 划词与随手问失效 —— 根因

> ⚠️ **本文有两处归因是错的，且不止一个缺陷。**
> 先读同目录的 [`outcome.md`](outcome.md)。原文保留不改，作为当时认知的记录。

> 2026-09-07 晚。用户升级到 `0.1.2-rc.1` 宿主 + Workbench `0.2.0-rc.5` 后，
> **划词引用和随手问都不工作**。已用带日志的插件构建在真实宿主上钉死根因。

## 现象

- 真实鼠标拖拽选中正文 → **没有划词工具栏**
- 真实按 `Ctrl+Shift+C` → **没反应**
- 全程零报错：浏览器控制台干净、服务端日志干净

插件本身是活的：它自己的设置页、它自己渲染的"两个 Pane 共享工作区"警告、
分屏（Ctrl+点击开第二个 Pane）**全部正常**。

## 根因

`packages/dsh-workbench/src/native-ux/client/selection-controller.ts` 的 `validatedNode()`：

```ts
raw = snapshot.chat?.nodes?.get(dom.nodeKey)
```

在 `0.1.2-rc.1` 上，**会话快照已经没有 `chat` 字段了**。插桩构建在真实宿主上打出：

```
[DIAG] validatedNode reject: chat.nodes lookup returned undefined
  hasChat: false, hasNodes: false, wantKey: "14:assistant-step2:40"
  snapshotKeys: [sessionId, queue, pendingSubmissions, running, subagent,
                 removed, openState, openError, hasMore, loadingOlder,
                 promptError, blank, lastAgentError, promptAttempted,
                 awaitingFirstTurn]
```

15 个键，没有 `chat`。可选链读到 `undefined` → `return null` → 每一次划词都被否决。

**chat 节点存储搬走了**：上游把 chat 那半边从 `ui-conversation` 拆进了新的
`@deepseek-ai/dsh-client-ui-chat`，节点表现在是那个包自己的快照契约
（`ui-chat/src/client/contract/snapshot.ts:94  readonly nodes: ChatNodeStore`），
不再挂在会话面上。

## 为什么门禁一路绿灯

1. **这是运行时数据形状的依赖，不是类型依赖。** round 1 迁移了导入和类型，
   但这条路径通过 `SelectionSessionFace` + `asRecord()` 松散读取，可选链让
   编译器无话可说。
2. **单元测试的假替身仍然提供 `chat.nodes`。** 663 个测试全绿，因为没有一个
   测试对着真实宿主跑。
3. **失败被设计成静默的。** `return null` 是 fail-closed 的本意——面不在就
   安静降级。代价是：面搬家和面消失，表现完全一样。

这和 rc.4 那次 inject 是同一个模式：**替身比真宿主宽松，于是在一个开机即坏的
构建上满分**。

## 波及范围

- 划词引用 / 引用徽标 / 笔记卡：全部不可用
- 随手问（`Ctrl+Shift+C`）：不可用（同一层适配器读会话面）
- 分屏：**不受影响**——它走呈现面，round 2 专门为 0.1.2-rc.1 重做过

也就是说：round 2 重做了呈现面，但会话/chat 面这条路没有跟着重做，
而端到端从没跑过，所以直到用户实际使用才暴露。

## 修复方向（未实施）

插件需要改从 `ui-chat` 的面读节点表，而不是 `snapshot.chat.nodes`。
连带要做的：

- `dsh.client.inject` 补上 `@deepseek-ai/dsh-client-ui-chat`（上游消费者都这么声明）
- 把测试替身改成**按真实宿主的形状**提供数据，否则同类回归还会再来一次
- 端到端要覆盖"划词出工具栏"，这是唯一能拦住这类回归的检查

## 已发布状态

`v0.2.0-rc.5` 带着这个缺陷发布了。它在自己钉的宿主上，两个主要功能不可用。
