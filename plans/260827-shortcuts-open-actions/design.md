# Shortcuts Open Action Catalog — design / 快捷键开放动作目录设计

> Internal design note, 2026-08-27. Status: proposed, not yet authorized for implementation.
> 内部设计文档，2026-08-27。状态：方案提出，未获实施授权。

---

## English summary

**Goal.** Let the shortcuts settings page discover the capabilities actually present in the user's Harness install (core features and third-party plugins), list them, and let the user bind chords to them — instead of today's fixed list of five Workbench actions.

**First principles.** A shortcut system decomposes into: catalog (what can be invoked) → binding (chord → action id) → dispatch (key event → invoke) → persistence → settings UI. Workbench already has everything except an *open* catalog. Three principles govern the design:

1. **The unit of binding is an action, not a plugin.** Discovery must yield invokables with a stable namespaced id, a localized label, and a public-API execution path.
2. **Actions are declared, never scraped.** No DOM crawling, no synthesized clicks, no private-store probing — that violates this repo's boundaries and breaks on every host update. Prior art is VS Code: its keybindings UI enumerates the command registry that extensions must declare into.
3. **Bindings belong to the user, not to a plugin's lifetime.** Bindings persist keyed by action id; an absent provider grays the row out and dispatch no-ops with a hint.

**Discovery layers (all fail-closed).**
- **L0 — Workbench's own actions** (exists today).
- **L1 — Host slash-command bridge.** Verified: `@deepseek-ai/dsh-commands` ships a host-side `CommandRuntime` with `list(agent)` (name-sorted descriptors: name + description), `execute(agent, line, …)` that runs a command *without* sending it to the model, registry change notification, and a remote-client typert face. Mapping: input-less commands become directly executable actions targeting the **focused** pane's agent; commands declaring `input` become "insert `/name ` into the focused composer" actions (never guess arguments). Note: `execute` appends `command/run` / `command/done` to the session log — so v1 defaults every host command to composer-insert, with per-action opt-in for direct execute.
- **L2 — Public registration API** (`workbench.actions`, actions protocol 1): third-party client plugins explicitly register `{id, label(), run(), isEnabled?()}`. The long-term correct shape.
- **L3 — Pinned versioned adapters** for popular plugins that declare nothing (first candidate: Better Sidebar panel toggle), governed exactly like panel-compat: exact-version pin in `release-contract.json`, fail closed otherwise.

**Delivery.** W1 registry dynamization + grouped/searchable settings UI (no external deps) → W2 host command bridge (behind verification gates V1–V3) → W3 public API + docs → W4 first pinned adapter. Verification gates: V1 client-side remote face for `commands` (list/execute/subscribe), V2 obtaining the focused pane's agent handle client-side, V3 session-log semantics of shortcut-triggered execution.

---

## 中文完整版

### 1. 需求还原与第一性分解

原始想法："快捷键页面探查用户 Harness 现有哪些功能/插件，把它们呈现在设置页里，让用户自定义快捷键。"

把"快捷键系统"拆到底，它由五个部件组成：

```
目录 catalog（有什么可调用） → 绑定 binding（chord → action id）
→ 派发 dispatch（按键事件 → 调用） → 持久化 persistence → 设置页 UI
```

Workbench 今天已经有后四件（`chord.ts` 解析、`ActionRegistry` 冲突解析、`shortcut-persistence` 迁移与持久化、浏览器保留键检测、设置页表格），唯独**目录是写死的**：[shortcuts.tsx:140](../../packages/dsh-workbench/src/native-ux/client/shortcuts.tsx) 里硬编码了 5 个动作 + 会话切换。所以这个需求的本质不是"做一个新功能"，而是**把目录从静态改为开放，并给它接上发现源**。

### 2. 三条设计原则（决定了什么不能做）

**原则一：绑定的单位是"动作"，不是"插件"。**
"探查插件"本身没有意义——插件是容器，快捷键无法绑定到容器上。发现必须产出**可调用的动作**：稳定的命名空间 id + 本地化标签 + 只走公开 API 的执行路径。设置页按 provider（来源插件）分组展示动作，但绑定对象永远是动作。

**原则二：动作必须被声明，不能被抓取。**
"复现功能"不是重新实现功能，而是把已声明的可调用项**呈现**出来、按键时**调用**它。明确排除：DOM 爬取可点击元素、模拟点击、探测未版本化的私有 store——三者都违反本仓库既有边界（AGENTS.md：不修补私有 DOM/store；panel-compat 先例：只认显式版本化 capability），且每次 host 更新都会碎。业界先例是 VS Code：快捷键页能列出所有扩展命令，是因为**扩展必须向命令注册表声明**，而不是 VS Code 去扫描界面。

**原则三：绑定属于用户，不属于插件的生命周期。**
用户配好的快捷键在插件卸载/禁用后不应消失。持久化按动作 id 存储；provider 缺席时设置页灰显该行并标注"未加载"，派发时静默跳过（可给一次性提示）。插件回来，绑定自动恢复。

### 3. 四层发现源（全部 fail-closed）

| 层 | 来源 | 状态 |
|---|---|---|
| L0 | Workbench 自身动作（Navigator、聚焦输入框、侧栏、停止会话、关 Pane、会话切换） | 已存在 |
| L1 | **Host 斜杠命令桥** | 已证实 host 端注册表存在，client 端可达性待验证（V1） |
| L2 | `workbench.actions` 公开注册 API（actions protocol 1） | 新建 |
| L3 | 显式版本锁定适配器（复用 panel-compat 治理） | 新建 |

**L1 是本设计的核心增量**，依据是本地 `@deepseek-ai/dsh-commands@0.1.1-rc.2` 的类型声明（lib/types/index.d.ts）：

- `CommandRuntime.list(agent)` — 返回按名称排序的 `CommandDescriptor[]`（name + description，含 agent 级 shadowing 解析）；
- `CommandRuntime.execute(agent, line, images, signal)` — **不经模型**直接执行已注册命令；
- 有注册表变更通知（`notifyChange`），设置页可以实时跟随插件装卸；
- 包内有 `typert.remote-client.d.ts`，说明该服务设计上可被 client 远程访问。

**映射规则**：

1. 未声明 `input` 的命令 → 生成"直接执行"型动作，id 为 `host.command.<name>`，目标 agent = **focused pane 的 agent**（与 presentation 语义一致：focused 只管交互路由；按键即"发起时刻"，此刻捕获 session id，符合社区评审确认的 async-identity 规则）；
2. 声明了 `input` 的命令 → 只生成"插入 composer"型动作：把 `/name ` 填入聚焦 pane 的输入框，让用户补参数后自己回车。**绝不猜测参数**；
3. **一个关键安全细节**：`execute` 会向会话日志追加 `command/run` / `command/done` 事件——也就是说快捷键直接执行命令会在会话记录里留痕。为避免用户被"按了个键、会话日志多了条记录"惊到，**v1 把所有 host 命令默认映射为"插入 composer"**（可见、用户按回车确认才执行），"直接执行"作为每个动作可单独开启的选项。

**L2** 是长期正解（对齐 VS Code 模式）：其他 client 插件通过版本化的 `workbench.actions` 服务显式注册 `{id, label(), run(), isEnabled?()}`，Workbench 提供文档和示例。生态没跟上之前它是空的——没关系，L1 已经能覆盖所有注册了斜杠命令的插件。

**L3** 兜底覆盖既不注册命令、又不接 L2 的热门插件（首个候选：Better Sidebar 的面板开关）。治理方式与 panel-compat 完全一致：只认 `release-contract.json` 里锁定的精确版本，版本不符 fail closed，不做任何 DOM 推断。

### 4. 设置页 UX

- **按 provider 分组**：Workbench / DeepSeek Harness 命令 / 各插件名，组可折叠；组名与动作标签走现有双语字典机制（host 命令用其自带 description 原文）。
- **每行**：标签、当前 chord、冲突徽章、浏览器保留键提示——全部复用现有 `bindingReport` 机制。
- **搜索框**：目录开放后动作数量会从个位数涨到几十个，无搜索不可用（VS Code 同款教训）。
- **缺席态**：provider 未加载 → 灰显 + 徽章，绑定保留（原则三）。
- **冲突策略维持现状**：冲突 chord 解析为 null（谁都不执行），设置页显式亮出——现有 `ActionRegistry.conflicts()` 已支持。

### 5. 数据与兼容

- 持久化沿用现有 settingsScope 命名空间与 `actionId -> chordSpec` 结构；新动作 id 一律带命名空间前缀（`workbench.*` / `host.command.*` / `<plugin>.*`）；旧 id 迁移沿用 `LEGACY_SHORTCUT_NAMESPACE` 机制再走一轮。
- `ActionRegistry` 改造：当前 `register()` 无法撤销——需要返回 disposer、支持动态注销与重绑（L1 的命令随插件装卸动态出入）；增加 provider 元数据与 `isEnabled`。
- 安全边界：不新增任何 Host 权限；所有执行路径等价于用户手动操作（斜杠命令等价于在 composer 手敲）。

### 6. 分期与验证门

| 阶段 | 内容 | 依赖 |
|---|---|---|
| W1 | 注册表动态化 + provider 分组 + 缺席态 + 搜索 + id 命名空间化迁移 | 无（纯 Workbench） |
| W2 | Host 命令桥：枚举、变更订阅、插入/执行双映射 | V1–V3 全过 |
| W3 | `workbench.actions` 公开 API + 文档 + 示例插件 | W1 |
| W4 | 首个 pinned 适配器（Better Sidebar），release-contract 登记 | W1、L3 治理评审 |

**验证门（W2 前置，全部对着本地 rc.2 实证，不确认不开工）：**

- **V1**：client 侧能否经 api-remotes/typert 拿到 `commands` 的 list/execute/变更订阅（包里有 remote-client 声明，方向乐观，需实证）；
- **V2**：client 侧如何拿到 focused pane 对应的 `Agent` 句柄（`list`/`execute` 都要它）；
- **V3**：快捷键触发 `execute` 的会话日志语义确认（`command/run` 落日志的可见后果），决定"直接执行"选项的默认文案与提示。

### 7. 明确不做（anti-goals）

- 不做 DOM 爬取/模拟点击/私有 store 探测（原则二）；
- 不"重新实现"任何插件功能——只调用已声明的可调用项；
- 不自动给发现的动作分配默认快捷键（只有用户显式绑定；避免污染键位空间与制造冲突）；
- v1 不做每动作 `when` 上下文表达式（只有全局作用域 + isEnabled；上下文路由交给 focused 语义）。
