# 01 — ADR 与接口契约冻结

**What to build:** 把 PRD（`../design.md`）已冻结的架构决策固化为可引用的工程契约：两篇 ADR（"Pane-scoped selection 来源解析"——动作以捕获时身份为权威、禁止全局 flow fallback；"两种会话底座并存"——fresh chat 零工具 preset 与 side chat fork 互不替代），加上 `ConversationSelection` / `SelectionActions` 接口定型（以 `../research.md` §7.3 为底稿）。之后所有实现 ticket 引用这里，接口不再漂移。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] `docs/adr/` 新增两篇 ADR，编号顺延既有序列，风格与既有 ADR 一致
- [ ] `ConversationSelection` / `SelectionActions` 接口定型并被 ADR 引用，字段语义（parentSessionId 冻结时机、atSeq 含义）写明
- [ ] 参考实现 `AHGGG/dsh-side-chat` 的固定 SHA 与 MIT 许可移植范围记录在案
- [ ] 决策内容与 `../design.md` §7 决策记录逐条一致，无新增未裁决项
