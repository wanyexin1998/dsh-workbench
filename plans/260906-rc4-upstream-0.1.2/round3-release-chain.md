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

1. `release-contract.json`：`workbenchVersion` → `0.2.0-rc.4`；`harness.branch` → `rc4/presentation-on-0.1.2`；`harness.implementationCommit` → 新 sha。`upstreamVersion`/`upstreamCommit` round 1 已改。`panelCompatibility` 不动（`git diff --stat v0.2.0-rc.3..HEAD -- packages/dsh-workbench-panel-compat` 只有 round 1 的类型迁移，版本号 `0.1.0-rc.1` 保留——**除非** panel-compat 的 TGZ 内容变了；变了就得升 `0.1.0-rc.2`，因为已发布的 rc.1 TGZ 摘要不能再指向不同内容）。
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
- `docs/KNOWN_ISSUES.md`：加 rc.3 在 Node 24.0–24.11.1 上"客户端模块图为空、插件客户端半边不挂载"的条目（上游 loader bug，`vendor/README.md:51`），注明 rc.4 随 pin 推进修复；加 Workbench Ask 的两档退化如果 round 2 C2 落在选项 (c)。
- `docs/COMPATIBILITY_MATRIX.md`：pin 行换成新 sha / 新分支；Settings 动词三档表的"当前 pin"改新 sha、"上一版 pin"改 `82de604a`（rc.3）；**端到端证据行保持 rc.2 + `1a8cf5ba` 的措辞**，本轮 Windows E2E 跑完之后再改成"rc.4 已对着 `<新 sha>` 跑过"。
- `README.md` / `README_EN.md`：兼容性表 pin 行；徽章；下载 URL；「打开 / 关闭设置」行里 `82de604a` → 新 sha 缩写；Navigator 相关 round 2 已删；`docs/assets/dsh-workbench-shortcuts.png` 的说明段里"摄于 rc.2"保持。
- `RELEASE_NOTES.md`：前置 `# DSH Workbench 0.2.0-rc.4` 一节。**Added**：适配上游 0.1.2-rc.1；Settings 动词随 pin；`ctx.remote` 迁移。**Changed**：Navigator 退役（说清上游 TurnNavigator 更强的三点）；徽标避让保留带。**Fixed**：Node 24.0–24.11.1 空模块图（随 pin）；Ask 的 workspace 解析改按 `updatedAt`；C2 的结论。**Distribution boundary**：新 pin、新 tag `dsh-workbench-v0.2.0-rc.4-pin`。**Verified**：等门禁跑完填真数。**Upgrading**：指向 INSTALL 的升级段。

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
