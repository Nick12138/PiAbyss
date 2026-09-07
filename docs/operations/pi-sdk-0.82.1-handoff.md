# Pi SDK 0.82.1 / Node 升级交接

更新日期：2026-07-26

本文是从另一台开发机器继续升级工作的当前状态说明。历史基线、最初风险分析和回滚锚点见 [Pi SDK 0.82.1 Upgrade](./pi-sdk-0.82.1-upgrade.md)；该文档中的 `8859c1e` 和 `a92c...` 哈希是历史证据，不是当前依赖锁。

本文说明 PR-3 要做什么；它所依据的 `0.82.1` 公共 API 事实（导出变化、`ModelRuntime`/`CredentialStore` 契约、Package 取消面、ResourceLoader 边界）单独记录在 [Pi SDK 0.82.1 API 核查记录](./pi-sdk-0.82.1-api-notes.md)。

## 1. 继续点

- 仓库：`https://github.com/Skitre/PiAbyss.git`
- 分支：`main`，后续直接在 `main` 开发，不新建分支。
- 当前提交：`e3faa58046fe162acaa006878a39a5c004cd1c2f`
- 当前提交说明：`build(release): derive sdk evidence from host manifest`
- `origin/main` 在交接时与上述提交一致。
- tracked worktree 在交接时干净。
- PR-3 尚未开始；源代码、manifest 和 lock 仍完整处于 SDK `0.80.7` 状态。

开始改动前必须确认：

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git rev-parse HEAD
git status --short
```

预期 `HEAD` 是上面的完整 SHA，`git status --short` 无输出。如果远端已有后续提交，先审计这些提交，不要强行回到交接 SHA。

## 2. 当前版本与证据

| 项目 | 当前值 | 本轮目标/说明 |
| --- | --- | --- |
| `@earendil-works/pi-ai` | `0.80.7` | PR-3 原子升级到 `0.82.1` |
| `@earendil-works/pi-agent-core` | `0.80.7`（传递依赖） | PR-3 必须解析为 `0.82.1` |
| `@earendil-works/pi-coding-agent` | `0.80.7` | PR-3 原子升级到 `0.82.1` |
| `@earendil-works/pi-tui` | `0.80.7` | PR-3 原子升级到 `0.82.1` |
| pnpm | `9.15.0` | 保持不变，单独升级 |
| 最低 Node | `22.19.0` | 保持兼容门槛 |
| 开发/受控发布 Node | `24.18.0` | 临时版本，不具备 RC 资格 |
| `@types/node` | `24.12.4` | 保持不变 |
| TypeScript | `5.9.3` | 保持不变 |
| Vitest | `3.2.4` | 保持不变 |

当前规范哈希：

```text
pnpm-lock.yaml
2ab36330143599dc48a9a909f2771ff1d5e715ef94006f29660b51c1be79df56

patches/@earendil-works__pi-coding-agent@0.80.7.patch
ef9e0f8e9bc6eddc8005e5f425c140d2a52cc0072c4115a0a553ddaedac6baca
```

SDK 版本的规范来源是 `packages/pi-host/package.json`。`scripts/release-runtime.lock.json` 是发布断言，不应重新成为手工维护的第二版本来源。完整 SDK evidence 由以下文件负责：

- `scripts/release-sdk-evidence.mjs`
- `scripts/release-sdk-evidence.test.mjs`
- `scripts/release-runtime.lock.json`（schema 3）

evidence 必须同时验证 Host manifest、pnpm lock、部署树和 staged tree，并报告四个 Pi 包、SDK patch SHA-256 和 pnpm-lock SHA-256。

## 3. 已完成阶段

| 阶段 | 状态 | 关键提交 | 结果 |
| --- | --- | --- | --- |
| PR-0A | 完成 | `665b9f2` | 修复并证明 0.80.7 release baseline，增加 Windows staged gate |
| PR-0B | 完成 | `3d239f5` | 冻结脱敏的 0.80.7 compatibility fixtures 和事件白名单 |
| PR-1 | 完成 | `06e44a7`, `ba518f6` | 对齐 Node 22 minimum / Node 24 canonical lanes |
| PR-2 | 完成 | `4c912b1` | graph mutation 生命周期、shutdown cancellation、stale fetch、`models-store.json` fingerprint |
| PR-2B | 完成 | `e3faa58` | 以 Host manifest 派生 release SDK evidence |
| PR-3 | 完成 | `9ebf492` … `c081315` | SDK 0.82.1 原子迁移，见下 |
| PR-4 | 完成 | `9980c99` … `c64ccf4` | 新事件接入、auth 兼容测试、Extension provider 隔离（泄漏已证明并修复），见 §9 |
| PR-5/6 | 已预备，等 07-27 安全版本 | - | pin 脚本/runbook/canary 清单就绪，见 §10；首步是 §10.2 libuv 分叉检查 |

### PR-3 当前状态

§6.1–§6.8 全部完成并通过 Windows gate，`main` 已推送到 `c081315`。下一步是 PR-4。

新规范哈希：

```text
pnpm-lock.yaml
97ba98eb23cba8c62691c5faaf6ca62eb3d0a355f706841536bc0309980c5676

patches/@earendil-works__pi-coding-agent@0.82.1.patch
9f31547b92db07a205b3a8d4788ec4bc66b44af3a6e66fc011e254e0fb1541dc
```

两项与原计划不同的决定，理由见 [API 核查记录](./pi-sdk-0.82.1-api-notes.md)：

1. **不扩大 patch 到 ResourceLoader。** 它私有的 PackageManager 会在 reload 时静默 `npm install` / `git clone`。与其让这件事可取消，不如让它不发生：workspace 建图与 session create/open 的 reload 用 `withoutImplicitPackageInstall()` 包住，符合 §6.4 的不联网要求。package mutation 后的 reconcile 不包，仍不可取消，由 shutdown 兜底。
2. **`setOperationSignal` 在 `PackageManager` 接口上声明为必需**，`?.` 静默退化变成编译错误。

迁移备份与 provider journal 的运行时行为见 [Development Workflow](./development.md)。

历史回滚标签：

```text
pre-pi-sdk-0.82.1-8859c1e414c
```

## 4. 最新验证证据

提交 `c081315`（PR-3 完成）的本地验证：

- Node `24.18.0`：`pnpm verify:p0` 通过。
- Protocol：359 tests。
- Host：376 tests。
- Desktop：324 tests。
- Rust：34 tests。

最新 Windows 完整 gate：

- Run：[30196221459](https://github.com/Skitre/PiAbyss/actions/runs/30196221459)
- Node 22 minimum lane：通过。
- Node 24 source/P0/staging lane：通过。
- staged SDK family：`pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui` 均为 `0.82.1`。
- staged patch：`patches/@earendil-works__pi-coding-agent@0.82.1.patch`。
- staged pnpm-lock SHA-256：`97ba98eb23cba8c62691c5faaf6ca62eb3d0a355f706841536bc0309980c5676`（`pnpmLockVerified: true`）。
- resource validation errors：`0`（layout `compacted-zip`）。
- staged Host smoke：`{"status":"ok","sdkVersion":"0.82.1","nodeVersion":"v24.18.0","rehydrateWatermark":1,"exitCode":0}`。
- compacted dependency zip SHA-256：`1ffcb72bebeae6c6eec675aa8c24eee6c11341d5244a88a216312b1702335002`。
- artifact ID：`8630229801`。
- artifact digest：`sha256:d175fa6a6c070e786f1eb96bce59a1c4258e5ac10ac901d94d52dcaa353a6bbd`。

前两次 Windows 尝试（`12fbdf9`、`d3882e7`）失败的原因全部在 PR-3 新增的测试代码，不在生产代码：`.bin/tsx` 在 Windows 是 `.CMD` 包装、绝对路径不是合法 ESM specifier、POSIX 权限位不被遵守、刚 kill 的子进程仍持有目录句柄，以及一处固定 sleep 在慢 lane 上先于子进程持锁。跨进程测试现在等待子进程写出的标记，不依赖时钟。

GitHub Actions artifact 保留期为 14 天；SHA、run 和测试结果才是长期交接证据。

## 5. 不可改变的边界

1. 三个 direct Pi 包必须一起从 `0.80.7` 升到 `0.82.1`，同一份 frozen lock 中的 `pi-agent-core` 也必须是 `0.82.1`。不得把半迁移状态推送到 `main`。
2. pnpm 保持 `9.15.0`。不要在 SDK migration 中顺带升级 pnpm、TypeScript、Vitest、Tauri、Vite 或 React。
3. 最低 Node 保持 `>=22.19.0`。
4. Node `24.18.0` 仅是临时受控版本。它在 Windows 上受 [nodejs/node#63638](https://github.com/nodejs/node/issues/63638) 影响；精确版本的 watcher test 目前有条件跳过。
5. 2026-07-27 之后的 Node 24 安全版本正式发布、URL/SHA 固定且 Windows watcher/full staged gate 通过之前，不生成 RC。
6. macOS 是主要开发环境；Windows CI 是 sidecar、resource layout 和 staged Host smoke 的权威结果。
7. 不 deep-import coding-agent 的内部 `AuthStorage`。只使用 0.82.1 的公共 API。
8. 回滚必须恢复完整旧 artifact、release runtime lock、pnpm lock 和 SDK patch；不得在已安装 artifact 内单独替换 npm 包。
9. `test-fixtures/pi-agent/0.80.7` 中明确的 `0.80.7` 是历史兼容输入，不能机械替换成 `0.82.1`。

## 6. PR-3 原子迁移顺序

以下步骤可以拆成便于审查的本地 commit，但在全部 gate 通过前不要推送中间状态。

### 6.1 依赖与 lock

同时修改 `packages/pi-host/package.json`：

```text
@earendil-works/pi-ai@0.82.1
@earendil-works/pi-coding-agent@0.82.1
@earendil-works/pi-tui@0.82.1
proper-lockfile@4.1.2                 production dependency
@types/proper-lockfile@4.1.4          dev dependency
```

重建一份 lock 后检查：

```bash
pnpm list \
  @earendil-works/pi-ai \
  @earendil-works/pi-agent-core \
  @earendil-works/pi-coding-agent \
  @earendil-works/pi-tui \
  --depth 20
pnpm why @earendil-works/pi-coding-agent
```

不得存在混合 `0.80.x` / `0.82.x` runtime，也不要预先用 root override 掩盖真实的版本分叉。

### 6.2 持久化 CredentialStore

新增 PiAbyss 自有实现和测试，建议文件：

```text
packages/pi-host/src/credential-store.ts
packages/pi-host/src/credential-store.test.ts
packages/pi-host/src/credential-store-process.test.ts
```

实现 `@earendil-works/pi-ai` 的公共 `CredentialStore` contract：

```text
read(providerId)
list()
modify(providerId, callback)
delete(providerId)
```

关键语义：`modify()` callback 返回 `undefined` 表示“不变”，不是删除；删除必须走独立的 `delete()`。同一 provider 的 read-modify-write 要跨进程序列化，OAuth refresh 也走这一条路径。

最低持久化要求：

- agent directory 在支持的平台使用 `0700`，credential 文件使用 `0600`。
- advisory lock 覆盖完整 read-modify-write。
- 保留未知 provider/credential 字段。
- 写临时文件、flush/fsync、atomic rename，失败时清理临时文件并保留原文件。
- malformed JSON、lock timeout、rename/permission failure 使用 typed errors。
- 日志不得包含 key、access token、refresh token 或完整 credential object。
- PiAbyss 内部另设 `snapshot()` / `restore()`；不要把事务辅助能力混入 SDK contract。

必须覆盖单进程并发、两个独立进程并发、写入中断、权限和 secret-log 测试。

### 6.3 迁移备份先于真实 runtime

第一次对真实 `PI_CODING_AGENT_DIR` 调用 `ModelRuntime.create()` 之前，必须备份并写入带 SHA-256/bytes 的 manifest：

```text
auth.json
models.json
models-store.json（若存在）
settings.json
package 配置
Session header/metadata
```

建议备份目录为 `~/.pi/agent/piabyss/migration-backups/piabyss-sdk-0.80.7-to-0.82.1/<timestamp>/`。PiAbyss 自有的 provider journal、Model 配置备份和 Session 归档也分别放在同级命名空间的 `provider-journal/`、`model-backups/` 和 `session-archive/` 下；原生的 `models.json` 与活动 Session 位置不变。manifest 不得包含 credential 内容。只有 runtime create、local refresh、旧 Session open/continue/save、provider snapshot 和正常 shutdown 都成功后，才能记录 migration completed。

### 6.4 Host-owned ModelRuntime

Host 只创建一个权威 `ModelRuntime`：

```ts
const modelRuntime = await ModelRuntime.create({
  credentials: credentialStore,
  modelsPath,
  modelsStorePath,
  allowModelNetwork: false,
});
const modelRegistry = new ModelRegistry(modelRuntime);
```

将同一个 `modelRuntime` 注入每一个 `createAgentSession()` 调用。`ModelRegistry` 只作为兼容 facade 和同步读取入口，不再负责 runtime ownership。

禁止继续使用无语义的 `modelRegistry.refresh()`。建立两个显式 helper：

```ts
await modelRuntime.refresh({ allowNetwork: false, signal }); // local/reconcile
await modelRuntime.refresh({ allowNetwork: true, signal });  // explicit network
```

Host 启动、provider list/save/remove/setEnabled、models.json reconcile 和 Session create/open 都不得访问网络。用户显式 refresh、`provider.fetchModels` 或被明确允许的后台 catalog refresh 才能联网，并且必须带 Host shutdown signal 和 deadline。

### 6.5 Graph ownership 和 Session 注入

将 graph dependencies 从 `authStorage + modelRegistry` 迁移为：

```text
credentialStore
modelRuntime
modelRegistry
```

完成后必须满足：

```text
AuthStorage production references = 0
ModelRegistry.create production references = 0
所有 createAgentSession 都收到同一个 Host-owned modelRuntime
所有 refresh 都显式 await，并声明 allowNetwork
```

测试中的 0.80.7 fixture 行为可以继续通过兼容 helper 表达，但不得依赖私有 deep import。

### 6.6 Provider transaction 和恢复

`models.json` 与 `auth.json` 不能通过单次 rename 获得跨文件原子性。优先实现 operation journal；最低也必须实现 deterministic rollback 和 `modelConfigHealth: degraded` 恢复状态。

推荐顺序：

```text
begin provider.mutation GraphOperation
acquire serviceGraphLock and recheck identity
capture models.json bytes and credential snapshot
validate isolated candidate ModelRuntime with network disabled
write journal/candidates
commit models.json and credential change
local ModelRuntime refresh with operation signal
reconcile active model and authoritative snapshots
write commit marker / clear journal
release lock and finish operation
```

失败时恢复原始 models bytes、credential snapshot 和 active model，再执行 local refresh。若恢复无法完整完成，启动和请求路径必须暴露 degraded/journal recovery 状态，不能继续声称配置健康。

临时 candidate runtime 必须使用临时 models/models-store 和 `InMemoryCredentialStore` 或只读 credential snapshot；不得访问真实 auth/models-store、公网、production runtime 或当前 Session model。

### 6.7 重建 0.82.1 SDK patch

删除旧 `0.80.7` patch binding，生成：

```text
patches/@earendil-works__pi-coding-agent@0.82.1.patch
```

新 patch 只保留 PackageManager 子进程 cancellation，覆盖 npm install/update/remove/root、git clone/fetch/pull 和 capture/inherit 两类 spawn。删除旧 extension cache preservation 和 `preserveExtensionCache` 行为，Package reconcile 使用官方完整 reload。

Host 不得再用 `setOperationSignal?.(...)` 静默退化；启动或 package operation 前必须断言 cancellation capability 存在。operation signal 必须一直保留到 mutation、reconciliation 和 reload 全部结束。

0.82.1 的 `DefaultResourceLoader` 拥有私有 `DefaultPackageManager`。必须明确审计并记录它是否也需要 patch/signal injection；未做决定不能通过 PR-3 review。

行为测试必须实际启动长运行 npm/git child，abort 后断言 child 退出、mutation settled、operation finish、graph lock 可重新获得。仅 grep patch 字符串不算验证。

### 6.8 版本引用审计

搜索所有固定版本：

```bash
rg -n '(0\.80\.7|24\.18\.0|pi-agent-core|sdkVersion)' \
  .github scripts packages apps docs
```

分类处理：

- runtime、release、spike 和当前架构断言改为 `0.82.1` 或由 Host manifest 派生。
- `test-fixtures/pi-agent/0.80.7` 及其兼容性测试保留历史版本字面量。
- protocol/desktop/Rust 中模拟“当前 Host status”的 fixture 更新为 `0.82.1`。
- Node `24.18.0` 的 Windows watcher workaround 在最终 Node pin 时必须删除或自动失效并实际运行。

## 7. 当前源码热点

开始迁移时先运行：

```bash
rg -n \
  '(AuthStorage|ModelRuntime|ModelRegistry\.(create|inMemory)|new ModelRegistry|createAgentSession|modelRegistry\.refresh|setOperationSignal)' \
  packages/pi-host/src
```

主要生产路径：

| 文件 | 当前迁移点 |
| --- | --- |
| `packages/pi-host/src/main.ts` | `AuthStorage.create`、`ModelRegistry.create`、启动 refresh |
| `packages/pi-host/src/workspace-graph-types.ts` | `AuthStorage` dependency type |
| `packages/pi-host/src/workspace-graph-factory.ts` | graph dependency injection |
| `packages/pi-host/src/workspace-lifecycle.ts` | `createAgentSession` |
| `packages/pi-host/src/session-lifecycle.ts` | create/open 两条 `createAgentSession` 路径 |
| `packages/pi-host/src/provider-controller.ts` | candidate registry、credential/provider rollback |
| `packages/pi-host/src/package-controller.ts` | operation signal 当前在 reconcile/reload 前清除 |

重点测试：

```text
provider-controller.test.ts
pi-sdk-compatibility.test.ts
extension-ui.integration.test.ts
model-thinking.test.ts
sdk-package-cancellation.test.ts
resource-reload-required.test.ts
```

## 8. PR-3 验收 gate

本地必须通过：

```bash
pnpm install --frozen-lockfile
pnpm verify:quick
pnpm verify:p0
git diff --check
```

另外必须有针对性证据：

- CredentialStore unit、跨进程 lock/concurrency、atomic write、permissions tests。
- provider rollback、journal/crash recovery、degraded-state tests。
- local refresh 绝不触网；network refresh 必须显式授权并带 signal。
- 所有 Session 收到同一个 Host-owned runtime。
- package child cancellation 和完整 reload 行为。
- 0.80.7 fixture 能 open、continue prompt、save、reopen。
- secret fixture scan 继续通过。

Windows push gate 必须通过：

```text
Node 22 minimum: pnpm verify:quick
Node 24 canonical: pnpm verify:p0
pnpm package:sidecar:with-node
pnpm validate:resources
pnpm smoke:staged-host
```

staged evidence 必须报告四个 Pi 包均为 `0.82.1`、新的 patch SHA 和新的 pnpm-lock SHA，resource errors 为 0，Host 正常 shutdown/exit。Windows gate 完成之前，PR-3 不能视为结束。

## 9. PR-4 后续工作

PR-3 稳定后再做以下兼容扩展。全部六项已完成：本地 pi-host 400 / desktop 326 用例全绿，两包 `tsc --noEmit` 干净，Windows gate run `30197892965`（`c64ccf4`）verify-p0 与 verify-node-minimum 一次通过——跨进程 oauth 竞争与真实 Host A→B→A 集成用例均在两条 lane 上验证。

- ~~评估桌面端是否需要展示 `summarization_retry_*` 三事件~~ —— 已接入。白名单放行审阅字段，`transcript-reducer.ts` 映射到既有 `isRetrying`；branch-summary 退避期间桌面端从此有真实状态信号，compaction 期间表头仍优先显示 "Compacting"。详见 api-notes §9。
- ~~`bash_execution_update` 仅在实际使用 direct RPC bash 时接入~~ —— 决定不接入：唯一发射点 `AgentSession.executeBash()` 在 PiAbyss 无调用方；`event-normalize.test.ts` 以显式回归测试把它钉在 `{ type: "unknown" }`。
- ~~保持 `event-normalize.ts` 白名单~~ —— 保持；新事件亦经白名单进入，未知事件仍规约为 `{ type: "unknown" }`。
- ~~覆盖 API key、OAuth refresh、environment/header-only auth、custom headers/models、compaction/branch auth~~ —— 新增三组测试：
  - `credential-store.test.ts` + `credential-store-process.test.ts`：oauth 凭证 read() 原样返回、SDK `resolveStoredOAuth` 形状的过期刷新持久化、锁下二次校验跳过刷新、刷新回调抛错不损坏存储；跨进程双进程竞争刷新**恰好轮换一次**（marker 计数 + 最终 token 归属胜者），对应 §11「OAuth refresh 竞争写或跨进程更新丢失」。
  - `auth-compatibility.test.ts`：stored key 跨 ModelRuntime 重建仍解析（§11「API key 重启后丢失」）、models.json `$VAR` key、builtin 环境变量兜底、header-only provider 的 compat/stream 分歧（`getApiKeyAndHeaders` ok 而 `getAuth` 不解析——连接检查通过不代表请求可用）、per-model headers 大小写不敏感覆盖、null 哨兵头在请求面被过滤。
  - `summarization-auth.test.ts`：真实 AgentSession + 捕获型 provider，`compact()` 与 `navigateTree({summarize})` 的摘要请求实际携带 key 与 headers（§11「compaction/branch auth 失败」）；已做破坏验证——移除 provider key 两条测试即红。
- ~~覆盖 retained/background Session 和 Workspace A/B Extension provider 隔离~~ —— `extension-provider-isolation.test.ts` 先以未包装 runtime **证明泄漏**（session dispose 后 provider 仍在共享注册表），`workspace-package.integration.test.ts` 增加真实 Host A→B→A 用例：A 的 `.pi` 扩展 provider 在 B 不可见、回 A（retained 图重激活）恢复。已做破坏验证——禁用 suspend 后 B 立即看到 A 的 provider。
- ~~只有隔离测试证明 provider 泄漏时，才增加 owner/ref-count 基础设施~~ —— 泄漏已证明，`extension-provider-ownership.ts` 落地：workspace 粒度 owner；`retainGraph` suspend（独占 provider 注销并存 effective config）、`tryReactivateRetainedGraph` resume、`disposeGraph` release；共有 provider 以 owner 集合引用计数，最后一个 owner 离开才注销；`applyKnownThinkingProfiles` 走 neutral 上下文不占有；faux provider 等启动注册归永久 host owner。归属用 `AsyncLocalStorage` 绑定构建/绑定窗口，运行期回退到激活图。同 Workspace 内的 Session 共享 workspace 扩展，隔离粒度刻意停在 workspace（per-session 注销会破坏同工作区并行 Session）。

PR-4 验收：与 PR-3 相同的 Windows CI gate 已通过（run `30197892965`，两 job 均 success）。下一阶段是 §10 的 PR-5/6——等待 2026-07-27 之后的 Node 24 安全版本并固定 URL+SHA。

## 10. PR-5/6 后续工作

### 10.1 已预备（2026-07-26）

- 官方公告核实：Node 安全发布定于 **2026-07-27（周一）或稍后**，覆盖 22.x / 24.x / 26.x 三条线，最高严重级 HIGH，CVE 未预披露（<https://nodejs.org/en/blog/vulnerability/july-2026-security-releases>）。`nodejs.org/dist/latest-v24.x` 确认 24.18.0 仍是最新 24.x——不存在已发布的替代版本。
- 替代方案已评估并否决：改 pin Node 22（22.x 明天同样吃 HIGH 补丁，只换来 watcher 修复，纯亏）；24.18.0 直接发版 + win32 绕过 watcher（native abort 不可 catch，且发布即带已知 HIGH 漏洞 runtime，踩 §11）。
- `scripts/update-node-pin.mjs` 就绪：一条命令更新全部 pin 落点，从官方 SHASUMS256.txt 取哈希；已用 24.18.0 自校验（取回哈希与现 pin 一致、写回字节稳定）。**不带 `--libuv-fix-verified` 拒绝执行**——把 §10.2 的分叉决策固化进工具。
- macOS Host gate 预演：`pnpm verify:p0` 全链通过（verify:quick + build + test:rust 34 用例，2026-07-26）。

### 10.2 明天第一步：libuv 分叉检查（在动任何 pin 之前）

`workspace-files.test.ts` 的 Windows watcher skip 条件是 `process.versions.node === "24.18.0"` **精确匹配**——任何新版本都会自动解除跳过。而安全发布通常是最小补丁，**未必带 libuv 的 fs-event 修复（libuv/libuv#5152）**。所以：

1. 读新版本 changelog（`https://github.com/nodejs/node/releases/tag/v<VER>`），确认是否包含 libuv bump / fs-event 修复。
2. **含修复** → 走 §10.3 主路径。
3. **不含修复** → 停：三选一并记录到本文档——(a) 等包含修复的 24.x；(b) pin 安全版本 + 把 skip 条件扩成版本集合（watcher 缺陷在 Windows 继续存在，不可 RC）；(c) win32 轮询 fallback（功能降级，需改 `workspace-files.ts`）。

### 10.3 主路径（机械步骤）

```bash
node scripts/update-node-pin.mjs <VER> --libuv-fix-verified
# 更新 .node-version + release-runtime.lock.json 的 node 段（版本/archive/URL/SHA-256）
fnm install <VER> && fnm use <VER>
pnpm install --frozen-lockfile && pnpm verify:quick
# 提交并 push → Windows gate（verify-p0 + verify-node-minimum）
```

推送后必须在 CI 日志里确认 `coalesces changes for watched expanded directories` **真实执行且通过**（不再 skip）——这是 §11「Windows watcher gate」的关闭条件。随后更新本文档：§13 预期 node 版本、状态表 PR-5 行、新哈希。

pin 落点清单（脚本覆盖前两处）：`.node-version`（本地 fnm 与 CI `node-version-file` 同源）、`scripts/release-runtime.lock.json`、本文档 §13 预期版本文本。`validate.test.ts:31` 与 `host-context.test.ts:20` 的 `"v24.18.0"` 是合成 fixture 值，不随 pin 变更，勿改。

### 10.4 Gate 现状盘点（诚实版）

| Gate | 现状 |
| --- | --- |
| Windows Node 22 minimum | 已有（`verify-node-minimum` lane，watcher 测试在此 lane 一直真实运行） |
| Windows Node 24 staged/installer | 已有（`verify-p0` lane，用 `.node-version`，pin 更新后自动切换） |
| macOS Host | 无 CI lane；本地 `pnpm verify:p0` 为其形态（已预演通过） |
| Linux Host | **不存在**，明天需决定：建 lane 或记录为手动 gate |
| fault-injection | **不存在**成型脚本，明天需定义范围 |

### 10.5 发布顺序与 canary 检查单

internal build → canary → general release。canary 必须逐项覆盖：

- [ ] 真实 API key provider 完整对话
- [ ] 真实 OAuth provider（含一次过期刷新，确认 auth.json 轮换且无双写）
- [ ] 既有用户目录升级（迁移备份出现在 `<agentDir>/backups/`，milestone 全达成）
- [ ] package install / update / 取消（无残留 npm/git 子进程）
- [ ] Workspace A/B 切换（含 A 有 `.pi` 扩展 provider 时 B 不可见——PR-4 隔离在真实环境复验）
- [ ] 重启恢复（API key 仍在、旧 Session 可继续 prompt 并保存）
- [ ] 长 prompt + compaction 触发（摘要请求带 auth）
- [ ] 退出后无残留 Host/Node/npm/git 进程

## 11. 强制停止条件

出现任一项，不得推送 PR-3 完成状态或生成 release：

```text
credential 丢失、未知字段删除或日志泄密
OAuth refresh 竞争写或跨进程更新丢失
API key 重启后丢失
本地 refresh/provider.list 意外访问公网
旧 Session 无法继续 prompt 并保存
compaction/branch auth 失败
Package cancellation 未杀死 npm/git child
Extension provider 跨 Workspace 泄漏
patch 未进入 staged production tree
runtime 混用 0.80.x 和 0.82.x
rehydrate 可读到 provider/model transaction 中间态
models-store.json 变化仍复用旧 retained graph
release evidence 与 staged tree 不一致
frozen lock 无法重建同一依赖树
最终 Node 安全版本、URL、SHA 或 Windows watcher gate 未完成
```

## 12. 回滚原则

代码回滚保留完整的上一版 pnpm lock、release runtime lock、`0.80.7` patch、baseline tag 和已验证 artifact。

若 0.82.1 已写入用户目录：

1. 关闭 PiAbyss 和 Pi CLI，确认无残留 Host/Node/npm/git 进程。
2. 保存当前 0.82.1 数据副本用于诊断。
3. 恢复迁移前 auth/models/settings/package/session metadata 备份。
4. 根据实测结果处理仅属于新 runtime 的 `models-store.json`，不要假设 0.80.7 一定忽略它。
5. 安装完整上一版 artifact。
6. 验证 provider、Session open/continue/save 和 Package 行为。

## 13. 新机器启动

macOS 建议使用项目的精确 Node 文件：

```bash
git clone https://github.com/Skitre/PiAbyss.git
cd PiAbyss

brew install fnm
eval "$(fnm env --use-on-cd --shell zsh)"
fnm install "$(cat .node-version)"
fnm use "$(cat .node-version)"

npm install --global corepack@latest
corepack enable pnpm
corepack prepare pnpm@9.15.0 --activate

node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm verify:quick
```

预期版本：

```text
node v24.18.0
pnpm 9.15.0
```

在未修改 checkout 上核对交接证据：

```bash
git rev-parse HEAD
shasum -a 256 pnpm-lock.yaml
shasum -a 256 patches/@earendil-works__pi-coding-agent@0.80.7.patch
node --test scripts/release-sdk-evidence.test.mjs
```

继续工作的第一组命令：

```bash
git status --short --branch
node --version
pnpm --version

rg -n \
  '(AuthStorage|ModelRuntime|ModelRegistry\.(create|inMemory)|new ModelRegistry|createAgentSession|modelRegistry\.refresh|setOperationSignal)' \
  packages/pi-host/src

rg -n '(0\.80\.7|24\.18\.0|pi-agent-core|sdkVersion)' \
  .github scripts packages apps docs
```

日常开发和 release gate 说明见 [Development Workflow](./development.md)、[Release Process](./release.md) 和 [Release Checklist](./release-checklist.md)。
