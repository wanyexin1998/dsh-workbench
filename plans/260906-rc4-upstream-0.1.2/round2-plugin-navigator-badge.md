# Round 2 · plugin：退役 Navigator，划词徽标避让上游回合导航栏

> 分支 `rc4/upstream-0.1.2`（worktree `E:\wyx_code\Vibe coding\dsh-workbench-rc4`），在 round 1 的依赖迁移之上。用户已拍板：**rc.4 退役 Navigator**。

## A. 退役 Navigator

理由（写进提交信息）：上游 `0.1.2-rc.1` 新增 `TurnNavigator`（`packages/client/ui-chat/src/client/chat/TurnNavigator.tsx`），挂在每个 `ChatView` 的滚动容器内、sticky 贴右沟槽、带悬停/聚焦预览、**覆盖尚未加载的历史回合**——最后一点我们的实现做不到（只索引已渲染 DOM）。两条栏画在同一条沟槽里，保留我们的只会变成噪音。

### 删除清单（`git grep -il navigator` 的全部命中，逐个处理）

| 文件 | 动作 |
|---|---|
| `native-ux/client/navigator.tsx`、`navigator.test.tsx`、`navigator-bus.ts` | 删除 |
| `native-ux/core/navigator-state.ts`、`.test.ts`、`rail-layout.ts` | 删除（只有 navigator.tsx 引用） |
| `native-ux/core/derive-index.ts`、`.test.ts` | **保留**——`conversation-dom.ts:4` 与 `core/preview.ts:3` 引用它的 `ContentBlockView`/`InputNodeView`。只删 navigator 专用的导出（`deriveNavigatorIndex`、`SessionNavigatorItem` 等）及其测试，确认剩余导出仍被 selection 侧使用，否则整文件删 |
| `native-ux/core/preview.ts` | 查引用；若只有 navigator 用，删 |
| `native-ux/client/index.ts:3,28-30`、`client/index.tsx:15,149-151` | 去掉 `applyNavigator` 及其 fail-soft 包装 |
| `native-ux/client/shortcuts.tsx:260-264, 445` | 删 `workbench.conversation.navigator.toggle` 动作与 `EDITABLE_ALLOWED_ACTIONS` 里的条目；默认键 `Primary+Shift+O` 随之释放 |
| `native-ux/client/shortcut-persistence.ts:36` | 旧 id 列表里去掉 `conversation.navigator.toggle`；**迁移必须容忍**用户已持久化的该动作 override——静默丢弃，不报错、不残留（加一条测试：带旧 override 的持久化数据加载后不含该 key，且其他 override 完好） |
| `native-ux/client/locales.ts` | 删 `navigator.*` 与 `shortcuts.action.navigator.toggle` 键（zh/en 两份）；跑现有的"字典无孤儿键"测试 |
| `native-ux/client/capabilities.ts:34,66` | `chatAnchorDom` 探针**保留**（`detectConversationDom().anchors` 划词也在用），把注释里"navigator depends on"改成划词 |
| `native-ux/client/conversation-dom.ts:562` | 注释改口 |
| `native-ux/client/harness-adapter.ts:439`、`quote-overlay.tsx:154-170`、`selection-actions.tsx:2370` | 注释里引用 `navigator.tsx:NNN` 的地方改成描述性文字（那些行号所指的代码要删了），**引用的那段教训本身要保留**（GA-031：观察器不长期挂 body） |
| `client/guard.ts:193`、`guard-failure.tsx:7`、`client/index.tsx:111,192` | 散文里去掉 Navigator |
| `README.md` / `README_EN.md` | 能力表删「Navigator」行；默认快捷键表删「切换 Navigator」行；分屏描述里"独立 Navigator"改口；`docs/assets/dsh-workbench-banner.png` 的 alt 提到 Navigator 轨迹——改 alt，图不重画 |
| `docs/INSTALL.md:158` | "you get Navigator, shortcuts, Ask" → 去掉 Navigator |
| `CONTEXT.md`、`AGENTS.md:8` | 词汇表与包职责描述里去掉 |
| `docs/ACTIONS_API.md` | 若列出该动作，删 |
| `docs/PRODUCT_CONTRACT.md` | 若提及，删；在同一处加一句：回合导航由宿主 `TurnNavigator` 提供，每个 Pane 各一条 |

### 不要做的

- 不要为了"替代"去写任何新的导航 UI。
- 不要动 `Primary+Shift+O` 以外的默认键位。
- `packages/dsh-workbench/README.md`（包内 README）也 grep 一遍。

## B. 划词徽标避让上游导航栏

事实（`dsh-v0.1.2-rc.1:packages/client/ui-chat/src/client/chat/TurnNavigator.module.css`）：

- 栏挂在 `ChatView` 的 `.scroll` 容器内（`ChatView.tsx:755-762`），`position: sticky; top: 0; z-index: 7`
- 外框 `position: absolute; width: 28px; right: calc(12px - (var(--dsh-composer-side-clearance) + 16px))`
- **没有任何 `data-*` 属性或 `role`**，只有 CSS-module 类名和一条本地化的 `aria-label`——**不能靠选择器找到它**（按显示文字锚定是社区卡 R-13 点名的坑）

我们的徽标：`quote-highlight.ts:325-342 placeQuoteBadge` 把徽标放在 `rowRect.right + QUOTE_BADGE_GAP`，右界是 `band.right - QUOTE_BADGE_EDGE_INSET`。带子 `band` 来自滚动容器矩形。

### 做法：给带子右缘留一条固定保留带，不嗅探 DOM

1. 在 `quote-highlight.ts` 加常量 `TURN_RAIL_RESERVE`，值 = 栏宽 28 + 栏自身留的 12 = **40px**，中文注释引用上游 CSS 的那两行并说明"不嗅探 DOM 的理由"。
2. `placeQuoteBadge` 的 `rightBound` 改为 `band.right - QUOTE_BADGE_EDGE_INSET - TURN_RAIL_RESERVE`；`avoidTakenBadges` 同一右界。徽标排不进沟槽时的兜底逻辑（`lastRect.right + gap`）不变。
3. `placeQuoteCard` / `pinQuoteCard`（卡片与标签）**也**要避开这条带：卡片右缘不得进入保留带。
4. 这个常量对**所有**宿主生效（rc.4 只支持 0.1.2-rc.1 及以上），不做版本分支。
5. 测试：`quote-highlight.test.ts` 里现有的落点断言按新右界更新；新增两条——① 行右缘紧贴带子右缘时徽标落在保留带**左侧**；② 卡片右缘不进保留带。用**杀法**验证：把 `TURN_RAIL_RESERVE` 改成 0，两条新测试必须红。
6. `--dsh-composer-side-clearance` 是上游变量，我们不读它；保留带是常量，宽度变化由 `band.right` 实时测量吸收（用户可拖拽正文宽度，那只影响 `rowRect`，不影响 `band`）。

## C. 验收

- `pnpm typecheck`、`pnpm test`、`node scripts/release-contract-check.mjs`、`node scripts/scan-secrets.mjs` 全绿。
- `git grep -i navigator` 在 `packages/`、`docs/`、`README*` 里只剩：对上游 `TurnNavigator` 的**描述性**提及（说明它存在、每 pane 一条）。
- 提交分两条：`refactor(navigator): retire the Navigator rail …`、`fix(selection): keep the quote badge out of the host's turn rail …`。
- 真机：装进隔离 profile，划词加引用，徽标不与右侧回合导航栏重叠；拖宽正文再看一次。
