# Workbench Ask final verification record

> - Verified: 2026-08-30
> - Feature commit: `65db785` on `feat/chat-mode-l1` (parent `b31760f`)
> - Scope: tickets 01–06 of this plan; PRD decisions D1–D6 in `design.md` §7

## English

### Final gates

| Gate | Result |
| --- | --- |
| Package unit suite (`pnpm test`, final tree) | 35 files / 454 tests passed |
| TypeScript typecheck | passed |
| `pnpm release:check` (secret scan, contract check, install + bootstrap node tests, typecheck, test, audit, bundle) | passed on the committed tree |
| Release bundle rebuilt from the final tree | `wanyexin1998-dsh-workbench-0.2.0-rc.1.tgz` sha256 `7594ec35ef0a142deac16a29205c8f8d1a3a831ff41be35aa2fd60d7e7d06861` |
| Stock browser E2E (Harness `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`) | 1 file / 1 test passed |
| Edition browser E2E (Harness fork `53015a6f39710dac52ed08f05aca0c6bad7444ac`) | 1 file / 1 test passed |

Both E2E runs consumed the TGZ rebuilt from the committed tree; the installed
`lib/client.js` in each worktree was hash-identical to the repo build
(`3572493490ba323ae4bed41658d420c2576a3e582ac088402264001b24aaaafd`), so the
browser evidence covers exactly the shipped code — not an earlier integration
build.

### Independent audit

A five-dimension review (correctness/concurrency, contract consistency,
fail-closed gating, test coverage, release hygiene) ran over the working-tree
diff, with every raised finding sent to an independent refutation pass. Result:
8 findings raised, 4 confirmed, all fixed before the feature commit.

| Confirmed finding | Fix |
| --- | --- |
| Fresh chat dead-ended in the side-chat-only `source-not-visible` branch in the Edition zero-Pane home state (reachable via the plugin's own `workbench.session.new`), creating a Session it never opened | `chat-actions.ts` opens the chat directly when no source was ever captured; regression test pins the zero-Pane path |
| `dispose()` global listener/subscription cleanup was unverified — deleting the cleanup loop left the suite green | Test asserts add/remove listener pairing and store-subscription release; mutation-verified to fail without the loop |
| The Edition clear branch of the `presentation.state` subscription (source Pane leaves `visible`) had no covering test | Test pins the clear branch; mutation-verified |
| — (fourth finding was the same zero-Pane defect reported independently by a second dimension) | covered by the fix above |

Both new tests were mutation-verified: each fails when its guarded code is
disabled and passes when restored.

### Third-party code

No reference implementation code was copied. The pinned reference
(`AHGGG/dsh-side-chat` at `e7cd447d97825a944b3d83e2a34488485dc1f088`, MIT) and
the licensing boundary are recorded in ADR-0009; `THIRD_PARTY_NOTICES.md` needs
no change. Any future change that copies or substantially adapts that code must
add the notice first.

### Workspace cleanup

Three implementation worktrees and two Harness E2E worktrees were removed after
confirming none held unintegrated work (no commits ahead of the plan base, and
every untracked file recoverable from `65db785`). Their uncommitted diffs were
saved as patches in the session scratchpad before removal. Analysis artifacts
(`graphify-out/`) were deleted and are now gitignored alongside `chat_record/`.
The E2E carriers were archived into `e2e/harness-web/` with instructions for
recreating either lane.

### Known non-blocking limits

- After a partial success (fork succeeded, Pane open failed), triggering the
  action again forks a new child rather than resuming the retained one.
- An in-flight fork/open has no plugin-unload abort seam.

---

## 中文

### 最终验收门

| 验收门 | 结果 |
| --- | --- |
| 包内单测（最终树 `pnpm test`） | 35 文件 / 454 测试通过 |
| TypeScript typecheck | 通过 |
| `pnpm release:check`（密钥扫描、契约校验、install/bootstrap node 测试、typecheck、测试、audit、打包） | 在已提交树上通过 |
| 最终树重打发布包 | `wanyexin1998-dsh-workbench-0.2.0-rc.1.tgz` sha256 `7594ec35…d06861` |
| Stock 浏览器 E2E（Harness `b150a551…7d28e`） | 1 文件 / 1 测试通过 |
| Edition 浏览器 E2E（Harness fork `53015a6f…7444ac`） | 1 文件 / 1 测试通过 |

两次 E2E 均消费从已提交树重打的 TGZ；两个 worktree 中安装的 `lib/client.js`
与仓库构建产物哈希一致（`35724934…aaaafd`），因此浏览器证据覆盖的正是发布代码，
而非更早的集成构建。

### 独立审计

对工作树 diff 做了五维度评审（正确性与并发、契约一致性、fail-closed 门控、
测试覆盖、发布卫生），每条发现都交由独立的反驳环节复核。结果：提出 8 条、
确认 4 条，全部在 feature commit 之前修复。

| 确认的问题 | 修复 |
| --- | --- |
| Edition 零 Pane 主页状态下（可由插件自身的 `workbench.session.new` 到达），fresh chat 落入仅属于 side chat 的 `source-not-visible` 分支，创建了会话却从不打开 | `chat-actions.ts` 在从未捕获来源时直接打开聊天；新增回归测试锁定零 Pane 路径 |
| `dispose()` 的全局 listener/订阅清理无人验证——删掉清理循环全套测试仍全绿 | 测试断言 add/remove 配对与订阅释放；已用 mutation 验证 |
| `presentation.state` 订阅的 Edition 清除分支（来源 Pane 离开 `visible`）无覆盖测试 | 新测试锁定清除分支；已用 mutation 验证 |
| —（第四条是另一维度独立报出的同一零 Pane 缺陷） | 由上述修复覆盖 |

两个新测试均通过 mutation 验证：注入缺陷时变红，还原后转绿。

### 第三方代码

未复制任何参考实现代码。固定参考（`AHGGG/dsh-side-chat` @
`e7cd447d…1f088`，MIT）与许可边界记录在 ADR-0009；`THIRD_PARTY_NOTICES.md`
无需改动。将来若复制或实质改编该代码，必须先补声明。

### 工作区清理

在确认三个实现 worktree 与两个 Harness E2E worktree 均无未整合工作后删除
（无领先于计划基线的提交，且全部未跟踪文件都可从 `65db785` 恢复）；删除前已
将各自未提交 diff 存为补丁放入会话临时目录。分析产物（`graphify-out/`）已删除，
并与 `chat_record/` 一同加入 gitignore。E2E 载体已归档到 `e2e/harness-web/`，
附带两条通道的重建说明。

### 已知非阻塞限制

- 部分成功（fork 成功、Pane 打开失败）后再次触发会 fork 新 child，不会续接已保留的 child。
- 进行中的 fork/open 没有插件卸载 abort seam。
