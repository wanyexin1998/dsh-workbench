# Round 3 验收发现：捷径验收法测不出客户端半边

> 2026-09-07。round 3 的 §1–§3 已完成（契约、文档、门禁三趟全绿、TGZ 已盖章）。
> §4.3 的"隔离 profile 验收"跑了，但**它证明不了它想证明的东西**。这里写清楚为什么，
> 免得下次再用同一个方法得出"验过了"的错误结论。

## 做了什么

`accept-isolated-profile.ps1`（已按事故后的硬化版本）+ 手工浏览器复核：

1. 新建带时间戳的隔离 `DSH_HOME`；
2. `pnpm dsh plugin --profile web add file:<rc.4 TGZ>` —— 成功；
3. `pnpm dsh --profile web --dump-config` —— 组合配置里有
   `id: dsh-workbench / name: '@wanyexin1998/dsh-workbench'`；
4. `pnpm dsh web` —— 起服务，打印带 token 的 URL；
5. 浏览器打开该 URL，读 `window.__DSH_BOOT__`。

## 发现

**boot 图里 46 个客户端条目，全部是 `@deepseek-ai/*`，没有 Workbench。**
`GET /plugins/@wanyexin1998/dsh-workbench/client.js` → **404**。
服务端日志零错误，浏览器控制台零消息——完全静默。

排除掉的几种解释：

| 假设 | 核查结果 |
|---|---|
| 打包漏了客户端产物 | 否。装好的包里 `lib/client.js` 313,555 字节，`exports["./client"]` 与 `dsh.client.platform: "web"` 都在 |
| `dsh.client.inject` 里的 `@deepseek-ai/dsh-client-ui-slots` 不在图里导致丢弃 | 不是原因。`orderByModuleGraph` 只重排、不丢行，且只看 `external` 不看 `inject`。（顺带查明：`ui-slots` 在**新旧两个 fork 上都没有 `dsh` 字段**，它从来只是库包、不是客户端入口，所以这条 inject 一直是无效 id，rc.1 起就是） |
| rc.4 引入的回归 | **不是。** 控制组——旧 fork（`82de604a`）+ 用户真实 `~/.dsh`（装的是**已发布的 rc.3**）——表现完全相同：HTML 里没有 `wanyexin`，客户端条目同样缺席 |

## 结论：是验收方法的问题，不是 rc.4 的问题

客户端条目来自 `ctx.loader.entries()`（`client/modules/src/index.ts:577`）。
"在 fork 的 checkout 里跑 CLI，用 `DSH_HOME` 指向另一个目录"这种配置下，宿主的模块解析
根在 fork 工作区，而插件装在 `$DSH_HOME/profiles/web/node_modules/` 下，两者对不上。

**已发布的 rc.2 走 bootstrap 安装器做过隔离端到端，Split Pane 是验过的**，安装器那套
配置（自带 `<target>/home`、自带 launcher、profile 与宿主同根）是能工作的。所以：

- 捷径验收（§4.3）能证明的只有：TGZ 可安装、宿主侧插件进得了组合配置、真实 `~/.dsh` 未被动。
- 它**不能**证明客户端半边挂载、不能证明分屏可用、不能替代 §4 的安装器端到端。
- 之前把 §4.3 当成"轻量版端到端"是错的，rc.4 的验收必须走真安装器。

## 对 rc.4 的影响

不阻塞发布，但**发布说明与文档里"未验证"那几段必须照实**（现在已经是这样写的：
RELEASE_NOTES 的 Verified 一节明写"No isolated end-to-end run happened for this
release, on any platform"，COMPATIBILITY_MATRIX 与 KNOWN_ISSUES 也写了 rc.3 和 rc.4
都没重跑过）。

§4 的安装器端到端要在发布之后跑：安装器要从 GitHub clone fork 并 checkout 新 pin，
还要从 Release URL 下载 TGZ，两者都得先推上去。

## 顺带确认的两件事（都在浏览器里核过）

- **token 围栏按文档工作**：裸 `http://127.0.0.1:<port>/` → **401**；带 `?token=` → 200。
  这正是本轮写进 INSTALL 的那段。
- **Node 24 空模块图已修**：本机 Node v24.18.0（在 24.12+ 的正常档），
  `__DSH_BOOT__.entries` 46 条非空。注意这没有复现 24.0–24.11.1 那个坏档，
  KNOWN_ISSUES 里的措辞（"Not reproduced locally"）保持不变。
