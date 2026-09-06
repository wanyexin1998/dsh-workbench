# Round 2b · plugin：随手问在 0.1.2-rc.1 上的两处静默退化——修，不是记

> 这条决定第一次做的时候只在对话里，没落盘，会话中断后丢了；这次写下来。
> 分支 `rc4/upstream-0.1.2`（worktree `E:\wyx_code\Vibe coding\dsh-workbench-rc4`），在 round 2（Navigator 退役 + 徽标避让）**之后**做，同一 worktree 不并行。

## 0. 背景

round 1 的 B2 提交（`34a2f65`）把建会话迁到 `ctx.remote.session.create` 时，在注释里记下两处"改了 import 才暴露出来"的退化，并注明"修不修是产品决定，不在版本迁移里做"。当时的判断是宿主把这两个信号删了，只能降级。**核过 rc.1 源码之后，这个判断是错的：两个信号都还在，只是搬了家。** 所以结论是修，不是写进 KNOWN_ISSUES。

## 1. 当日空白 chat 会话复用（`reusableChatSessionId`）

- **现状**：`chat-actions.ts:281` 判 `summary.agentPreset !== 'chat'`。rc.1 的 `SessionSummary` 已没有顶层 `agentPreset`，条件恒真，随手问每按一次新建一个会话。
- **rc.1 事实**：预设变成了 session projection——`dsh-v0.1.2-rc.1:packages/preset/agent-presets/src/types.ts:65-68` 把 `agentPreset: string | null` 合并进 `SessionProjectionMap`，列表行通过 `SessionSummary.projectionValues?: Partial<SessionProjectionMap>` 带出来。上游自己的读法是 `ui-agent-preset/src/client/seat-store.ts:183-188`：

  ```ts
  function presetOf(session: Pick<SessionSummary, 'projectionValues'> | undefined): string | undefined {
    const value = session?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : undefined
  }
  ```
- **改法**：`harness-adapter.ts` 的 `SessionSummaryFace` 去掉 `agentPreset?`，加 `projectionValues?: { readonly agentPreset?: string | null }`（只声明我们读的那一个键，与该文件"只声明真正用到的字段"的既有做法一致）。`reusableChatSessionId` 改用与上游同形的 `presetOf()`。`null` 与 `undefined` 都视为"不是 chat"。
- **测试**：现有的复用测试把 fixture 的 `agentPreset: 'chat'` 搬进 `projectionValues`；新增一条：行上 `projectionValues.agentPreset === null` 或缺失时不复用。**杀法**：把 `presetOf` 改回读顶层 `summary.agentPreset`，复用测试必须红。
- **删掉** `harness-adapter.ts:59-66` 那段"复用永远失效"的注释——它描述的现象修完就不存在了；把出处换成上面那两个 rc.1 行号。

## 2. 零 Pane 时的 Workspace 兜底（`recentWorkspaceId`）

- **现状**：`chat-actions.ts:247-257` 用 `WorkspaceListState.recentWorkspaceId` 选"最近的 workspace"。rc.1 不再投影这个字段，零 Pane（没有聚焦会话）时随手问永远走到"无法解析 workspace，安全停止"。
- **rc.1 事实**：`dsh-v0.1.2-rc.1:packages/api/workspace-controller/src/types.ts:15-27` 的 `WorkspaceView` 有 `updatedAt: string`（ISO-8601，"last-mutation instant"）与 `createdAt`。上游侧栏自己按时间排最近（`ui-workspace/src/client/navigation.ts:224` 用会话 `updatedAt` 取 latest）。
- **改法**：兜底改为 `Date.parse(updatedAt)` 最大者；解析失败（NaN）的行跳过；全部失败仍返回 `undefined`（保持 fail-closed）。`harness-adapter.ts` 的 `WorkspaceSummaryFace` 加 `updatedAt: string`，去掉 `recentWorkspaceId?`。
- **语义差异要写进注释**：旧字段是"最近**活跃**"，新判据是"最近**被改动**"（挂载会话、改标题都算）。对随手问的用途（"用户刚刚在哪个 workspace 里"）两者足够接近；不同的场景是"用户在 A 里聊天但刚在 B 里改了标题"——这时会落到 B。接受，注明。
- **测试**：三个 workspace、`updatedAt` 乱序 → 取最大；一个 `updatedAt` 非法 → 跳过它取次大；全部非法 → `undefined`。**杀法**：把比较改成取最小，第一条红。

## 3. 验收

- `pnpm typecheck`、`pnpm test`、`node scripts/release-contract-check.mjs` 绿。
- 两个提交：`fix(ask): read the chat preset from the session projection` 与 `fix(ask): pick the fallback workspace by updatedAt`；每条 body 说明"信号没删、只是搬家"，引 rc.1 行号。
- `docs/PRODUCT_CONTRACT.md` § Workbench Ask 的 workspace 解析那一条，把"most recently active"改成按 `updatedAt`；README 对应句子（"会话优先归入标题为 chat 的 Workspace；没有该 Workspace 时使用来源会话所属 Workspace"）不用动——它没写零 Pane 的兜底。
- round-3 brief 里"C2 落在 (c) 就加 KNOWN_ISSUES"那句作废；RELEASE_NOTES 的 Fixed 段写这两条为**修复**。
