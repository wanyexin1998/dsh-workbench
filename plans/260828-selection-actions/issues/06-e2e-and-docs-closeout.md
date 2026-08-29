# 06 — E2E 验收与文档收尾

**What to build:** 在真实浏览器与真实 Loader composition 上跑通"随手问 / Workbench Ask"全功能族的端到端验收（双 Pane 路由、容量策略、stock 降级、三个划词动作、chat 快捷键），并把产品事实同步进全部真源文档：README（随手问章节 + 极简/聊天/侧聊三列对比表，双语）、产品契约、第三方声明。

**Blocked by:** 02、03、04、05

**Status:** ready-for-agent

- [ ] 真实浏览器 E2E：左右 Pane 各自划词命中各自 Session；容量满确认替换；focus 变化不重排不重挂载；stock 降级路径可用
- [ ] chat 快捷键 E2E：Edition beside 打开与 stock 切换 + 提示各验证一遍；chat Pane 标题栏标签正确；请求维持零工具水平
- [ ] README 与 README_EN 新增"随手问"章节与三列对比表（极简模式 / 聊天模式 / 侧聊），并更新既有聊天模式章节的快捷键说明
- [ ] `docs/PRODUCT_CONTRACT.md` 记录随手问行为、side chat 副作用与 stock 降级；与 `release-contract.json` 一致
- [ ] 移植过 MIT 代码则 `THIRD_PARTY_NOTICES.md` 更新，含固定 SHA
- [ ] `pnpm release:check` 全部通过
