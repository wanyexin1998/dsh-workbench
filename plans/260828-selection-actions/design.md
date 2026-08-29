# Chat 与划词动作统一设计（PRD） / Unified Chat & Selection Actions (PRD)

> - 设计日期：2026-08-28；决策冻结：2026-08-28
> - 状态：**PRD 已冻结** —— D1–D6 全部裁决（见 §7），可进入实施拆解
> - 上游输入：`research.md`（划词动作与侧聊调研）+ `feat/chat-mode-l1` 分支已落地的零工具 chat preset（seeding 已提交：`60b134b`、`95a08cc`）
> - 本文档整合两条此前独立推进的产品线，替代先前对话中"悬浮聊天窗"的设计方向；非目标清单沿用 `research.md` §12 并在 §7.1 补充

## 1. 重新设计了什么

此前有两条独立的线：

- **线 A（chat 模式）**：零工具"聊天模式 / Chat mode" preset（已 seed、已文档化），计划用 `Ctrl+Shift+C` 唤起一个自建 UI 的悬浮聊天窗。
- **线 B（research.md）**：划词三动作（添加到对话 / 更多详情 / 侧聊提问），侧聊 = `sessions.fork()` child 开在第二个原生 Pane。

本设计做三个整合决策：

1. **悬浮窗退役。** research.md 确认 Presentation protocol 2 的第二 Pane 能以原生 `SessionProvider(sessionId)` 承载任何会话。chat 会话开在旁边的原生 Pane，比自建悬浮窗 UI 成本低一个量级（零自建 conversation renderer）、契约更顺（invariant 1：复用 stock Conversation）、功能更全（模型选择器、审批、历史、Navigator 全部原生可用）。`Ctrl+Shift+C` 的语义从"弹悬浮窗"改为"**在旁边打开聊天**"。
2. **两种会话底座并存，绝不混用。** Fresh chat（零工具 preset、无上下文）与 Side chat（fork child、继承上下文与权限）解决两种本质不同的提问需求；research.md §6.5 "chat preset 不应暗中替代 fork" 的立场被采纳为硬规则。
3. **一套呈现与容量策略。** 所有"在旁边打开"的会话（fresh chat 与 side chat）共用同一个 Pane 容量决策树（§4），避免两套逻辑漂移。

## 2. 概念模型

一个功能族，暂名 **Workbench Ask（随手问）**，由"两种会话底座 × 三个触发入口 × 一个呈现策略"构成：

| | Fresh chat（闲聊 / 通用提问） | Side chat（选区追问） |
|---|---|---|
| 会话来源 | `session.create({workspaceId, agentPreset:'chat'})` | `sessions.fork({sessionId, atSeq})` |
| 上下文 | 无（干净、请求极小） | 继承父会话已完成事件前缀 + reference-only boundary |
| 工具与权限 | **零工具**（架构上无副作用） | 继承父 preset 与 approval 流程（副作用真实存在） |
| 归属工作区 | 名为 `chat` 的工作区（存在时）→ 当前工作区 | 继承父会话工作区 |
| Pane 标题栏标签 | "聊天模式 / Chat mode" | 父 preset 名 + fork 标题 |
| 触发入口 | `Ctrl+Shift+C` | 划词工具条："更多详情"（auto-send）/"在侧边聊天中提问"（draft） |

第三个入口"添加到对话"不创建会话：选区作为聚合 reference 进入**来源 Pane** 的 composer（完整方案见 research.md §6.2，本设计不改动）。

用户的判断规则只有一条，且由 Pane 标题栏的 preset 标签承载：**看到"聊天模式"标签 = 这个窗口永远不会碰你的文件；看到其他标签 = 它有工具，副作用规则同主会话。**

## 3. 用户体验

### 3.1 `Ctrl+Shift+C` — 随手问（fresh chat）

工作会话原地不动。按键后旁边滑开第二个 Pane：一个全新的聊天模式会话，composer 已聚焦，直接打字回车。问完 `Ctrl+\`（既有 close-focused-pane 动作）收起 Pane；会话保留在侧栏（归属见 §2），可随时重开。再次按 `Ctrl+Shift+C` 时**复用当天最近的 blank chat 会话**（若存在），避免侧栏堆积空会话。

### 3.2 划词 → 更多详情（side chat，auto-send）

在任一 Pane 选中一段已完成消息的文字 → 浮出工具条 → 点"更多详情" → 旁边 Pane 打开 fork child，自动发送一条固定的本地化解释请求（选区在 `<selected_context>` 中，boundary 声明"继承历史仅供参考"）。父会话不被 steer、不被打断、日志无痕。

### 3.3 划词 → 在侧边聊天中提问（side chat，draft）

同上，但 child 的 composer 只带选区 reference 和空草稿，用户自行编辑问题后显式发送。

### 3.4 划词 → 添加到对话

选区进入**来源 Pane** composer 的聚合 annotation capsule，可连续收集多段、附加评论，与已有草稿共存，用户最终发送一次。完整行为契约沿用 research.md §6.2。

### 3.5 stock Harness 降级（无 Presentation protocol 2 时）

- 添加到对话：**可用**（不依赖 Pane）。
- `Ctrl+Shift+C`：降级为"切换到新 chat 会话"（`sessions.open`），提示一次降级原因（待确认，见 §7-D2）。
- 更多详情 / 侧聊提问：capability-gate 关闭，工具条只显示"添加到对话"。

## 4. 呈现与容量策略（统一决策树）

对任何"在旁边打开 X"的请求（X = fresh chat 或 side child）：

1. **只有一个可见 Pane** → beside 打开 X，focus X。
2. **已有两个 Pane，其一是"来源 Pane"**（side chat 的父会话 Pane；fresh chat 视聚焦 Pane 为来源）→ 弹确认："替换另一个 Pane / 取消"，确认后只替换非来源 Pane。
3. **来源 Pane 已不可见**（side chat 独有）→ 失败并提示重新选择，不猜测目标。
4. **fork/create 成功但 Pane 打开失败** → 分别报告两个结果；会话已创建的事实不被掩盖，不自动删除。

Presentation protocol 2 保证 focus 变化不重排、不重挂载，来源 Pane 的草稿、滚动、Navigator 状态在整个过程中不受影响。

## 5. 技术架构

### 5.1 复用（零新增）

- 划词捕获、Pane-scoped 来源解析、选区校验、InputTrigger reference、fork 调用链、model-visible 日志规则：**全盘采纳 research.md §6.1、§7.2–§7.5**，不再重复。
- chat preset seeding（host 侧）已落地，不变。
- 关闭 Pane：复用既有 `workbench.pane.close-focused`。

### 5.2 新增模块（在 research.md §8.1 清单上追加一项）

```text
packages/dsh-workbench/src/native-ux/client/
  selection-contract.ts      # research.md 原样
  selection-controller.ts    # research.md 原样
  selection-actions.tsx      # research.md 原样
  selection-reference.ts     # research.md 原样
  side-chat-actions.ts       # research.md 原样，容量决策树抽出共享 →
  beside-open.ts             # 新增：统一的"在旁边打开"容量决策树（§4），
                             #   fresh chat 与 side chat 共同消费
  chat-actions.ts            # 新增：fresh chat 创建/复用 + 归属解析
                             #   (chat 工作区查找 → 当前工作区 fallback)
```

### 5.3 快捷键动作

- `workbench.chat.open`，默认 `Primary+Shift+C`（不在浏览器保留键位表），label 双语词条，capability gate：`connection` + `workspaces` seam 存在；Edition 下走 beside-open，stock 下按 §7-D2 的决策降级。

### 5.4 harness-adapter 扩展

按 research.md §8.2：声明 `fork`、`presentation.visible/focused/open/focus`、per-session input face；本设计追加 `connection.api.sessions.create`（fresh chat 用，chat-mode 对话中已验证）与 `workspaces.list` 快照面（归属解析用）。

## 6. 安全与信任边界

- Fresh chat 的"零副作用"承诺由 preset 架构保证（无工具行），UI 上由 Pane 标签传达；README 已有的对比表在 P3 扩展为三列（极简 / 聊天 / side chat）。
- Side chat 的副作用真实存在（继承父权限与 approval）；"更多详情"的 boundary 文案默认要求轻量、非修改性解释，任何实际修改仍需用户在 child 中明确提出（research.md §9 决策 2，推荐采纳）。
- 选区永远进入 `<selected_context>` 转义容器，不与用户指令混排（防"选区被当成指令"）。

## 7. 决策记录（P0 已冻结，2026-08-28 用户裁决）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 悬浮窗正式退役，`Ctrl+Shift+C` 改为"旁边 Pane 打开聊天" | **✅ 退役**（Edition 第二 Pane 全面优于自建悬浮窗） |
| D2 | stock Harness 下 `Ctrl+Shift+C` 的行为 | **✅ 方案 a**：降级为切换到新 chat 会话 + 一次性降级提示；不 gate |
| D3 | side child 关闭 Pane 后是否保留会话 | **✅ 保留**，侧栏可重开 |
| D4 | "更多详情"是否允许工具执行 | **✅ 继承 approval** + boundary 声明轻量、非修改性解释 |
| D5 | 功能族名 | **✅ 随手问 / Workbench Ask** |
| D6 | fresh chat 的 blank 会话复用策略（§3.1） | **✅ 复用**当天最近 blank chat 会话 |

### 7.1 非目标（v1 明确不做）

沿用 `research.md` §12 全部条目（不改 Agent loop、不新增 SessionEvent、不支持跨消息/跨 Pane/streaming 选区、不自动安装第三方插件、不自动删除或迁移会话），另补充：

- 不做悬浮聊天窗（D1 裁决；将来如需为 stock 用户增强再单独立项）；
- 不做 chat 专用工作区的自动创建（归属靠查找链：名为 `chat` 的工作区 → 当前工作区）；
- 不做 side chat 的模型/preset 覆盖（fork 全量继承父会话）。

### 7.2 成功信号

- 用户从任意工作会话到"发出第一条聊天提问"≤ 2 次交互（一次快捷键 + 打字回车），工作 Pane 状态零扰动；
- 划词三动作在双 Pane 下 100% 命中来源 Pane（验证计划 research.md §10.1）；
- fresh chat 每轮请求 token 维持零工具水平（首轮输入 ~200 tok 量级）；
- stock 环境下添加到对话与 chat 快捷键（降级形态）可用，侧聊动作被干净地 gate。

## 8. 实施路线图（整合版）

- **已完成**（`feat/chat-mode-l1`）：chat preset seeding + 契约 carve-out + README 对比表。
- **P0**：本文档决策冻结；写 ADR（Pane-scoped selection + 两种会话底座并存）；固定参考实现 SHA 与 MIT notice 范围。
- **P1**：划词基础设施 + "添加到对话"（research.md P1 原样）**∥** `workbench.chat.open` 快捷键（fresh chat beside-open + 归属解析 + stock 降级）。两者无依赖，可并行。
- **P2**：fork side chat（更多详情 / 侧聊提问）+ 统一容量决策树接入。
- **P3**：真实 Loader/浏览器 E2E、keyless snapshot、产品契约与 README 更新、third-party notices（如移植 MIT 代码）。

验证计划沿用 research.md §10，追加 fresh chat 断言：chat Pane 标题栏显示聊天模式标签；chat 会话零工具（`tools` 字段缺席）；blank 复用不产生第二个空会话；stock 降级路径可用。

## 9. 风险（在 research.md §9 之上新增）

| 风险 | 缓解 |
|---|---|
| 用户混淆 fresh chat 与 side chat 的副作用边界 | Pane 标签 + README 三列对比表 + "更多详情" boundary 文案 |
| blank chat 会话堆积 | D6 复用策略 + blank 会话在宿主侧栏本就默认隐藏 |
| chat 工作区归属规则不被发现 | README 明确写"建一个名为 chat 的工作区即可集中聊天"；无 chat 工作区时行为仍正确 |
| Edition/stock 行为分叉造成文档漂移 | 降级行为写入 PRODUCT_CONTRACT，capability gate 集中在一处 |

---

## English Summary

This design merges two previously independent tracks — the zero-tool **chat preset** (already seeded on `feat/chat-mode-l1`) and the **selection-actions / side-chat** research (`research.md`) — into one feature family, tentatively "Workbench Ask".

Key decisions: (1) the floating chat window is **retired** — the Presentation-protocol-2 second Pane renders any session natively at a fraction of the cost, so `Ctrl+Shift+C` now means "open a chat beside"; (2) two session substrates coexist and never substitute for each other: *fresh chat* (`session.create` with the zero-tool chat preset, no context, no side effects) and *side chat* (`sessions.fork` child inheriting parent context, tools, and approvals), with the Pane-header preset label as the user-facing trust boundary; (3) one shared beside-open capacity policy (§4) serves both. The three selection actions (add-to-conversation / more-details / ask-in-side-chat) are adopted from research.md unchanged. On stock Harness, add-to-conversation stays available, side-chat actions are capability-gated off, and `Ctrl+Shift+C` degrades to switching into a new chat session with a one-time notice (D2 = option a, frozen). All six product decisions (§7) are frozen as recommended; the feature family is named "随手问 / Workbench Ask". The roadmap runs P0 (ADR) → P1 (selection infra + add-to-conversation ∥ chat shortcut) → P2 (forked side chat) → P3 (E2E, contract, docs).
