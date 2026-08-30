# 05 — 在侧边聊天中提问（draft 变体）

**What to build:** 划词工具条第三个按钮"在侧边聊天中提问"：fork 与 Pane 打开路径与 04 号完全相同，但 child 的 composer 只携带选区 reference 与空草稿，**不自动发送**——用户编辑问题、可继续补充普通文本，显式发送后才开始 child 的第一个 Turn。

**Blocked by:** 04 — 更多详情（side chat 基建）

**Status:** done

- [x] 按钮 gate 行为与 04 号一致（仅 Edition 出现）
- [x] child 打开后 composer 聚焦，携带选区 reference 与空草稿；父/child 均无模型调用发生
- [x] 用户显式发送后，boundary + 选区上下文 + 用户问题按正常输入路径进入 child 日志，可 replay 重建
- [x] 用户直接关闭未发送的 child：无模型调用发生过；会话按 PRD D3 保留
- [x] typecheck 与测试全绿
