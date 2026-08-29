# 03 — 划词与"添加到对话"

**What to build:** 用户在任一 Pane 选中一段已完成消息的文字，浮动工具条出现（本阶段仅一个按钮）；点"添加到对话"后，选区作为聚合 annotation reference 进入**来源 Pane** 的 composer，与用户既有草稿共存，可连续收集多段并附加评论，最终一次发送；发送时经 reference codec 序列化进入会话日志。含全部选区基建：DOM Range 捕获、规范化、合法性校验（`../research.md` §6.1）、Pane-scoped 来源解析（§7.2，捕获时冻结 parentSessionId）。stock Harness 上完整可用。

**Blocked by:** 01 — ADR 与接口契约冻结

**Status:** ready-for-agent

- [ ] 合法选区出现工具条；非法选区（跨 Pane、跨消息、streaming 中、collapsed、纯控件文本、超 16 KiB）fail closed，不出现或明确禁用
- [ ] 双 Pane 下左右各自划词，动作分别命中各自 Session；不存在"退化到文档第一个 flow"的路径
- [ ] 捕获后切换 focus，动作仍命中捕获时的 parentSessionId
- [ ] 选区进入来源 Pane composer 的聚合 capsule；保留既有草稿；多段收集只产生一个 capsule；删除一项不影响其他项与草稿
- [ ] 发送成功后日志顺序与模型可见文本可由 Session replay 重建；发送失败时草稿与 reference 保留
- [ ] codec 缺失或序列化失败时阻止发送，不静默丢弃选区
- [ ] Escape / scroll / resize / Session 替换 / 插件 dispose 均清理浮层与 listener
- [ ] stock Harness 上全部行为可用；typecheck 与测试全绿
