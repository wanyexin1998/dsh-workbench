> **Draft — pending maintainer review.** Nothing here has been posted. Copy/paste into GitHub Discussions yourself when ready.
> **草稿 — 待维护者本人审阅后手动发布。** 本文件未被自动发送到任何地方，需要你自己复制粘贴到 GitHub Discussions。

---

## Suggested category: Ideas

## Title

`Session Presentation protocol v2: an additive API for showing more than one Session at once (client-side, backward compatible)`

---

## Post body (English)

### Motivation

Right now the render layer treats "the current Session" as a single slot: one Session is mounted, everything else is torn down or hidden when you switch. That's the right default for most usage, but it also means a whole category of workflows — comparing two conversations side by side, keeping a reference session open while working in another — can't be built as a plugin on stock DeepSeek Harness Web. The gap isn't a missing setting; it's that the pieces a plugin would need (a second mount point, a way to say "these two Sessions are both visible," the `Conversation` internals) aren't exposed on the client surface today. Any plugin trying to do this ends up forking internals rather than composing with the public API.

I've been running a fork with a small additive API that closes this gap, and wanted to bring the design here before going further with it, given external PRs are closed right now.

### Proposed API sketch

A new face on `SessionRuntime`, versioned so it can evolve independently of everything else:

```ts
interface SessionsPresentation {
  readonly protocol: 2;

  // observable state
  readonly state: Readable<{
    visible: SessionId[];
    focused?: SessionId;
    capacity: number;
  }>;

  // actions
  open(id: SessionId): void;
  focus(id: SessionId): void;
  close(id: SessionId): void;

  // effect-lifetime capacity request, max-wins arbitration
  requestCapacity(n: number): () => void;
}

// surfaced as: sessionRuntime.sessions.presentation
```

### Behavior contract

- `visible` owns pane membership — left-to-right order is stable and only changes on explicit `open`/`close`, never as a side effect of focus.
- `focused` owns interaction routing only — changing focus never mounts, unmounts, or reorders panes.
- A plain click on a session replaces the focused pane (today's behavior, unchanged for `capacity: 1`).
- Ctrl/Cmd-click opens a session beside the current one (subject to `capacity`).
- Closing a pane removes it from `visible`; the underlying Session is untouched and remains addressable — closing a pane is not deleting a session.
- `requestCapacity(n)` is effect-scoped (returns a disposer) with max-wins arbitration across concurrent requesters, so plugins don't have to coordinate with each other directly.
- Default `capacity` is `1`, which reproduces existing single-session behavior exactly. A plugin that doesn't know about `presentation` sees no change at all — fail-closed by construction.

### Reference implementation

There's a working implementation on my fork, offered here for review/cherry-picking — not as a PR (I know external PRs are closed), just so the shape is concrete rather than hypothetical, and I'm equally happy for it to be discarded if the team goes a different direction:

- Fork: `github.com/wanyexin1998/deepseek-harness`, branch `codex/presentation-v2`
- Base: upstream `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (release `0.1.1-rc.2`)
- Head: `53015a6f39710dac52ed08f05aca0c6bad7444ac`
- Size: 3 commits, ~81 files, +1671/−171. Of that, roughly 500–600 lines are production code across four client packages (`client/runtime` — contract, service, and the presentation state machine; `ui-layout` — a two-column `AppFrame` grid with split-ratio persistence, clamped 0.30–0.70; `ui-renderer` — session provider; `ui-slots` — renderer wiring). The remainder is unit tests, e2e snapshot tests, and architecture notes.
- Worth noting: the stock `0.1.1-rc.2` `client/runtime/sessions/service.d.ts` already says the staged state "can widen to a multi-pane list later" — so this may already be roughly where the team is headed, and I'd rather converge with that than duplicate it.

### A real-world consumer

I maintain [DSH Workbench](https://github.com/wanyexin1998/dsh-workbench), a plugin that adds a two-pane split view (per-pane Navigator, shortcuts, a same-workspace warning, 187 tests) on top of this API. It's been a useful forcing function for the design — the contract above is shaped by actually building something against it, not written in the abstract.

### Open questions for the team

- Is "protocol 2" the right number/name at all? I picked it unilaterally on the fork purely as a version tag for my own iteration — happy to renumber, rename, or reshape the surface entirely to match whatever convention you'd use internally.
- Does this collide with an existing internal multi-pane design? If there's already a direction in progress, I'd much rather adapt DSH Workbench to that than have two competing shapes.
- Any concerns with the `visible`/`focused` split, or the `requestCapacity` arbitration model, from a client-runtime design standpoint?

Happy to answer questions, share more of the diff, or just leave this here for whenever it's useful. Thanks for reading this far, and for keeping Discussions open for this kind of thing.

---

## 中文摘要 (TL;DR)

**提案**:在 `SessionRuntime` 上新增一个小型、可独立演进的 `sessions.presentation` 接口(`protocol: 2`),让插件可以同时呈现多个 Session,而不是只有"当前 Session"这一个槽位。

**为什么插件做不到**:现有渲染层一次只挂载一个 Session,且 `Conversation` 相关内部组件未导出,所以"两个会话并排显示"这类需求无法在不改动客户端内核的前提下以插件形式实现。

**接口设计要点**:
- 状态 `{ visible, focused?, capacity }`:`visible` 决定面板的稳定从左到右排列;`focused` 只负责交互路由(哪个面板接收输入),切换焦点不会挂载/卸载/重排任何面板。
- 动作 `open` / `focus` / `close`;`requestCapacity(n)` 是绑定到调用方生命周期的容量请求,多个请求方之间按"取最大值"仲裁。
- 默认 `capacity` 为 1,与现状完全一致;未适配的插件行为不变(fail-closed,向后兼容)。

**参考实现**:已在个人 fork(`github.com/wanyexin1998/deepseek-harness`,分支 `codex/presentation-v2`,基于上游 `0.1.1-rc.2`)完整实现并测试,约 500–600 行生产代码分布在四个 client 包中,其余为单元测试、e2e 快照测试与架构文档。提供出来仅供官方参考或摘取,并非 PR 请求——完全理解目前不接受外部 PR,官方也完全可以采纳、改造或直接不用。

**真实消费者**:[DSH Workbench](https://github.com/wanyexin1998/dsh-workbench) 插件(双栏分屏、独立 Navigator、快捷键、同工作区提醒,187 个测试)目前基于此 fork 运行。

**想请教官方的问题**:"protocol 2" 这个编号是我单方面定的,愿意按官方习惯重新命名/编号/调整接口形状;这个方向是否与官方内部已有的多面板规划冲突;`visible`/`focused` 的划分和 `requestCapacity` 的仲裁方式是否合理。

---

**Status: Posted 2026-08-27.** This draft has been published as-is to GitHub Discussions: https://github.com/deepseek-ai/deepseek-harness/discussions/4718 — the live post is now the canonical version; this file is kept for record only.

**状态:已于 2026-08-27 发布。** 本草稿已原样发布到 GitHub Discussions: https://github.com/deepseek-ai/deepseek-harness/discussions/4718 —— 现在以线上帖子为准,本文件仅作留档。

**Update: the live body was edited on 2026-08-27** — folded in the seat-inventory evidence, the showing-vs-mounting framing, and a new "Session-scoped slots when capacity > 1" contract subsection (all credited to @weijiafu14's comment).

**更新:线上帖子已于 2026-08-27 编辑** —— 纳入了 seat 清单举证、"能显示≠能挂载"的框架,并新增"capacity > 1 时的 session 级插槽"合同子章节(均已在正文中致谢 @weijiafu14 的评论)。
