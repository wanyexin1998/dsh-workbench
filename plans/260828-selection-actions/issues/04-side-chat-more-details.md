# 04 — 更多详情（side chat 基建 + auto-send）

**What to build:** 划词工具条新增"更多详情"按钮（仅在 Presentation protocol 2 可用时出现）：点击后从选区所在会话 fork 出 child（自 `atSeq`，继承 cwd/model/preset/workspace/lineage），child 在旁边 Pane 打开（复用 02 号的 beside-open 决策树），注入 reference-only boundary 与 `<selected_context>`，并自动发送一条固定的本地化解释请求。父会话不被 steer、不被打断、日志无痕。这是 side chat 的地基 ticket：fork、boundary、容量、错误状态全部在此落地。

**Blocked by:** 02 — 随手问快捷键（beside-open 模块）；03 — 划词与"添加到对话"（选区基建）

**Status:** done

- [x] 按钮仅在 Edition（presentation 2 探测通过）出现；stock 下不出现
- [x] 每次动作最多创建一个 child；fork 边界包含选中消息所在的完整已完成 Turn
- [x] child 继承父会话 cwd、model target、preset、Workspace 与 lineage；工具与 approval 流程照常（PRD D4）
- [x] boundary 文案声明"继承历史仅供参考，仅 boundary 之后是当前任务"，默认要求轻量、非修改性解释；选区在转义容器内，不与指令混排
- [x] 自动发送恰好一次；父会话运行中时不调用父的 steer/interrupt，父日志不记录 side 问答
- [x] 容量满时确认后只替换非来源 Pane；来源 Pane 不可见时动作失败并提示重新选择
- [x] fork 成功但 Pane 打开失败：两个结果分别报告，child 不被删除
- [x] 关闭 child Pane 只关呈现，会话保留可从侧栏重开（PRD D3）；typecheck 与测试全绿
