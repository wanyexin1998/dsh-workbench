# rc.6 修复与发布 brief

> ⚠️ **本文有两处归因是错的，且不止一个缺陷。**
> 先读同目录的 [`outcome.md`](outcome.md)。原文保留不改，作为当时认知的记录。

> 写于 2026-09-07 深夜，给下一个干净会话用。
> 根因已经钉死，证据在同目录 [`root-cause.md`](root-cause.md)，**先读那份**。
> 本文只讲：改什么、怎么验、怎么发。

---

## 0. 起点状态

| 项 | 值 |
|---|---|
| 插件 main | `8e70737`，树干净，`v0.2.0-rc.5` 已发布 |
| 已发布 rc.5 | Workbench TGZ `a751eeb7…`，panel-compat `0.1.0-rc.3` |
| Harness pin | fork `rc4/presentation-on-0.1.2` @ `c5a387cd2f781d4d9914ea0271ebb507984ca3f4`（上游 `0.1.2-rc.1` = `a66e4702…`） |
| 用户本机 | 两个检出都在 `c5a387cd`：`E:\wyx_code\Vibe coding\deepseek-harness`（detached）和 `E:\wyx_code\.codex-worktrees\deepseek-harness-presentation-v2`（detached，桌面快捷方式用的就是它） |
| 用户 profile | `~/.dsh/profiles/web` 装的是已发布的 rc.5 |
| 桌面启动 | 快捷方式已改指 `E:\wyx_code\dsh-desktop\launch-harness.cmd`；原快捷方式备份在 `E:\wyx_code\dsh-desktop\DeepSeek Harness.lnk.bak` |

**用户现在的处境**：分屏能用，**划词引用和随手问不能用**。他选择不退回旧版本，等 rc.6。

---

## 1. 要改什么

### 1.1 主修：chat 节点表换源

`packages/dsh-workbench/src/native-ux/client/selection-controller.ts:61`

```ts
raw = snapshot.chat?.nodes?.get(dom.nodeKey)   // ← chat 在 0.1.2-rc.1 上已经不在会话快照上
```

会话快照现在只有 15 个键（真实宿主上打出来的，见 root-cause.md），没有 `chat`。

**新位置**：`ui-chat` 把 chat 快照发布成一个 **per-binding 的 hook**，
上游自己的消费者这样读（`ui-chat/src/client/apply.ts:59`）：

```ts
const target = ctx.uiConversation.binding(binding).target('chat')
target.getSnapshot()   // -> ChatSnapshot，其 .nodes.get(key) 就是原来那张表
```

`ChatSnapshot` 的形状在 `ui-chat/src/client/contract/snapshot.ts:92-99`：
`{ order, nodes: ChatNodeStore, locations, navigation, timeline, legacy }`。
`ChatNodeStore.get(key)` 与插件原来用的语义一致。

另一条等价路径（同一份数据的另一个入口）：
`ConversationSnapshot.views.get('chat')`（`ui-conversation/src/client/contract/snapshot.ts:7`
+ `contract/conversation.ts:141`）。**先确认哪一条对插件更稳**——
插件是在 `selectionchange` 处理器里同步读的，需要一个能从 DOM Pane 反查到的、
不依赖 React 上下文的入口。

**没查清的一点**：`uiConversation` 这个服务名我没找到注册处（`ui-conversation`
的 service 注册的是 `'conversation'`，而 `ui-chat` inject 的是 `'uiConversation'`，
`service.ts:377` 又有 `this.ctx.get('uiConversation')`）。**动手前先把这个搞清楚**，
它决定 inject 里要写什么。

### 1.2 连带要改

- **随手问（`Ctrl+Shift+C`）走同一层适配器**，同样失效。修完主路径后
  单独验它，别假设它跟着好了。
- `packages/dsh-workbench/package.json` 的 `dsh.client.inject` 补
  `@deepseek-ai/dsh-client-ui-chat`（上游消费者都声明了它）。
- 客户端入口 `packages/dsh-workbench/src/client/index.tsx:76` 的 cordis inject
  按 1.1 的结论补服务名。**注意 cordis 按路径逐段放行**，
  `remote.session` 那个教训见 [[release-chain-state]] 里 rc.4 那节。

---

## 2. 必须补的门禁（不补，同类回归一定再来）

今天两个回归（rc.4 的 inject、rc.5 的 chat 源）**是同一个模式**：
测试替身比真宿主宽松，于是在一个开机即坏的构建上满分。

1. **替身按真实宿主的形状写。** 现在的 fake 仍然提供 `chat.nodes`，
   所以 663 个测试全绿。改完之后，替身里**不能再有**会话快照上的 `chat`。
   建议直接把真实宿主的快照键名列表（root-cause.md 里那 15 个）写进替身，
   多一个少一个都让测试红。
2. **端到端必须覆盖"划词出工具栏"。** 这是唯一能拦住这类回归的检查。
   rc.5 的教训就是：安装链验了、插件加载验了、分屏验了，**功能没验**。
3. 考虑给 `validatedNode` 这类 fail-closed 的静默返回加一条 dev 级日志
   （"面缺失"和"面搬家"现在表现完全一样，这是排查花了几小时的直接原因）。

---

## 3. 验收（在用户真实宿主上做，不能只跑单测）

前置：`~/.dsh` 里有真实会话（用户那两个 `HTML第6/8页` 会话就行）。

```
node apps/cli/lib/bin.js --profile web --no-open --port 0
```
从 `E:\wyx_code\.codex-worktrees\deepseek-harness-presentation-v2` 起，
拿它打印的 **带 token 的 URL** 打开浏览器。

逐条验，一条都不能跳：

- [ ] 控制台干净，boot 图里有 `@wanyexin1998/dsh-workbench`
- [ ] **真实鼠标拖拽**选中一段 assistant 正文 → 划词工具栏出现
- [ ] 点"添加到对话" → 引用徽标出现在正文旁、chip 进输入框
- [ ] **真实按** `Ctrl+Shift+C` → 起一个新的 chat 会话（或复用当天空白会话）
- [ ] Ctrl+点击第二个会话 → 两个 `[data-session-pane]`（这条 rc.5 已经是好的，防回归）
- [ ] 划词徽标不与右侧 TurnNavigator 重叠（**至今没验过**，rc.5 也没验）
- [ ] `Primary+,` 真按下去能开关设置（**至今只验到"注册了"**）

> **合成事件不算数。** 今天有三次"以为坏了其实是测法不对"：
> 浏览器自动化的 `left_click` 带修饰键送不进 React 合成事件、
> 程序化 `selectNodeContents` 触发不了划词层。
> 手势类验证要么用 `left_click_drag` 这种真实输入，要么
> `dispatchEvent(new MouseEvent('click',{ctrlKey:true,bubbles:true}))`。

---

## 4. 发布 rc.6

`round3-release-chain.md` 那套流程照搬，只列本次特有的：

1. **版本号只能往前。** GitHub 开了**不可变 release**：删掉的 tag 名字永久不能再用。
   rc.5 已发布，下一个只能是 rc.6，别想着复用。
2. **panel-compat 必须跟着升到 `0.1.0-rc.4`。** 它的 `package.json` 里有
   `"@wanyexin1998/dsh-workbench": "workspace:*"`，pnpm 打包时改写成具体版本，
   所以 **workbench 一改号它的字节就变**，而这个仓库绑定"同名同字节"。
3. **两趟盖章**：`build-release-bundle.mjs --allow-unstamped` 拿摘要 →
   写进两个 bootstrap 脚本 → `pnpm release:check`（不带 flag）。
4. fork **不用动**：pin 还是 `c5a387cd`。但要打新 tag
   `dsh-workbench-v0.2.0-rc.6-pin` 指向同一个提交（rc.2~rc.5 的 pin tag 都别删）。
   注意 fork 的那个克隆（`E:\wyx_code\deepseek-harness`）**推送要用 HTTPS**，
   SSH 没权限；而 `dsh-workbench` 仓库用 SSH。
5. 发布说明里如实写：rc.5 的划词/随手问不可用，rc.6 修的就是它。
6. 发完从真实 URL 复验四项校验和 + 两个安装器刻的摘要。

---

## 5. 今天踩过的坑，别再踩

- **`pnpm dsh plugin add` 会失败但看着像成功**：退出码非零时产物没换，
  而 PowerShell 的 `Select-String` 在超长单行文件上判断不可靠。
  **核产物用 `sha256sum` / `grep -c`，别用 Select-String。**
- **打包器要求工作树干净**，脏树时直接拒绝。我的 `grep` 把这条错吞了，白跑一轮。
- **跨上游版本升级检出必须 `pnpm clean`**，否则旧 `lib/` 链不上新 `src/`，
  报一堆 `MISSING_EXPORT`。已写进 INSTALL。
- **PowerShell 里 `node server | Select-Object -First N` 不是挂起**，
  是管道等一个不会退出的进程。诊断服务用重定向到文件 + 轮询。
- **改 inject / 导出这类东西，核构建产物，不要只读源码。** rc.4 那次我第一遍
  修错了文件（改了子模块，真入口是 `src/client/index.tsx`），
  是对着 `lib/client.js` 核对才发现的。
- 事故后的规矩仍然有效：**任何递归删除前先断言路径**，
  PowerShell 里永不使用 `$home` 等自动变量名（见 [[powershell-home-footgun]]）。

---

## 6. 还没做的（与本次修复无关，但欠着）

- 桌面 Tauri 壳（`E:\wyx_code\dsh-desktop`）还是坏的：就绪探测只认 HTTP 200，
  而 0.1.2-rc.1 的裸 `GET /` 返回 401；窗口打开的也是不带 token 的 URL。
  两处都在 `src-tauri/src/lib.rs`（`http_ready` 第 53 行、窗口 URL 第 167 行）。
  修它要先重装 Rust 工具链（`~/.cargo` 在 09-06 的事故里被删了）。
  当前用 `launch-harness.cmd` 绕开，够用。
- 三个文档修复（macOS 快速安装的 grep、`pnpm clean` 步骤、扫描加固）
  已提交到 main **但没推**。rc.6 发布时一起推。
- macOS、只读 `$DSH_HOME`、stock 通用插件路径：从来没跑过。
