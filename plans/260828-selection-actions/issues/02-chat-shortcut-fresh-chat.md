# 02 — 随手问快捷键（fresh chat 全链路）

**What to build:** 用户在任意界面按 `Ctrl+Shift+C`（`Primary+Shift+C`），一个零工具"聊天模式"会话在旁边的 Pane 打开并聚焦 composer，当前工作 Pane 一个像素不动（Edition）；在无分屏协议的 stock Harness 上降级为切换到新 chat 会话并给一次性降级提示（PRD D2=a）。会话归属按查找链解析：名为 `chat` 的工作区优先，否则当前工作区。连续触发复用当天最近的 blank chat 会话（D6）。同时交付统一的 beside-open 容量决策树作为共享模块（03/04 号侧聊 ticket 复用），含两 Pane 满时"确认替换非来源 Pane"与部分成功分别报告。

**Blocked by:** 01 — ADR 与接口契约冻结

**Status:** done

- [x] Edition：按键后 chat 会话在旁边 Pane 打开并聚焦，来源 Pane 的草稿、滚动、Navigator 状态零扰动
- [x] stock：切换到新 chat 会话 + 一次性降级提示；不 gate
- [x] 归属链正确：有 `chat` 工作区归它，否则归当前工作区；一个工作区都没有时安全 no-op 并在控制台说明
- [x] blank 复用：连续触发不产生第二个空会话
- [x] 新会话使用 chat preset（Pane 标题栏显示"聊天模式 / Chat mode"标签），per-session 模型选择器照常可用
- [x] 动作 `workbench.chat.open` 出现在设置页，可改键 / 禁用 / 恢复默认；capability 缺席时不注册
- [x] beside-open 容量决策树为共享模块，容量满确认、来源不可见拒绝、部分成功分别报告均有测试
- [x] 中英词条齐全；typecheck 与测试全绿
