> **Draft — pending maintainer review.** Nothing here has been posted. Copy/paste into the GitHub Discussions thread yourself when ready.
> **草稿 — 待维护者本人审阅后手动发布。** 本文件未被自动发送到任何地方，需要你自己复制粘贴到 GitHub Discussions 讨论串。

---

## Target

Reply to weijiafu14's comment (third-party DSH plugin maintainer, not DeepSeek staff, self-disclosed) in:
`https://github.com/deepseek-ai/deepseek-harness/discussions/4718`

---

## Reply body (English, ≈420 words, GitHub-flavored markdown)

Thanks for the pushback — this is a stronger version of the proposal than what I posted, and it's more useful to fix it here than after the fact.

**1. The seat inventory.** Good catch, and thanks for actually going and counting instead of taking my word for it. `conversation` being a single seat *and* the view ring rendering "one at a time by `only: <active id>`" is a cleaner argument than the vague "the render layer treats it as a single slot" I wrote. I'll fold your inventory into the Motivation section, credited to you, instead of my hand-wavier version.

**2. Showing vs. mounting.** Agreed, and it's the right pre-emption before someone posts "just use `shell.overlay`." Your panel proves a second conversation's *data* can be shown today; what it can't do — reuse the host `Conversation` renderer, get session-scoped seats, take host input, show up in lineage — is exactly what "mounting a second Session" means. I'll adopt that framing in Motivation.

**3. The dual-instance gap.** This is the one you're right to press hardest on — it was genuinely underspecified. The fork's actual answer: each visible session gets its own `SessionProvider(sessionId)` subtree (two-column `AppFrame`), so session-scoped seats are instantiated once per *visible* session, and a plugin reads its session id from that provider's scope — not from `focused`, which only routes interaction (shortcuts, command routing, highlighting) and never mounts, unmounts, or reorders anything. At `capacity: 1` there's exactly one subtree, unchanged from today.

But you're also right that "per-visible-session" is the fork's design choice, not a law of nature — no third-party plugin has ever actually run with two live subtrees, and one that keeps state keyed globally instead of by session id can misbehave at capacity 2. That belongs in the contract, not discovered later:

> **Session-scoped slots when `capacity > 1`**
> - Session-scoped seat registrations are instantiated once per *visible* session, each under its own session-scoped provider.
> - `focused` governs interaction routing only; it is never the instantiation gate.
> - At `capacity: 1` (default), there is exactly one provider subtree — identical to current behavior.
> - This API does not retroactively guarantee existing session-scoped plugins are safe above capacity 1; plugins that key state globally rather than by session id should audit before opting in.

Since you maintain a plugin that owns real session-scoped seats, I'd genuinely value your read on whether that wording is auditable against your actual implementation, or whether it's still missing the specific hook you'd need to check it against.

---

## 中文摘要 (TL;DR)

这是对 weijiafu14(第三方 DSH 插件维护者,已自我声明非 DeepSeek 官方)在该讨论串下评论的回复草稿,逐条回应其三个论点:

1. **43 个 seat 清单**:认可其举证更扎实(`conversation` 单例 + view ring `only: <active id>` 单渲染,双重锁死),承诺把这份清单归功于对方并纳入提案 Motivation 部分,替换原本较空泛的表述。
2. **"能显示"≠"能挂载"**:认可这个框架,承诺在 Motivation 中采用"showing vs. mounting"的说法——对方的 `shell.overlay` 悬浮面板证明"显示第二个会话的数据"今天就能做到,但拿不到 host 的 `Conversation` 渲染器、session-scoped seats、host 输入路由和 lineage 视图,这正是"挂载第二个 Session"缺失的部分。
3. **capacity > 1 时的双实例问题**:坦率承认这一点提案确实没写清楚。给出 fork 的真实答案——每个可见 session 各自拥有独立的 `SessionProvider(sessionId)` 子树,session-scoped seat 按"每个可见 session 一份"实例化,插件从 provider 作用域读取 session id,而不是靠 `focused` 判断(`focused` 只管交互路由,不管挂载/卸载);`capacity: 1` 时与现状完全一致。同时明确承认这是 fork 的设计选择而非天经地义,现有插件从未在双活子树下跑过,用全局(而非按 session id)存储状态的插件在 capacity 2 下可能出问题——并给出准备写入提案合同条款的具体措辞(如上英文引用块)。

结尾邀请对方——既然其插件本身持有真实的 session-scoped seats——评估这份措辞对着其真实插件实现是否可审计、是否还漏了什么钩子。

---

**Status: Posted 2026-08-27** as a threaded reply to weijiafu14's comment: https://github.com/deepseek-ai/deepseek-harness/discussions/4718#discussioncomment-18171509

**状态:已于 2026-08-27 以串式回复(threaded reply)发布**,回复对象为 weijiafu14 的评论:https://github.com/deepseek-ai/deepseek-harness/discussions/4718#discussioncomment-18171509
