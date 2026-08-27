# Workbench 优化迭代 v2 — 完整任务清单 / Consolidated task list

> 内部执行清单，2026-08-27。v2 任务的**唯一执行依据**；战略与决策理由见 [`../260827-real-user-install-review/task_plan.md`](../260827-real-user-install-review/task_plan.md)，快捷键设计细节见 [`../260827-shortcuts-open-actions/design.md`](../260827-shortcuts-open-actions/design.md)。任务内容如与那两份文档冲突，以本清单为准并回写修订。
> 当前授权状态：实施期间**允许本地 commit（含 plans/ 文档入库），不 push**；push / tag / Release / npm 仍逐次单独授权（上游 Discussions 沟通已单独授权，见主线 B）。
> 关键决策已定（2026-08-27，见 §8 决策记录）：rc.2 = 主线 A + W1；bootstrap 脚本以 Release 附件分发；平台覆盖 Windows + macOS。

---

## English summary

The single execution checklist for Workbench iteration v2, consolidating three tracks: **Track A — install & distribution** (result contract, stock generic mode, source-bootstrap installer replacing the cancelled Edition, Release-first docs, platform E2E, rc.2 release), **Track B — upstream & community** (the five outstanding commitments from discussion #4718 plus two open design decisions), and **Track C — shortcuts open action catalog** (W1 registry dynamization → V1–V3 verification gates → W2 host command bridge → W3 public API → W4 pinned adapter). A normative **post-install disclosure script** is defined in §1: after a stock-Harness install, the agent must tell the user that split pane is inactive because official Harness lacks the multi-pane interface, that everything else works, and offer exactly one copy-paste bootstrap command that builds a patched parallel copy in an isolated directory without touching the official install. Phase 0 cheap verifications precede Track A. All tasks await maintainer authorization; no commit/push/release.

---

## 1. 话术规范：安装终态披露（normative）

**适用场景**：Agent 在 stock Harness 上完成通用插件安装后的收尾输出；read-only home 降级路径同样以此话术 + 唯一命令收尾（对齐 task_plan §4.2 状态机）。

**命令省略 `--tgz`**：两条模板均不传 `--tgz`——按 A3 §8 修订后的行为，bootstrap 脚本在未收到 `--tgz` 时会自行从内置的 `RELEASE_BASE_URL`/`$ReleaseBaseUrl` 下载对应版本的 Workbench TGZ 到 `<target>/downloads/` 并校验 SHA256，`--tgz <path>` 仅作为离线覆盖选项保留（详见脚本自身头部注释）。

**§1 采用两份各自独立、各含唯一一条命令的完整话术样本**（而非一份夹带两条命令的合并样本），确保任何下游复制都不会一次抓到两条命令、也让每份样本能单独通过 `validateDisclosure` 校验（N2）：

**Windows 样本**（PowerShell 7+ / `pwsh`；zh；en 版本随 P05 一并产出，两版进产品字典）：

````text
✅ DSH Workbench 已安装完成。Navigator、快捷键等通用功能现在就可以使用。

ℹ️ 分屏（双 Pane）功能当前未激活：你的官方 Harness 还不支持多 Pane 所需的
接口（该接口已作为提案提交官方，进展见
https://github.com/deepseek-ai/deepseek-harness/discussions/4718）。
这不是安装出错，其余功能不受影响。

如果你现在就想用分屏，可以运行下面这一条命令。它会在独立目录里构建一份带补丁的
Harness 副本，与你的官方版并存——不会改动官方安装、配置或任何会话数据；不想要时
删除该目录即可，官方 Harness 不受任何影响：

Windows（需要 PowerShell 7+，即 `pwsh`）：

```
& { $ErrorActionPreference = 'Stop'; $rel = 'https://github.com/wanyexin1998/dsh-workbench/releases/download/v0.2.0-rc.2'; Invoke-WebRequest "$rel/dsh-workbench-bootstrap.ps1" -OutFile dsh-workbench-bootstrap.ps1; Invoke-WebRequest "$rel/SHA256SUMS" -OutFile SHA256SUMS; $expectedLine = (Select-String -Path SHA256SUMS -Pattern 'dsh-workbench-bootstrap\.ps1$').Line; if (-not $expectedLine) { throw 'SHA256SUMS 中未找到 dsh-workbench-bootstrap.ps1 的记录，已中止' }; $expected = ($expectedLine -split '\s+')[0].ToLower(); if ($expected -notmatch '^[0-9a-f]{64}$') { throw "SHA256SUMS 中的哈希格式不合法：$expected" }; $actual = (Get-FileHash dsh-workbench-bootstrap.ps1 -Algorithm SHA256).Hash.ToLower(); if ($actual -ne $expected) { throw "SHA256 校验失败：期望 $expected，实际 $actual" }; pwsh -NoProfile -ExecutionPolicy Bypass -File .\dsh-workbench-bootstrap.ps1 }
```
````

**macOS 样本**（Terminal / bash；zh；en 版本随 P05 一并产出，两版进产品字典）：

````text
✅ DSH Workbench 已安装完成。Navigator、快捷键等通用功能现在就可以使用。

ℹ️ 分屏（双 Pane）功能当前未激活：你的官方 Harness 还不支持多 Pane 所需的
接口（该接口已作为提案提交官方，进展见
https://github.com/deepseek-ai/deepseek-harness/discussions/4718）。
这不是安装出错，其余功能不受影响。

如果你现在就想用分屏，可以运行下面这一条命令。它会在独立目录里构建一份带补丁的
Harness 副本，与你的官方版并存——不会改动官方安装、配置或任何会话数据；不想要时
删除该目录即可，官方 Harness 不受任何影响：

macOS（Terminal）：

```
rel='https://github.com/wanyexin1998/dsh-workbench/releases/download/v0.2.0-rc.2'; if curl -fsSLO "$rel/dsh-workbench-bootstrap.sh" && curl -fsSLO "$rel/SHA256SUMS"; then expected=$(grep 'dsh-workbench-bootstrap\.sh$' SHA256SUMS | awk '{print $1}'); actual=$(shasum -a 256 dsh-workbench-bootstrap.sh | awk '{print $1}'); if [ -n "$expected" ] && printf '%s' "$expected" | grep -qE '^[0-9a-f]{64}$' && [ "$actual" = "$expected" ]; then chmod +x dsh-workbench-bootstrap.sh && ./dsh-workbench-bootstrap.sh; else echo 'SHA256 校验失败，已中止，不会执行未校验脚本' >&2; false; fi; else echo '下载失败，已中止，不会执行未校验脚本' >&2; false; fi
```
````

注：以上两条命令均省略 `--target`，使用脚本内置默认目录（Windows:
`%USERPROFILE%\dsh-workbench`；macOS: `$HOME/dsh-workbench`）。`SHA256SUMS`
中的具体哈希值要到 A6 正式发布 `v0.2.0-rc.2` Release 时才会写入真实内容；
在此之前，命令模板本身已经确定，但其中的下载/校验步骤无法针对真实文件
执行（Release 尚未发布）。macOS 命令把"下载失败"与"校验失败"拆成两条独立
分支，各自给出诚实的错误文案，并且只有 `if`/`then` 分支里显式执行的
`./dsh-workbench-bootstrap.sh` 才会把 bootstrap 自身的退出码原样传出——不会
出现"任何非零退出码都打印'校验失败'"的误报（B2/B3）；Windows 命令用
`$ErrorActionPreference = 'Stop'` 保证下载失败时整条命令中止，`$expected`
在比较前先校验为 64 位小写十六进制，最终调用改为
`pwsh -NoProfile -ExecutionPolicy Bypass -File .\dsh-workbench-bootstrap.ps1`
（此时哈希已校验通过，`-ExecutionPolicy Bypass` 仅对这一次调用生效，不改
全局策略）（S8）。两条命令都不会杀掉用户的交互终端：macOS 失败分支用
`false` 而非 `exit`（`if`/`fi` 已保证不执行未校验脚本，`false` 只设置退出
码）；Windows 命令整体包在 `& { … }` 里使 `$ErrorActionPreference` 只在本次
调用内生效，且刻意不在末尾追加 `exit`——bootstrap 的结果码在命令结束后仍
可通过 `$LASTEXITCODE` 读取，脚本化调用方读它即可。

**五要素硬性要求**（验收时逐项检查；对上面两份样本逐份检查，而不是合并检查）：

1. 明示分屏**未激活**及原因（官方接口缺失），并说明这不是安装失败；
2. 明示其余功能**现在可用**；
3. 明示 bootstrap 与官方版**并存、零改动官方安装/配置/会话**（不得使用"对 Harness 做改动"等易误解为改官方安装的表述）;
4. 明示**可整体删除、无残留影响**；
5. 命令**唯一且可直接复制**——"唯一"指按用户所在平台只展示对应的那一份完整
   样本（Windows 用上面的 PowerShell 样本，macOS 用上面的 Terminal 样本，
   二者互斥、不同时展示给同一用户，且每份样本自身只含一条命令）；两份样本
   均已由 A3 产出并回填于本节，此前不得对用户展示占位符。

**命令形态**（按 §8 决策）：命令 = 下载 rc.2 Release 附件中的 bootstrap 脚本 → 校验 SHA256（对照 `SHA256SUMS`）→ 运行；TGZ 的下载与校验由 bootstrap 脚本自身负责（见上）。Windows（`.ps1`）与 macOS（`.sh`）各一版，话术按用户平台只展示对应的那一份完整样本。

---

## 2. Phase 0 — 低成本验证（先于主线 A 执行）

| 任务 | 内容 | 验收 | 量级 | 状态 |
| --- | --- | --- | --- | --- |
| T0.1 双窗口实验 | 同一 profile 开两个浏览器窗口各停不同 Session，验证 host 是否允许并发 client、current 是否独立 | 得出成立/不成立结论并记录；若成立，作为"第 0 层双 Pane"写入 A4 文档 | S | 未开始 |
| T0.2 JTBD 确认 | 确认 pane B 用途（只读观察 vs 双向交互），确定保真度 bar | 结论写入 task_plan §2 附注；影响 W2 与提案验收表述 | S | **已裁决**（2026-08-27 维护者即产品所有者拍板：两个 Pane 均须支持全部双向操作，全保真为硬需求；只读/降级形态出局，无需用户访谈） |
| T0.3 安装机制验证 | 验证 `dsh plugin add` 是否接受 npm spec（还是仅 file:TGZ） | 结论写入 A4 文档的安装命令形态 | S | **已完成**（reports/T0.3：透传 pnpm add，Release-first 保持 file:TGZ；已进 A4 文档） |
| T0.4 guard 结构探测加固 | 即社区承诺 B4/C4：`runStartupGuard` 由 `protocol===2` 数字比对改为结构探测（`requestCapacity` 函数 + `state.getSnapshot` 形状），不符 fail closed；补三类测试 | 包级测试全绿；`detected` 文案可诊断 | S | **已完成**（commit 7c9bd5a，Opus 变异测试 5/5 击杀） |

已完成并归档（不再列为任务）：fork diff 实测（3 commits，+1671/−171，生产约 500–600 行）、上游侦察（官方不收外部 PR/issue，Discussions 为官方反馈渠道）——记录见 task_plan §3.5。

## 3. 主线 A — 安装与分发（原 P 序列）

| 任务 | 对应 | 目标 | 验收要点 | 量级 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| A1 安装结果契约与回放基线 | P01 | 四终态（installed / manual-action-required / incompatible / failed）+ 匿名化回放 fixture + 短路规则 | 回放旧流程显示"未安装"；不兼容不进入 clone/build；**stock 安装终态输出符合 §1 话术五要素**；敏感内容扫描为零 | M | 无 |
| A2 stock 通用模式 | P02 | Navigator、快捷键与兼容提示在 stock 上无错加载；Split Pane 严格隔离 | stock 加载零报错；Split Pane 不请求容量不挂载；compatible 行为不回退 | M | A1 |
| A3 Source bootstrap 安装脚本 | P03′ | 把 INSTALL §1–3 自动化为可审计脚本（`.ps1` + `.sh` 双版）+ 独立 `DSH_HOME` launcher；脚本作为不可变 Release 附件分发，哈希收入 `SHA256SUMS` | 官方安装零写入；一条命令完成；输出四终态之一；脚本对 release-contract 逐项 hash/commit 校验；**产出 §1 的 `<BOOTSTRAP_COMMAND>` 并回填** | M | A1 |
| A4 统一 Quick Install 双语文档 | P05 | Release-first 默认路径（下载不可变 TGZ + `dsh plugin add`），40 位 commit 流程移入高级附录；描述 stock 通用与 bootstrap 分屏两条路径 | 默认路径无 commit 问答；中英事实一致；**§1 话术双语进字典**；含 T0.1/T0.3 结论 | S–M | A2、A3 |
| A5 平台隔离 E2E | P06 | **Windows + macOS** 验证：stock 插件安装、read-only home 降级、bootstrap 端到端（macOS 复用真实用户渠道）；Linux 保持"未验证"，不宣称支持 | 每平台冷环境；未跑平台保持"未验证" | M | A4 |
| A6 `v0.2.0-rc.2` 手工 Release 与复测 | P07 | 不可变 Release + 真实用户复测（无 Edition 产物）；**交付范围含 W1（快捷键目录动态化）** | `pnpm release:check` 通过（含 W1 新增测试）；SHA256 可复算（含双版 bootstrap 脚本附件）；复测达到 task_plan §4.3 时限；话术按 §1 落地 | S–M | A5、W1.3 |

注（N5）：A6 发布前需完成一次**人工端到端 bootstrap 全流程运行**（真实网络下载
TGZ、真实 clone/build/install/launcher）——目前 `pnpm exec dsh` 在 fork 根目录内
的解析路径只在离线（`--check-only`/单元测试）场景下验证过，未经端到端实测。

**主线 A 状态（2026-08-27 sprint 收尾）**：A1（0390aa9）、A2（87153cb）、A3
（c6da80f + 401b4ad 发布门接入 + 3be5028 LF 保护）、A4（06b626e）均已完成并
通过 Opus 双轮验收；A5 需真实平台冷环境与 macOS 用户渠道、A6 需发布授权，
均为维护者动作，未启动。A6 已知债务：release-contract `workbenchVersion`
rc.1→rc.2 与脚本内 `WORKBENCH_TGZ_SHA256` 盖章、§1 命令英文变体、bootstrap
人工 E2E（本注）。

## 4. 主线 B — 上游协作与社区承诺（对应 task_plan §3.5/§3.6）

| 任务 | 内容 | 触发条件 | 量级 | 状态 |
| --- | --- | --- | --- | --- |
| B1 提案正文条文化 | 渲染按 id 绑定升为协议条款、`visible` 禁重复 id、close 永不归档 + 右邻后左邻、外部移除独立 reconciliation 事件、`open()` 类型化返回 | 等 denial123789 回复优先级后一并编辑 #4718 正文 | S | 等待回复 |
| B2 fork 异步身份捕获审计 | send/paste/upload/model-selection/question/approval 各路径是否在发起时绑定 pane session id；结论写入契约 + 验收用例 | 无前置，可随时做 | M | **审计已完成**（reports/B2：SAFE 6 / UNSAFE 1——拖拽上传监听挂 document、分屏下一次拖放进所有 Pane；fork 侧修复与回馈社区待维护者决策） |
| B3 跑 22 个验收用例 | SandBase handbook 用例对照 fork e2e，如实汇报通过/未通过 | 无前置 | M | 未开始 |
| B4 guard 加固 | = T0.4，双重登记以防遗漏 | 无前置 | S | **已完成**（=T0.4，commit 7c9bd5a） |
| B5 版本号让渡 | 提案编号改为 upstream-owned（从 1 起或 capability/version 对）；未知版本 fail closed 到容量 1 | 等上游表态 | S | 等待上游 |
| B6 开放决策跟踪 | 容量收缩语义（explicit-reconciliation vs admission-only）、session 级插槽 opt-in 信号形态 | 社区/上游拍板后落实到 fork 与提案 | — | 跟踪中 |

**上游 tripwire**（不变，见 task_plan §3.5）：接纳 → 删 bootstrap 桥；明确拒绝 → 触发条件化 Edition 重估；沉默 → bootstrap 按终态定价持续。跟进邮件仅在 #4718 无官方回应 2–3 周后发送（草稿已备）。

## 5. 主线 C — 快捷键开放动作目录（design.md 的任务化）

### W1 目录动态化（纯 Workbench，无外部依赖；**属于 rc.2 交付范围**）——**已全部完成**（W1.1 e551277 / W1.2 ac2ce91 / W1.3 4949c4f，均经 Opus 双轮验收 + 变异验证；包测试 234 项全绿）

| 任务 | 内容 | 验收 | 量级 |
| --- | --- | --- | --- |
| W1.1 ActionRegistry 改造 | `register()` 返回 disposer；支持动态注销与重绑；增加 provider 元数据与 `isEnabled` | 单元测试覆盖注册/注销/重绑/冲突保持 | S–M |
| W1.2 持久化命名空间化 | 动作 id 加前缀（`workbench.*` 等）；旧 id 沿 `LEGACY_SHORTCUT_NAMESPACE` 机制再迁移一轮 | 迁移测试：旧绑定无损迁移，新旧并存期读取正确 | S |
| W1.3 设置页开放化 | 按 provider 折叠分组、缺席态灰显（绑定保留）、搜索框 | 组件测试：分组渲染、缺席态、搜索过滤、冲突/保留键提示不回退 | M |

### 验证门（W2 前置，对本地 rc.2 实证，不确认不开工）——**三门全部 PASS**（reports/V1-V3-command-bridge-gates.md：`ctx.remote.commands` 公开可达、focused Agent 句柄有公开路径、日志语义已确认；W2 可在 rc.2 后开工，四个非阻塞运行时余项见报告）

| 门 | 内容 | 产出 |
| --- | --- | --- |
| V1 | client 侧经 api-remotes/typert 可达 `commands`（list / execute / 变更订阅） | 可行性结论 + 最小 PoC 代码片段 |
| V2 | client 侧获取 focused pane 对应 `Agent` 句柄的公开路径 | 同上 |
| V3 | 快捷键触发 `execute` 的会话日志语义（`command/run` 落日志的可见后果） | "直接执行"选项的默认文案与提示设计 |

### W2 Host 命令桥（V1–V3 全过后）——**代码面已完成**（2026-08-28，分支 feat/w2-host-command-bridge：枚举/订阅/冷启动补齐、双映射执行、按键捕获会话 id、opt-in 持久化；287 项包测试全绿，Opus 双轮验收 + 审查者独立重探。**合并门**：维护者真实客户端冒烟——设置页出现"DeepSeek Harness 命令"分组、绑键可把 `/命令 ` 填入聚焦输入框；该冒烟同时覆盖 presentation.state.subscribe 在真实 RC 上存在与否的静默降级检查）

| 任务 | 内容 | 验收 | 量级 |
| --- | --- | --- | --- |
| W2.1 枚举与订阅 | `list(agent)` → 动作目录注入（`host.command.*`）；注册表变更实时跟随 | 插件装卸时设置页动态增减；shadowing 按 focused agent 解析 | M |
| W2.2 双映射执行 | 默认"插入 composer"（`/name ` 填入聚焦输入框）；per-action opt-in "直接执行"；无 input / 有 input 分流 | 有 input 命令永不直接执行；直接执行前提示会话留痕（按 V3 文案） | M |
| W2.3 桥测试 | 枚举、分流、focused 路由（发起时捕获 session id）、缺席降级 | 包级测试全绿 | S–M |

### W3 公开注册 API——**已完成**（2026-08-28，分支 feat/w3-open-actions：`workbenchActions` cordis 服务（actions protocol 1）+ docs/ACTIONS_API.md + 示例；351 项包测试全绿，Opus 双轮验收——label 中毒的调度器杀伤路径、命名空间冒充矩阵（含同形字符）、监听器隔离均被独立复探证实关闭）

| 任务 | 内容 | 验收 | 量级 |
| --- | --- | --- | --- |
| W3.1 `workbench.actions` 服务 | actions protocol 1：`{id, label(), run(), isEnabled?()}`，版本化、fail closed | 契约测试 + 与 W1 目录集成 | M |
| W3.2 文档与示例 | 第三方插件接入文档（双语）+ 最小示例插件 | 示例插件注册的动作出现在设置页并可绑定 | S |

### W4 首个 pinned 适配器——**已再定界**（2026-08-28）

可行性调研（reports/W4-better-sidebar-feasibility.md）：pinned fork 无公开开关动词
（`panes` capability 只有 `mountPane`，真正的 `togglePanel` 是私有 reducer），也未注
册任何斜杠命令。原定的 Workbench 侧 DOM/capability 适配器不可行（禁 DOM 推断）。
再定界（orchestrator 决定，待维护者追认）：**W4 = 给 Better Sidebar fork 的 client
半侧打补丁**——可选注入 W3 的 `workbench.actions` 服务（Workbench 不在场时静默
降级），注册 `better-sidebar.*` 开关动作直调自己的 store reducer。弃用调研报告推荐
的斜杠命令路线：命令 handler 在 host 侧执行而面板状态在 client 侧，需额外
host→client 通道；W3 路线零边界问题且让 W4 成为 W3 API 的第一个真实消费者。
依赖：W3 交付并过审后启动；工作落在 fork 仓库（本地 commit、push 单独授权）。

| 任务 | 内容 | 验收 | 量级 |
| --- | --- | --- | --- |
| W4.1 Better Sidebar 适配器 | 面板开关动作；`release-contract.json` 登记精确版本，不符 fail closed | 版本不符时零注入；无任何 DOM 推断 | S–M |

## 6. 依赖图

```text
Phase 0: T0.1  T0.2  T0.3  T0.4(=B4)   （并行，先行）

主线 A:  A1 ─┬─> A2 ──┐
             └─> A3 ──┼─> A4 -> A5 ─┐
主线 C:  W1.1 -> W1.2 -> W1.3 ──────┴─> A6 (rc.2 = A线 + W1)
         V1,V2,V3 ──> W2.1 -> W2.2 -> W2.3      （rc.2 之后）
         W1 ──> W3.1 -> W3.2                     （rc.2 之后）
         W1 ──> W4.1                             （rc.2 之后）
主线 B:  B1(等回复)  B2  B3  B5(等上游)  B6(跟踪)   （独立于 A/C，B2/B3 可随时做）
```

关键交叉点：§1 话术在 A1 定验收、A3 产命令、A4 进文档、A6 复测落地；T0.2 的 JTBD 结论可能调整 B1 的提案表述与 W2 的优先级。

## 7. 授权与跟踪约定

- **本地 commit 已授权**（实施期间按任务正常 commit，plans/ 文档一并入库）；push / tag / Release / npm / GitHub 配置修改仍逐次单独授权（沿用 task_plan §7 授权门）。
- 上游 Discussions 的发帖、回帖、正文编辑按已建立模式逐次由维护者确认后执行。
- 每完成一个任务，回写本清单"状态"列；涉及决策变化的，同步修订 task_plan 与 design.md 并在各自修订日志留痕。

## 8. 决策记录（2026-08-27，维护者逐项确认）

| 决策 | 结论 | 影响 |
| --- | --- | --- |
| rc.2 交付范围 | 主线 A + W1 一起进 | A6 依赖加 W1.3；W2 及之后移出 rc.2 |
| bootstrap 脚本分发 | 不可变 Release 附件，哈希进 SHA256SUMS | A3 形态与 §1 命令形态确定；不做仓库内脚本或远程一行执行 |
| git 授权 | 本地 commit 允许（含 plans/），不 push | §7 更新；push/tag/Release 仍逐次授权 |
| 平台覆盖 | Windows + macOS（`.ps1` + `.sh` 双版），Linux 保持未验证 | A3 双脚本；A5 两平台矩阵；macOS 复测走真实用户渠道 |

## 9. Sprint 收尾记录（2026-08-27，feat/workbench-v2）

- **已完成并 commit**：T0.3、T0.4/B4、A1–A4、W1.1–W1.3、V1–V3、B2 审计、
  发布门接入 bootstrap 套件、`.sh` LF 保护——共 11 个 commit，每个开发交付
  均经 Sonnet 实现 + Opus 双轮验收（含变异测试/tripwire 证据）。
- **待维护者动作**：T0.1 双窗口实验（需真实环境；T0.2 已由维护者拍板关闭）；
  A5 平台 E2E（Windows 冷环境 + macOS 用户渠道）；A6 发布（需授权：版本盖章
  rc.1→rc.2、TGZ 哈希盖章、人工 bootstrap E2E、§1 英文命令变体、Release 上传）。
- **等外部**：B1（denial123789 回复）、B5/B6（上游表态）；B3（可选，需构建 fork）。
- **B2 审计结论待决策**：fork 拖拽上传 UNSAFE 修复是否落 fork 分支、是否回馈
  社区（走逐次授权）。
