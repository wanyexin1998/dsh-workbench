# Round 3 · 安装链 / 文档 / 门禁 / 发布（rc.4）

> 前置：round 2 两侧都已验收（fork 分支有了新的 implementationCommit；插件分支 Navigator 已退役、徽标已避让、Ask 两档已修）。本轮把发布链搬到新 pin 上，补门禁的洞，然后走 rc.3 那套两趟盖章流程。全部条目来自安装链审计，带 `file:line`。

## 0. 输入（round 2 结束后填）

| 项 | 值 |
|---|---|
| fork 分支 | `rc4/presentation-on-0.1.2` |
| fork implementationCommit | `<round 2 fork HEAD 的 40 位 sha>` |
| 上游基线 | `dsh-v0.1.2-rc.1` = `a66e4702047846cdaa10c66c9d3df3951f5ea70d`（round 1 已写进 contract） |
| Workbench 版本 | `0.2.0-rc.4` |

## 1. 契约与钉点（一个提交）

1. `release-contract.json`：`workbenchVersion` → `0.2.0-rc.4`；`harness.branch` → `rc4/presentation-on-0.1.2`；`harness.implementationCommit` → 新 sha。`upstreamVersion`/`upstreamCommit` round 1 已改。**`panelCompatibility.packageVersion` → `0.1.0-rc.2`（已决定）**：`git diff v0.2.0-rc.3..HEAD -- packages/dsh-workbench-panel-compat/package.json` 改了 `inject` 列表（去掉已删的 `dsh-client-runtime`）与 cordis 下限（`^4.0.2`），这些字节在 TGZ 里；而 `0.1.0-rc.1` 这个名字已经对应已发布的摘要 `5f20a13d…`，同名不同字节不许。随之：`packages/dsh-workbench-panel-compat/package.json` 的 `version`、README×2 / COMPATIBILITY_MATRIX / INSTALL 里所有 `0.1.0-rc.1`（文档扫描对 `panelCompatibility.packageVersion` 豁免，契约一改，漏掉的会自己标红）。
2. `package.json`、`packages/dsh-workbench/package.json` → `0.2.0-rc.4`。
3. 两个 bootstrap 脚本各 6 个常量：`HarnessForkBranch`/`HARNESS_FORK_BRANCH`、`HarnessCommit`/`HARNESS_COMMIT`、`HarnessUpstreamBaseCommit`/`HARNESS_UPSTREAM_BASE_COMMIT`（→ a66e4702…）、`WorkbenchVersion`/`WORKBENCH_VERSION`、`ReleaseBaseUrl`/`RELEASE_BASE_URL`（`…/download/v0.2.0-rc.4`）、TGZ 摘要（**第二趟才填**，第一趟保持旧值靠 `--allow-unstamped` 放行）。
4. `scripts/bootstrap/bootstrap.test.mjs:225` 那个硬编码的 `HARNESS_COMMIT` 常量：改成从 `release-contract.json` 读（同文件 `:292-293` 已经加载了契约），顺手把"两个脚本都嵌入 `harness.upstreamCommit`"加成断言（审计发现它是唯一没有任何检查读的契约字段）。
5. `packages/dsh-workbench/src/client/contract.ts:11` round 1 已改成 `0.1.2-rc.1`；`release-contract-check.mjs` 加一条 `contract.ts version === harness.upstreamVersion`（现在只 `/protocol:\s*2\b/`）；再加一个对 `panelCompat.peerDependencies` 的 peer 循环（现在只查 workbench 的）。
6. `e2e/harness-web/README.md:11-12` 的两个基线 sha 手改，并把这个文件加进 `release-contract-check.mjs:354` 的 pin 扫描名单。
7. `packages/dsh-workbench/README.md:7` round 1 已改。

## 2. 文档（一个提交；文档扫描会把漏改的全部标红，当清单用）

- `docs/INSTALL.md`：
  - 「装完之后」加一段：launcher 打印并打开 `dsh web: http://127.0.0.1:<port>/?token=…`；浏览器没自动开就**粘贴这条带 token 的 URL**，裸 `http://127.0.0.1:<port>` 会 401（`bundle/web-app/src/index.ts:271-284`）。
  - 新增「从 rc.3 升级」：安装器拒绝已存在的目标目录（`ps1:311-315`），UNINSTALL 让删整个 `<target>`——那会连 `home/` 里的 Session 一起删。步骤：把 `<target>/home` 挪开 → 删 `<target>` → 跑 rc.4 安装器 → 挪回。**明说** 0.1.2-rc.1 不做不可逆迁移（Session 格式两侧都是 v0；投影缓存按记录引导、旧文件不删），格式 v2 只在 0.1.3-alpha.1，rc.4 不涉及。
  - §stock 路径的 "Navigator" 已由 round 2 删掉；再 grep 一遍。
- `docs/UNINSTALL.md`：同上的升级说明交叉引用。
- `docs/KNOWN_ISSUES.md`：加 rc.3 在 Node 24.0–24.11.1 上"客户端模块图为空、插件客户端半边不挂载"的条目（上游 loader bug，`vendor/README.md:51`），注明 rc.4 随 pin 推进修复。**Ask 的两处退化已在 round 2b 修掉（`025be0c`、`9ffc026`），不进 KNOWN_ISSUES。**
- `docs/COMPATIBILITY_MATRIX.md`：pin 行换成新 sha / 新分支；Settings 动词三档表的"当前 pin"改新 sha、"上一版 pin"改 `82de604a`（rc.3）；**端到端证据行保持 rc.2 + `1a8cf5ba` 的措辞**，本轮 Windows E2E 跑完之后再改成"rc.4 已对着 `<新 sha>` 跑过"。
- `README.md` / `README_EN.md`：兼容性表 pin 行；徽章；下载 URL；「打开 / 关闭设置」行里 `82de604a` → 新 sha 缩写；Navigator 相关 round 2 已删；`docs/assets/dsh-workbench-shortcuts.png` 的说明段里"摄于 rc.2"保持。
- `RELEASE_NOTES.md`：前置 `# DSH Workbench 0.2.0-rc.4` 一节。**Added**：适配上游 0.1.2-rc.1；Settings 动词随 pin；`ctx.remote` 迁移。**Changed**：Navigator 退役（说清上游 TurnNavigator 更强的三点）；徽标避让保留带。**Fixed**：Node 24.0–24.11.1 空模块图（随 pin）；随手问两处——当日空白 chat 会话复用改读 `projectionValues.agentPreset`（信号没删、搬进了 session projection）、零 Pane 兜底 workspace 改按 `updatedAt` 取最近（`recentWorkspaceId` 不再投影）。后者有一处行为放宽要写明：来源 workspace 不在列表里时，原来直接停止，现在落到第三档。**Distribution boundary**：新 pin、新 tag `dsh-workbench-v0.2.0-rc.4-pin`。**Verified**：等门禁跑完填真数。**Upgrading**：指向 INSTALL 的升级段。

## 3. 门禁与发布（rc.3 流程原样）

```
1. 树干净 → node scripts/build-release-bundle.mjs --allow-unstamped   # 拿新 TGZ 摘要（会 WARN）
2. 把摘要写进两个 bootstrap 脚本 → commit "chore(release): stamp the rc.4 TGZ digest into both installers"
3. pnpm release:check（不带 flag，9 步）→ 必须绿；dist/SHA256SUMS 的 TGZ 摘要 == 刻的那个
4. RELEASE_NOTES 填 Verified 真数 → commit → 再跑一次 pnpm release:check（manifest.sourceCommit 要等于最终提交）
5. fork：push rc4/presentation-on-0.1.2；打 tag dsh-workbench-v0.2.0-rc.4-pin 在 implementationCommit 上
   （rc.2/rc.3 的 tag 与 fix/plugin-spec-quoting、feat/toggle-settings-verb 分支照旧不删）
6. Better Sidebar fork：不动（0.1.0-rc.1 未变）
7. push main → gh release create v0.2.0-rc.4 --prerelease（别忘了 --prerelease，rc.3 漏过）
8. 从真实 URL 下载 4 个校验资产 + SHA256SUMS 复验；安装器里刻的摘要 == 已发布 TGZ
```

## 4. Windows 隔离端到端（**必做**，rc.3 没做过）

- 全新临时目标目录（路径**含空格**，复现 rc.2 的场景）；`-TgzSha256` 不传（走默认校验）。
- 安装器从 GitHub clone fork 并 checkout 新 pin；GitHub 传输重置的话用 rc.2 那套本地裸镜像替换传输层，文档里如实写"未证明可达 GitHub"。
- 验：`state: installed` / exit 0；`git -C <target>/deepseek-harness rev-parse HEAD` == 新 sha 且 detached；`--dump-config` 含 `@wanyexin1998/dsh-workbench`；launcher 起 web，浏览器控制台无守卫失败；Ctrl+click 第二个会话出两个 `[data-session-pane]`；划词徽标不与右侧回合导航栏重叠；`Primary+,` 开关设置；真实 `~/.dsh` 未被动过。
- 跑完把 COMPATIBILITY_MATRIX / KNOWN_ISSUES 的证据行改成 rc.4 + 新 sha，并把 `E2E-EVIDENCE-v0.2.0-rc.4.md` 作为第 7 个附件（rc.2 的做法）。

## 5. 本地升级（用户机器）

用户的 Harness 是 fork 主 checkout（`E:\wyx_code\Vibe coding\deepseek-harness`，现在 `82de604af`）。rc.4 发布后：`git fetch origin && git checkout rc4/presentation-on-0.1.2`（或直接 checkout 新 sha）→ `pnpm install --frozen-lockfile && pnpm build` → 把**已发布**的 rc.4 TGZ 装进真实 web profile → `--dump-config` 探针。他的 `~/.dsh` Session 格式不变，无需迁移。

---

## rc.6 之后补的三条（2026-09-08）

这三条都是 rc.6 跑完才知道的，写在这里是因为**下一次不看这份就会重踩**。

### 1. 盖章不是两趟，是「代码冻结之后才盖第一次章」

rc.6 实际盖了**三趟**，每趟摘要都不一样：`d2e07c06…` → `f2482e09…` → `b329024e…`。
规律很干净：**任何落进 `packages/dsh-workbench/src` 的改动都会作废已刻的摘要**
（预设修复触发第二趟、span 修复触发第三趟；中间两个纯文档提交不触发）。

所以 §3 那句「两趟盖章」应读成一条硬顺序：

> **代码冻结 → 盖章 → 门禁。** 盖完章再改一行进包的源码，就得原样重走
> 「打包拿摘要 → 写进两个 bootstrap → 不带 flag 再跑门禁」。

顺带补一条这条流程赖以成立、却全仓没写过的前提：**源码不变时重打出来的 TGZ
是逐字节可复现的**（pnpm 在 pack 时重新生成 `package.json`，tsdown 出的是 LF，
其余进包文件由 `.gitattributes` 钉成 `eol=lf`），所以摘要才能当内容指纹用。
本次实测：改了一批 `docs/` 之后重打，两个 TGZ 摘要与已发布的完全相同。

### 2. 上游基线一动，契约点名的**每一个** fork 都要在新基线上真启动一次

§3 步骤 6 写的是「Better Sidebar fork：不动」。**就是这条把一个砖放了过去。**

流程里有「Harness fork 前进」的步骤，却没有「基线在一个我们不重建的 fork 底下
移动了」这一步。Better Sidebar 的 pin（`1685770`）是对着 `0.1.1-rc.1` 建的，
上游在 `0.1.2-rc.1` 删了 `settingsNamespace`，于是它一加载就抛、整棵插件树失败、
**harness 起不来**。这个缺陷从 rc.4 一路带到 rc.6，三个版本的契约和 INSTALL 都在
教用户去装它。

现有门禁只查形状不查加载：`release-contract-check.mjs:181-199` 校验
`packageVersion`、peer 范围、40 位提交格式——没有任何一条能发现那个 fork 起不来。

**补一条硬闸**：只要 `harness.upstreamVersion` 变化，`release-contract.json` 里
点名的每一个 fork 都必须在新基线上**真的启动一次**；起不来的，它那一行必须标成
不兼容，并从 INSTALL 的安装路径里摘掉（保留代码块，加拦截警告——那个块被
`release-contract-check.mjs:229-239` 要求原样存在，删了门禁会红）。

### 3. `file:` TGZ 的 pnpm 缓存陷阱

**换了内容但文件名没变时，pnpm 会命中缓存回一句「Already up to date」，
profile 里装的还是旧插件。** 本次每一轮真实宿主验证都要绕开它。

破解：删掉 profile 的 `node_modules` 与 `pnpm-lock.yaml` 再装。

并且——**核已装产物的 sha256，不要信安装命令的输出**：

```bash
sha256sum ~/.dsh/profiles/web/node_modules/@wanyexin1998/dsh-workbench/lib/client.js
# 必须等于 packages/dsh-workbench/lib/client.js
```

这与 rc6-brief §5「核产物用 `sha256sum` / `grep -c`，别用 Select-String」是同一条
教训的另一半：那半说的是**怎么读**，这半说的是**读哪个**。
