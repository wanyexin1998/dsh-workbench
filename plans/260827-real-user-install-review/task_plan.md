# DSH Workbench 真实用户安装测试 Review 与优化计划

> 内部执行计划，不是面向最终用户的安装文档。创建日期：2026-08-27。

## 1. 当前状态

**修订记录**：

- v1 2026-08-27：初版（Edition 方案）。
- v2 2026-08-27：第一性重估后修订——放弃 Edition 独立发行版原案，改为 upstream-first + 用户自装补丁（source bootstrap）双轨；上游沟通已实际启动（见 §3.5）；合入社区承诺清单与快捷键开放动作目录工作流。

- `stage`：拆成任务
- `status`：v2 已确认方向，上游轨道进行中，实施仍待维护者授权
- **执行清单**：v2 全部任务以 [`../260827-workbench-v2/tasks.md`](../260827-workbench-v2/tasks.md) 为唯一执行依据（含安装终态话术规范、Phase 0、主线 A/B/C 任务表与依赖图）；本文档保留战略与决策理由
- Workbench 现场指纹：`577874a6b88449ca959b883369d3b37a18697121`
- 已发布预览：`v0.2.0-rc.1`
- 官方 Harness 基线：`0.1.1-rc.2` / `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Presentation protocol 2 实现：Harness fork `codex/presentation-v2` / `53015a6f39710dac52ed08f05aca0c6bad7444ac`
- 来源：一次外部 macOS 用户安装测试、匿名化 Session 回放、当前 README/INSTALL/release contract 与两个 Harness 分支的只读检查。

本计划只描述下一轮工作。没有实施、提交、推送、发布或修改 GitHub 配置的授权。

## 2. Review 结论

### 2.1 用户目标与实际结果

用户目标是让 DeepSeek Harness Agent 快速安装 DSH Workbench，并在当前 Web profile 中使用双 Pane、Navigator 和快捷键。

实际结果不是“已安装”：Agent 完成了源码获取、依赖安装、187 项测试和本地 TGZ 构建，但由于当前 stock Harness 缺少 Presentation protocol 2，且 Session 沙箱不能写入用户的 `~/.dsh/profiles/web`，最后只交付了一条手工命令。兼容 Harness、Workbench 插件和双 Pane 均未在用户环境中完成启用验证。

### 2.2 可量化事实

| 指标 | 结果 |
| --- | --- |
| 总耗时 | 约 15 分 40 秒 |
| Session 步骤 | 37 |
| 工具调用 | 36 |
| 等待用户回答 | 约 2 分 31 秒 |
| 可避免的执行错误 | 5 |
| 用户需要理解的内部概念 | 40 位 commit、detached HEAD、Harness fork、TGZ、profile 写权限 |
| 最终状态 | 构建完成，未安装，未验证双 Pane |

Session 中的项目路径、会话内容、用户名和业务数据不得复制进仓库。后续回放测试只保存匿名化状态和预期结果。

### 2.3 根因

1. **发布物与默认安装路径冲突。** 已有不可变 GitHub Release、TGZ、SHA256 和 manifest，但 README 默认要求用户克隆源码、输入 40 位 commit、本地构建并运行完整发布检查。
2. **产品依赖没有在入口处显式呈现。** Split Pane 依赖尚未进入 stock Harness 的 Presentation protocol 2；普通用户安装插件前无法知道自己的 Harness 不具备该能力。
3. **安装流程把五个不同任务混成一次 Agent 对话。** 信任锚验证、Harness 兼容判断、源码构建、profile 写入和功能验收没有明确的短路顺序。
4. **权限降级不确定。** Agent 在无法写入 `DSH_HOME` 时向用户询问是否扩大沙箱权限，而不是确定性地产出唯一的终端命令。
5. **结果状态不清楚。** “TGZ 构建成功”容易被误解为“插件已安装”；当前流程没有机器可读的 installed、manual-action-required、incompatible 和 failed 终态。
6. **跨平台安装体验未闭环。** 当前公开步骤以 PowerShell 为主；macOS 证明源码能构建，但没有完成安装；Linux 尚无 Workbench 端到端证据。

## 3. 已确认的产品决策

### 3.1 保留 Split Pane

Split Pane 继续是 Workbench 的核心能力，不因 stock Harness 当前缺少 Presentation protocol 2 而移除。

### 3.2 两层产品

1. **通用 Workbench 插件**：可安装到 stock Harness。Navigator、Natural UX、通用快捷键及其他不依赖多 Session Runtime 的能力继续工作。检测不到 Presentation protocol 2 时，Split Pane 不激活，入口隐藏或显示简洁的兼容说明。
2. **受支持的自装补丁路径（pinned-source bootstrap）**：
   - 在官方 Harness 尚未提供 sessions.presentation 接口期间，分屏的受支持获取方式是**用户自己安装维护者的补丁**：将现有 docs/INSTALL.md §1–3（pinned commit 验证 + fork 构建 + TGZ 安装）自动化为一条可审计脚本，配独立 DSH_HOME launcher，与官方 Harness 并存、零写入官方安装。
   - 不分发预构建二进制，不做 3-OS 安装器；信任模型与现有 sourceVerification 契约同构（用户验证 pinned 源码，非黑盒二进制）。
   - 原 Edition（平台级自包含产物）降级为**条件化远期选项**，重启需同时满足：上游明确拒绝提案 + 出现可计数的非开发者用户需求证据 + 解决签名/CI 前提；届时也优先以单平台 lite 形态（zip+launcher）重估。

### 3.3 并行安装，不覆盖官方 Harness

自装补丁路径（bootstrap）必须满足：

- 使用独立启动入口，与官方 `dsh` 并存；
- 通过独立 `DSH_HOME` 保存 profile、设置和 Session，首版不自动迁移用户数据；
- 不改写官方可执行文件、官方安装目录、官方 profile 或其 `node_modules`；
- 安装、启动、升级和卸载均不得依赖修改官方 Harness；
- 卸载 bootstrap 后，官方 Harness 仍可按原状态启动；
- 不把 bootstrap 伪装成普通插件升级。

### 3.4 继续保持的边界

- 上游协作通过官方 GitHub Discussions 进行（官方现阶段不接受外部 PR/issue，CONTRIBUTING.md 明确 Discussions 为反馈渠道）；fork 仅作为提案的参考实现，不再作为永久私有分支定位；
- 不创建或触发 GitHub Actions；
- 暂不发布 npm 或 GitHub Packages；
- 不自动安装、升级或替换 Better Sidebar；
- 不静默修改用户的 stock Harness；
- Release 继续采用手工、不可变、带 SHA256 和 manifest 的发布方式；
- 未通过对应平台 E2E 前，不宣称该平台已验证支持。

### 3.5 上游协作轨道（已启动）

- 2026-08-27 已在官方 Discussions Ideas 分类发布提案：Session Presentation protocol v2（https://github.com/deepseek-ai/deepseek-harness/discussions/4718），附 fork 分支 codex/presentation-v2（commit 53015a6f）作为参考实现；
- 已获两条高质量社区评审并完成一轮提案正文修订：weijiafu14（43-seat 插槽清单证据、showing-vs-mounting 框架、capacity>1 双实例契约要求）；denial123789（渲染按 id 绑定、容量收缩、异步身份捕获、session 级插槽多实例四点 + open 满员类型化返回 + 协议编号批评）；
- 上游侦察结论：官方仓库 198.5k stars，开发在私有 org 进行，Discussions 活跃且团队成员回帖；fork diff 实测 3 commits/+1671/−171，生产代码约 500–600 行，加法式；
- 响应策略（tripwire）：上游接纳 → 删除 bootstrap 桥，插件在 stock 上自动激活；上游明确拒绝 → 触发 §3.2 的条件化 Edition 重估；上游沉默 → bootstrap 按无限期终态定价持续维护。

### 3.6 社区承诺清单（未兑现，须跟踪）

| 编号 | 承诺 | 来源 | 状态 |
| --- | --- | --- | --- |
| C1 | 提案正文条文化：渲染按 id 绑定升为协议条款、visible 禁止重复 id、close 永不归档+右邻后左邻聚焦规则、外部移除为独立 reconciliation 事件、open() 返回类型化结果（opened/replaced-focused/refused） | 对 denial123789 的回复 | 待其回复优先级后一并编辑提案 |
| C2 | 审计 fork 异步身份捕获：send/paste/upload/model-selection/question/approval 各路径是否在发起时绑定 pane session id；无论结果写入契约+验收用例 | 同上 | 未开始 |
| C3 | 跑 SandBase handbook 22 个验收用例对照 fork e2e，如实汇报通过/未通过 | 同上 | 未开始 |
| C4 | Workbench guard 结构探测加固：由纯 protocol===2 数字比对改为结构探测（requestCapacity/state 形状），消除上游未来自研 protocol 2 时的 fail-open 碰撞 | 对两位评论者回复中均承诺“正在加固” | 已有任务卡，未实施 |
| C5 | 版本号让渡：提案编号改为 upstream-owned（从 1 起或 capability/version 对）；未知版本 fail closed 到容量 1 | 对 denial123789 的回复 | 待上游表态 |

两个开放决策待社区/上游拍板——容量收缩语义（collapse-as-explicit-reconciliation vs admission-only）与 session 级插槽 opt-in 信号形态。

## 4. 目标体验与结果契约

### 4.1 Agent 安装入口

README 的默认提示词只描述用户目标，不暴露 commit、detached HEAD、pnpm、TGZ 或内部包路径。安装器负责可信 Release 校验和能力探测。

建议目标文案：

> 请安装 DSH Workbench。先检查当前 Harness：兼容双 Pane 就直接安装；不兼容时保留通用插件功能，并告诉我如何并行安装不覆盖官方 Harness 的自装补丁路径（bootstrap）。若沙箱不能写入 DSH_HOME，只给我一条最终终端命令。

### 4.2 安装状态机

| 当前环境 | 默认结果 | 不允许发生 |
| --- | --- | --- |
| stock Harness，用户只要通用功能 | 安装通用插件；Split Pane 不激活 | 报错循环、修改 Harness、宣称双 Pane 可用 |
| stock Harness，用户选择双 Pane | 安装或准备独立 bootstrap | 覆盖官方 Harness、共享并改写官方 profile |
| 已兼容 protocol 2 | 从不可变 Release 校验并安装 Workbench | clone/build 全仓、再次询问 40 位 commit |
| Agent 可写目标 `DSH_HOME` | 自动安装并执行加载验证 | 仅构建 TGZ 后宣称安装成功 |
| Agent 不可写目标 `DSH_HOME` | 准备可信产物，只输出一条终端命令 | 建议开启 `danger-full-access` 作为默认解法 |
| 能力或校验失败 | fail closed，说明一个直接原因和下一步 | 继续下载依赖、构建或修改用户环境 |

### 4.3 业务验收

- compatible + writable：3 分钟内完成安装和加载验证，0 次用户提问；
- compatible + read-only home：2 分钟内输出唯一可执行命令，0 次权限取舍提问；
- stock + base plugin：3 分钟内安装通用能力，Split Pane 明确不激活；
- stock + bootstrap：官方 Harness 保持可用，bootstrap 独立启动并验证两个真实 Session Pane；
- incompatible 或校验失败：30 秒内停止高成本动作；
- 所有结果明确属于 `installed`、`manual-action-required`、`incompatible` 或 `failed`；
- 安装流程不要求用户理解 Git commit 或本地构建工具链。

## 5. Plan P01→P07

依赖路径：

```text
P01 ─┬─> P02 ───────────┐
     └─> P03′ ──────────┼─> P05 -> P06 -> P07
                        ┘
```

P02 负责 stock Harness 的通用插件路径；P03′ 负责 source bootstrap 安装路径。两条路径在统一安装入口与文档 P05 汇合。

| Plan | 目标与输入 | 输出 | 验收 | 文件域 | Owner / 依赖 |
| --- | --- | --- | --- | --- | --- |
| P01 安装结果契约与回放基线 | 输入本次匿名化 Session 事实、`release-contract.json` 和现有安装文档，固定四种终态、耗时预算和短路规则 | 机器可读安装结果类型、匿名化回放 fixture、失败路径测试 | 回放旧流程必须显示“未安装”；Harness 不兼容时不得进入 clone/build；敏感内容扫描为零 | Workbench 安装脚本/测试、release contract、测试 fixture | Codex；无依赖 |
| P02 stock Harness 通用模式 | 保留 Navigator、Natural UX 和兼容快捷键；将 Split Pane 与 protocol 2 严格隔离 | stock-compatible 插件构建、能力 Guard、克制的兼容提示 | stock Harness 加载无错误；通用功能可用；Split Pane 不请求容量、不挂载双 Pane；compatible Harness 行为不回退 | `packages/dsh-workbench/src/client`、相关测试与字典 | Codex；依赖 P01 |
| P03′ Source bootstrap 安装脚本与隔离 launcher | 把 INSTALL §1–3（pinned commit 验证 + fork 构建 + TGZ 安装）自动化为一条可审计脚本 + 独立 DSH_HOME launcher（工作量 S–M） | 可审计的 bootstrap 安装脚本、独立 DSH_HOME launcher、隔离测试 | 官方安装零写入；一条命令完成；输出四终态之一；bootstrap 脚本对 release-contract 逐项 hash/commit 校验 | bootstrap 安装脚本、独立 launcher、隔离测试 | Codex；依赖 P01 |
| P04（已取消）Edition 打包/升级/卸载 | 取消理由：第一性重估判定三平台无签名手工发行对单人维护者不可持续，且与项目信任架构矛盾 | — | — | — | 重启条件见 §3.2 |
| P05 统一 Quick Install 与双语文档 | 将 base plugin 与 bootstrap 两条路径收敛为同一用户入口，缩短 Agent 提示词；默认路径为 Release-first（下载既有不可变 TGZ + `dsh plugin add`），不要求 40 位 commit；40 位 commit 流程保留为“高级源码构建”附录 | `README.md`、`README_EN.md`、`docs/INSTALL.md`、兼容矩阵和卸载说明 | 默认路径不要求 40 位 commit；高级源码构建与普通安装分离；中英文事实一致；明确 bootstrap 不覆盖官方 Harness；文档描述 stock 通用安装与 bootstrap 分屏两条路径 | README、安装/兼容/卸载文档 | Codex；依赖 P02、P03′ |
| P06 Windows/macOS/Linux 隔离 E2E | 使用临时、独立 `DSH_HOME` 验证四种终态与两条产品路径（工作量：XL → M） | 平台矩阵、安装日志摘要、失败证据和修复闭环 | 三平台仅验证 stock 通用插件安装、read-only home 降级、bootstrap 路径端到端 | E2E harness、平台脚本、发布候选产物 | Codex + 各平台人工运行者；依赖 P05 |
| P07 `v0.2.0-rc.2` 手工 Release 与真实用户复测 | 使用通过 P06 的不可变候选，重新执行真实用户安装旅程 | 手工 Release、TGZ 产物、`SHA256SUMS`、`release-manifest.json`、匿名化复测报告 | 新用户无需 commit 问答；选择 base 或 bootstrap 后达到对应 installed 终态；实际耗时达到 §4.3；Release 上传后回读资产与哈希 | Release 资产、release contract、release notes | 维护者发布授权 + Codex 验证；依赖 P06 |

## 工作流 W：快捷键开放动作目录

- 一句话：把快捷键目录从硬编码改为开放目录，发现源为 host 斜杠命令注册表（已证实存在）、workbench.actions 公开注册 API、pinned 适配器三层；
- 设计文档：`plans/260827-shortcuts-open-actions/design.md`（阶段 W1–W4 与验证门 V1–V3 以该文档为准）；
- 依赖：独立于 P 序列，W1 可随时启动；W2 需先通过 V1–V3 验证门。

## 6. 决策门

- bootstrap 已是主路径（原优先级 2 扶正），原“首选平台级自包含产物”降级为条件化远期选项（条件同 §3.2）；
- 明确拒绝项保留原文（修改官方 node_modules、替换全局 dsh、向默认 profile 注入补丁）；
- 新决策门 = §3.5 的上游 tripwire。
- 另列 Phase 0 余项（执行 P 序列前应完成的低成本验证）：(a) 双浏览器窗口实验——同一 profile 两个窗口各停不同 Session，验证 host 是否允许并发 client，若成立则记录为零代码的第 0 层双 Pane 交付；(b) 向真实测试用户确认 pane B 的实际用途（只读观察 vs 双向交互），确定保真度 bar；(c) 验证 dsh plugin add 是否接受 npm spec；(d) C4 guard 加固落地。已完成项：fork diff 实测、上游侦察（结果见 §3.5）。

## 7. 验证与发布证据

### Task 级验证

- P01/P02：包级单元测试与一条 stock/compatible 组合测试；
- P03′：bootstrap 脚本对 release-contract 逐项校验测试、隔离 DSH_HOME 启动、文件写入审计（官方安装零写入）、双 Pane 真实 Session 验证；
- W：W1 包级单元测试；W2 前 V1–V3 验证门证据（见 plans/260827-shortcuts-open-actions/design.md）；
- P05：链接、双语事实和 release-contract 一致性检查；
- P06：每个平台独立冷启动，不复用开发机 profile；
- P07：`pnpm release:check`、产物 SHA256、Release 资产回读和真实用户复测。

### 发布授权门

以下动作不由本计划自动授权：

- commit、push、创建 tag；
- 创建或修改 GitHub Release；
- 上传公开资产；
- 修改仓库 Topics、权限或分支保护；
- npm/GitHub Packages 发布；
- 向官方 Harness 提交 PR；
- 启动 GitHub Actions。

实施完成后必须先提交本地 diff、测试证据和 Release 预览，由维护者单独确认发布。

## 8. 风险与回退

| 风险 | 控制 | 回退 |
| --- | --- | --- |
| 上游 Harness 更新导致补丁漂移 | bootstrap 固定上游 commit；每次升级重新移植并跑 Runtime/Renderer/Layout/Web 测试 | 保留上一版 bootstrap，不自动升级 |
| bootstrap 与官方 profile 混用 | launcher 强制独立 `DSH_HOME`，首版不自动迁移 | 删除 bootstrap launcher，官方数据不受影响 |
| 用户误以为 base plugin 支持分屏 | 安装结果和设置页明确展示能力状态 | 隐藏 Split Pane 入口，保留通用功能 |
| 多平台产物不一致 | 每个平台独立 E2E 与 SHA256；未验证不宣称支持 | 只发布通过的平台，其他平台保留 source preview |
| Agent 沙箱不能写用户目录 | 预检写权限并确定性降级 | 只输出一条终端命令，不扩大权限 |
| Better Sidebar 兼容影响主流程 | 保持 optional，独立探测能力 | 不安装 panel compat，不影响 Workbench 主功能 |

## 9. 完成定义

本轮优化只有在以下条件全部满足时完成：

1. stock Harness 用户可以快速安装通用 Workbench，不出现 Split Pane 运行错误；
2. 需要分屏的用户可以并行安装自装补丁路径（bootstrap），官方 Harness 未被覆盖或修改；
3. bootstrap 构建的 fork 独立 DSH_HOME 启动后，两个真实 Session Pane 的会话、草稿、滚动、右侧面板和底部面板保持独立；
4. Agent 默认安装不再要求 40 位 commit 或运行全仓测试；
5. read-only home 路径只产生一条最终命令；
6. 安装器准确报告 installed/manual-action-required/incompatible/failed；
7. 已声明支持的平台完成冷环境安装、升级、卸载和官方 Harness 不受影响验证；
8. 一名未参与开发的真实用户在目标耗时内完成对应安装旅程；
9. §3.6 社区承诺 C1–C5 全部兑现或有明确记录的关闭理由。

## 10. 下一 Ready

完整 Plan 获维护者实施确认后，先完成 §6 的 Phase 0 余项，再从 P01 开始。P02 与 P03′ 在 P01 通过后可独立推进；W1 与社区承诺 C1–C4 不依赖 P 序列，可随时启动。当前仍保持不 commit、不 push、不发布（上游 Discussions 协作除外，已获维护者逐项授权）。

## 修订日志

- 2026-08-27 v2：Edition 原案取消（P04），P03 改为 source bootstrap；新增 §3.5 上游协作轨道、§3.6 社区承诺清单、工作流 W（快捷键开放动作目录）；§3.4 解除“不向官方提 PR”永久禁令，改为 Discussions 协作；§6 重写为 bootstrap 主路径 + 上游 tripwire + Phase 0 余项。
- 2026-08-27 v2.1：任务整合——新建 `plans/260827-workbench-v2/tasks.md` 作为唯一执行清单（P 序列并入主线 A，社区承诺并入主线 B，快捷键设计拆为主线 C 的 W1–W4 任务与 V1–V3 验证门）；新增安装终态话术规范（stock 安装收尾必须披露分屏未激活原因并给出唯一 bootstrap 命令）。
