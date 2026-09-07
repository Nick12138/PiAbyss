# Pi SDK 0.82.1 API 核查记录

更新日期：2026-07-26

本文记录 PR-3 迁移所依赖的 Pi SDK `0.82.1` 公共 API 事实。它是 [Pi SDK 0.82.1 / Node 升级交接](./pi-sdk-0.82.1-handoff.md) 的证据附件：交接文档说明**做什么**，本文说明**依据是什么**。

仓库当前仍固定在 `0.80.7`，下列内容全部来自已发布的 `0.82.1` 产物，不代表已安装的依赖树。

## 1. 核查方式

在仓库之外的临时目录执行，不触碰 `pnpm-lock.yaml`：

```bash
npm pack @earendil-works/pi-ai@0.82.1
npm pack @earendil-works/pi-coding-agent@0.82.1
npm pack @earendil-works/pi-tui@0.82.1
npm pack @earendil-works/pi-agent-core@0.82.1
```

核查时的 tarball SHA-256：

```text
2f9df9522808b621cd3449876537f03d8a8df8b8d7ec2d5b18c6a910aa85b490  earendil-works-pi-ai-0.82.1.tgz
8343ab95cbab5766f2f5d48844df8db13e772ead2e2976166cbb820a29dacb7d  earendil-works-pi-coding-agent-0.82.1.tgz
ff0ddec8c790dc663398d8d2bd62e505e18e7cad77bad82821597a833c56dc8e  earendil-works-pi-tui-0.82.1.tgz
6087575f20630ad4fcfb6fecdd0af21ea211eacefe2356913776e2a36d84e40b  earendil-works-pi-agent-core-0.82.1.tgz
```

所有结论均引自各包 `dist/**/*.d.ts` 与 `dist/core/package-manager.js`。npm 上的 tarball 可被重新发布覆盖；如果哈希对不上，请以重新核查的结果为准并更新本文。

## 2. coding-agent 公共导出变化

以 `dist/index.d.ts` 为准。PiAbyss 现在使用的导出中：

| 导出 | `0.82.1` |
| --- | --- |
| `AgentSession` | 保留 |
| `SessionManager` | 保留 |
| `SettingsManager` | 保留 |
| `DefaultPackageManager` | 保留 |
| `DefaultResourceLoader` | 保留 |
| `createAgentSession` | 保留 |
| `VERSION` | 保留 |
| `ModelRegistry` | 保留，但语义变为兼容 facade |
| `ModelRuntime` | 新增 |
| `AuthStorage` | **已从公共入口移除** |

`AuthStorage` 的文件实现仍在 coding-agent 内部（依旧基于 `proper-lockfile`），但不再从包入口导出。交接文档 §5.7 的约束就来自这里：不得 deep-import 该内部路径。

## 3. ModelRuntime

`dist/core/model-runtime.d.ts`：

```ts
export interface CreateModelRuntimeOptions {
  credentials?: CredentialStore;   // 默认使用 authPath 指向的文件
  authPath?: string;
  modelsPath?: string | null;
  modelsStore?: ModelsStore;
  modelsStorePath?: string;
  allowModelNetwork?: boolean;     // 默认 false
  modelRefreshTimeoutMs?: number;  // create 时联网刷新的超时
  catalogBaseUrl?: string;
}

export declare class ModelRuntime implements Models {
  private constructor();
  static create(options?: CreateModelRuntimeOptions): Promise<ModelRuntime>;
  refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
  // ...
}
```

要点：

- 构造函数是私有的，只能走 `await ModelRuntime.create()`；它是异步的，而旧的 `ModelRegistry.create()` 是同步的。这会改变 Host 启动路径的时序。
- `allowModelNetwork` 默认 `false`，且 create 时的联网刷新只有在**显式允许**时才发生。
- `credentials` 接受任意 `CredentialStore` 实现，这正是 PiAbyss 自有持久化实现的注入点。

## 4. 刷新语义

`@earendil-works/pi-ai` 的 `dist/models.d.ts`：

```ts
export interface ModelsRefreshOptions {
  allowNetwork?: boolean;
  force?: boolean;      // 允许联网时跳过 provider 的新鲜度检查，立即拉取
  signal?: AbortSignal;
}

export interface ModelsRefreshResult {
  aborted: boolean;
  errors: ReadonlyMap<string, Error>;
}
```

`ModelRegistry.refresh()` 的签名是 `(): Promise<void>` —— **没有参数，也不返回结果**。因此它既无法声明是否允许联网，也无法传入取消信号，更无法报告 `aborted` 或分 provider 的错误。

这是交接文档 §6.4 禁止继续使用 `modelRegistry.refresh()`、要求改为两个显式 helper 的直接原因。`ModelsRefreshResult` 也意味着 PiAbyss 的 refresh helper 应该检查返回值，而不是只 await 一个 `void`。

## 5. ModelRegistry 的新定位

`dist/core/model-registry.d.ts` 的类注释是「Synchronous compatibility facade exposed to extensions. Coding-agent internals use ModelRuntime directly.」

```ts
export declare class ModelRegistry {
  constructor(runtime: ModelRuntime);
  refresh(): Promise<void>;
  // getAll / getAvailable / find / registerProvider / ... 保持同步读取
}
```

静态 `ModelRegistry.create(...)` 与 `ModelRegistry.inMemory(...)` 都不存在了。所有生产代码和测试里的这两种调用都必须改写为 `new ModelRegistry(runtime)`。

## 6. CredentialStore 契约

`@earendil-works/pi-ai` 的 `dist/auth/types.d.ts`：

```ts
export interface CredentialStore {
  read(providerId: string): Promise<Credential | undefined>;
  list(): Promise<readonly CredentialInfo[]>;
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined>;
  delete(providerId: string): Promise<void>;
}
```

上游注释明确的语义，PiAbyss 的实现必须逐条满足：

- `read` 可能返回**已过期**的凭据，仅供展示/状态使用；真正用于请求的 auth 来自 `Models.getAuth()`。
- `list` 只返回元数据，不解析也不暴露 secret，并且**不得**在列举时执行 provider 配置的 API-key 命令。
- `modify` 是**唯一**的写入路径。回调能看到当前凭据（refresh、refresh 期间 login 都依赖它）；返回 `undefined` 表示**保持不变**，不是删除。互斥是 per-provider 的，在后端支持时还必须跨进程（例如文件锁）。回调抛出的异常向外传播。
- `delete` 是独立的删除路径，实现必须让它与 `modify` 串行化。
- 错误语义：`read` 对不存在的条目 resolve 为 `undefined`；只有存储失败才 reject，`Models` 会把这类 rejection 包成 code 为 `auth` 的 `ModelsError`。

`InMemoryCredentialStore` 是公共导出（`dist/auth/credential-store.d.ts`，经 `export * from "./auth/credential-store.ts"` 暴露），可直接用于隔离的候选 runtime 校验。公共入口**没有**持久化实现——这就是 PiAbyss 必须自己写一个的原因。

## 7. createAgentSession 的 runtime 注入

`dist/core/sdk.d.ts` 的 `CreateAgentSessionOptions` 新增：

```ts
/** Canonical model/auth runtime. Defaults to a runtime using agentDir/auth.json and models.json. */
modelRuntime?: ModelRuntime;
```

注意默认行为：**不传就会各自新建一个 runtime**。PiAbyss 有多条 `createAgentSession` 调用路径（workspace 建图、session create、session open），任何一条漏传都会静默产生第二个 runtime，导致 provider/auth 状态分叉。这是交接文档 §6.5 把「所有 createAgentSession 收到同一个 Host-owned runtime」列为验收项的原因。

## 8. Package 取消面

`dist/core/package-manager.js` 中 `DefaultPackageManager` 的子进程出口：

| 出口 | 底层 | 可取消 |
| --- | --- | --- |
| `spawnCommand()` | `spawnProcess`，`stdio` 为 `inherit` 或 `["ignore", 2, 2]` | 可以：`SpawnOptions` 接受 `signal` |
| `spawnCaptureCommand()` | `spawnProcess`，`stdio` 为 `["ignore", "pipe", "pipe"]` | 可以：同上 |
| `runCommandSync()` / `runNpmCommandSync()` | `spawnProcessSync` | **不可以**：`spawnSync` 无 `signal` |

上游 `0.82.1` **没有** `setOperationSignal`，两个 async 出口也没有注入任何 signal——PiAbyss 的 patch 仍然必需，且形状与现有 `0.80.7` patch 的 package-manager 部分一致。

同步路径的实际用途是解析全局 npm root：`runNpmCommandSync(["root", "-g"])`，bun 走 `["pm", "bin", "-g"]`。它在 abort 后不会被打断。任何「Package 生命周期完全可取消」的表述都必须排除这条路径，或先把它改造成异步。

### ResourceLoader 的独立边界

`dist/core/resource-loader.d.ts`：

```ts
export interface ResourceLoaderReloadOptions {
  resolveProjectTrust?: (input: { extensionsResult: LoadExtensionsResult }) => Promise<boolean>;
}
```

三件事同时成立：

1. reload 选项里**没有** signal，所以 `AgentSession.reload()` 期间的包解析无法通过公共 API 取消。
2. `DefaultResourceLoader` 有 `private packageManager`，是它自己构造的独立实例。对 PiAbyss graph 级 PackageManager 调用 `setOperationSignal()` **不会**影响它。
3. `reload()` 调用 `this.packageManager.resolve()` 且**不传 `onMissing`**（`resource-loader.js:232`、`:348`）。在这个形态下 `resolvePackageSources()` 会静默安装：

```js
const installMissing = async () => {
  if (isOfflineModeEnabled()) return false;
  if (!onMissing) {
    await this.installParsedSource(parsed, resolvedScope);   // 直接装
    return true;
  }
  ...
};
```

npm 包的触发条件是「磁盘上不存在」或「已装版本不满足配置的 range」（版本比较是纯本地 semver，不联网；只有安装联网）；git 包的触发条件是「目录不存在」。也就是说 `reload()` 会真的执行 `npm install` / `git clone`。

注意 `parseSource()`：npm 源必须写成 `npm:<spec>`，未加前缀的字符串会被归类为 `local`，不触发安装。写这条路径的测试时如果漏了前缀，测试会静默失效。

### PiAbyss 的决定

不扩大 patch。改为让**非用户发起**的 reload 不可能安装。

`isOfflineModeEnabled()` 每次调用现读 `process.env.PI_OFFLINE`（`1` / `true` / `yes`），因此可以在调用点前后临时设置。`installNpm` / `installGit` 本身**不检查**该开关，所以 PiAbyss 自己的 `package.install` 不受影响；但 `checkForAvailableUpdates` 会检查，所以不能全局设置。

`packages/pi-host/src/offline-package-resolution.ts` 的 `withoutImplicitPackageInstall()` 包住两个调用点：

```text
workspace-lifecycle.ts   workspace 建图（含启动预载）
session-lifecycle.ts     session create / open
```

这两条路径正是交接文档 §6.4 要求「不得访问网络」的路径。package mutation 之后的 reconcile reload **不包**——那是用户显式发起的包操作，联网是预期行为；它仍然不可取消，由 Host shutdown 兜底。

四个 reload 调用点全部在 `serviceGraphLock` 下，所以进程级环境变量的临时切换不会被并发的解析观察到。

另外，`ResourceLoaderReloadOptions` 里没有 `preserveExtensionCache` —— 那是现有 `0.80.7` patch 加的字段。新 patch 删除该行为后，这个选项不复存在，Package reconcile 必须走官方完整 reload。

## 9. 依赖与事件

coding-agent `0.82.1` 的 `dependencies` 中与本次升级相关的：

```text
@earendil-works/pi-agent-core  ^0.82.1
@earendil-works/pi-ai          ^0.82.1
@earendil-works/pi-tui         ^0.82.1
proper-lockfile                4.1.2
```

`proper-lockfile@4.1.2` 与上游一致，且它不自带 TypeScript 声明；PiAbyss 若直接 import，需要自行加 `@types/proper-lockfile@4.1.4` 开发依赖。

`dist/core/agent-session.d.ts` 的事件联合相比 `0.80.7` 新增四个：

```text
summarization_retry_scheduled
summarization_retry_attempt_start
summarization_retry_finished
bash_execution_update
```

`event-normalize.ts` 是显式白名单，未列入的事件会被规约为 `{ type: "unknown" }`。因此这四个事件在 PR-4 之前不会跨越 Host/Desktop 边界，PR-3 也不需要为它们改协议。

PR-4 已对这四个事件做出决定：

- **三个 `summarization_retry_*` 事件：接入。** 它们由 `AgentSession._summarizationRetryCallbacks()` 在 compaction 或 branch-summary 的摘要 LLM 调用重试时发出（`dist/core/agent-session.js`）。桌面端此前在 branch-summary 重试退避期间没有任何状态信号，表头会显示 "Working" 且无从区分卡死与退避。现在白名单放行审阅过的字段（`attempt`/`maxAttempts`/`delayMs`/`errorMessage`/`source`/`reason`），`transcript-reducer.ts` 把它们映射到既有的 `isRetrying` 状态；compaction 期间 `isCompacting` 在表头优先级更高，用户继续看到 "Compacting"，语义仍然真实。协议无需改动——`SerializableAgentSessionEvent` 本就是 `{ type: string }` 加 JSON 值的宽松类型。
- **`bash_execution_update`：不接入。** 它唯一的发射点是 `AgentSession.executeBash()`（TUI `!` 命令 / direct RPC bash），PiAbyss 的 Host 与桌面端都不调用该方法，扩展 API 也不直接暴露它。即便未来某扩展间接触发，结果仍会以 `bashExecution` 会话消息落入 session 历史并经快照渲染，丢掉 delta 流不损失任何持久数据。`event-normalize.test.ts` 用一条显式回归测试把该事件钉在 `{ type: "unknown" }` 上，使这成为有记录的决定而非遗漏。

另注意：协议中的 `agent.compactionChanged` / `agent.retryChanged` 事件通道自定义以来 Host 从未发射（桌面端 `App.tsx` 有处理分支但收不到），compaction/retry 状态实际全部经 `agent.event` → transcript-reducer 传递。新事件沿用这条活路径，不复活死通道。

## 10. 由此得出的待决项

1. ~~Host 启动路径必须适配 `ModelRuntime.create()` 的异步性~~ —— 已完成，启动改为 `await ModelRuntime.create()` 并显式 await 首次本地 refresh。
2. ~~新 patch 应把 `setOperationSignal` 声明为必需方法~~ —— 已完成，`?.` 静默退化现在是编译错误。
3. ~~ResourceLoader 私有 PackageManager 是否也注入 signal~~ —— 已决定，见上节：不扩大 patch，改用 `withoutImplicitPackageInstall()` 让隐式 reload 不可能安装。
4. `runNpmCommandSync` 不可取消（`npm root -g`、`npm pm bin -g`、`npm list -g`），patch 只加了 abort 预检。验收措辞必须显式排除这条路径。
5. ~~迁移备份仍未接入~~ —— 已完成，`migration-backup.ts` 在首次 `ModelRuntime.create()` 之前备份并写 manifest，完成标记要求 runtime create、local refresh、旧 Session 打开、provider snapshot、正常 shutdown 全部达成（可跨多次运行累积）。
6. ~~Provider 事务尚未实现 journal 或 degraded 恢复状态~~ —— 已完成，`provider-journal.ts` 在提交前把 `models.json` 与 `auth.json` 的原始字节落盘；条目残留即代表上次变更未完成，启动时先恢复，恢复不完整则 `modelConfigHealth` 报 `degraded`（协议新增该状态与 `provider.journal` 来源）。
7. ~~§6.7 的真实子进程 abort 行为测试仍未编写~~ —— 已完成，`sdk-package-cancellation.test.ts` 起真实长运行子进程、abort、并用 `process.kill(pid, 0)` 断言进程确实被回收，覆盖 inherit 与 capture 两类 spawn。把 patch 的 signal 注入去掉后三条测试都会红，证明它们不是空转。

   注意 capture 那条的断言顺序：`runCommandCapture` 自带 10s 网络超时，如果先 await 操作再检查子进程，超时早已把子进程收掉，测试在没有 patch 时也会绿。必须在 await 之前用远小于 10s 的期限断言。

## 11. Extension provider 泄漏与 ownership 层（PR-4）

0.82.1 的 `ModelRuntime` 把扩展注册的 provider 存进进程级实例字段 `extensionProviders` / `nativeExtensionProviders`（`dist/core/model-runtime.js`），key 是裸 provider id，无任何 workspace/session 命名空间；`AgentSession.dispose()` 不注销，SDK 与 PiAbyss 全仓也没有任何 `unregisterProvider` 调用方。上游一进程一工作区所以无碍；PiAbyss 的 Host 先后服务多个工作区，泄漏路径完整：

- 扩展 `pi.registerProvider` 加载期入 loader 私有队列（`ExtensionRuntimeState.pendingProviderRegistrations`），在 `createAgentSession` → `ExtensionRunner.bindCore` 冲入共享 runtime；bind 之后的注册（Path B，agent turn 中途）经 `providerActions` 直达 `session._modelRuntime`——PiAbyss 注入的正是全局唯一 runtime。
- 重复注册按「defined 值合并覆盖」语义（`registerProvider` 保留旧字段），A、B 同 id 会互相污染。
- `retainedGraphFingerprint` 覆盖 `models.json` 但不含内存中的 extensionProviders，所以 retained 图带泄漏重激活。

**证据**：`extension-provider-isolation.test.ts` 第一组用例对未包装 runtime 复现——session dispose 后 provider（含 config 内 apiKey）仍在注册表。满足交接文档「只有隔离测试证明泄漏才建 owner/ref-count」的门槛。

**ownership 层**（`extension-provider-ownership.ts`）：对 runtime 实例做方法级包装（ModelRegistry facade、ExtensionRunner 兜底 facade、providerActions 全部经同一实例方法，一处拦截全覆盖）。规则：

- 归属：`AsyncLocalStorage` 绑定 workspace 构建/绑定窗口 → 显式 owner；无窗口时回退到激活图；再无则永久 host owner（faux provider、启动注册）。
- `runNeutral`：`applyKnownThinkingProfiles` 的维护性 re-register 不获得所有权——否则每次 `refreshModelHealth` 都会把候选图变成他图 provider 的共有者，retention 永远无法注销。
- suspend（`retainGraph`）：独占 provider 注销并保存 **effective config**（含 thinking-profile 合并），共有 provider 保留；resume（`tryReactivateRetainedGraph`，fingerprint 匹配后）重注册；release（`disposeGraph`）不保存。
- owner 集合即引用计数：跨图共有（如 agentDir 级用户扩展在 A、B 都注册同 id）时最后一个 owner 离开才注销。
- 隔离粒度刻意停在 workspace：同 Workspace 的 retained/background Session 共享 workspace 扩展，per-session 注销会误杀并行 Session 正在使用的 provider。

**验收**：`workspace-package.integration.test.ts` 真实 Host A→B→A——A 的 `.pi` 扩展 provider 经 `model.list` 在 A 可见、在 B 不可见、回 A 恢复。破坏验证：注释 `retainGraph` 的 suspend 后，B 断言即红（`expected ['piabyss-iso-provider'] to not include ...`）。

另注意 `unregisterProvider` 同步清两个 map 并重组模型集合，但 `snapshot.configuredProviders` 的清理依赖其后异步 `void refresh({allowNetwork:false})`；对 `getRegisteredProviderIds` / `find` 的断言是同步可靠的，对 `getAvailable` 的断言需在 refresh 后。

## 12. Auth 解析要点（PR-4 测试对应）

- oauth 刷新的唯一写路径是 `credentials.modify()`（pi-ai `auth/resolve.js` `resolveStoredOAuth` 与 `models.js` `resolveRefreshCredential` 两处），回调内锁下二次校验：非 oauth → undefined、未过期 → undefined（= 保持现状，绝不能当删除）。PiAbyss store 的「undefined = unchanged」契约正是这两处依赖的；跨进程竞争由 proper-lockfile 串行化，输者在锁下看到新 token 后跳过刷新。
- api_key 凭证 SDK 端**不解析** `$VAR`/`!cmd` 模板（`envApiKeyAuth` 直接用 `credential.key`），模板解析是 PiAbyss store `read()` 的职责；models.json 里 provider 级 `apiKey`/`headers` 的模板则由 provider-composer 的 `resolveConfigValueOrThrow` 解析，null 值在此层直接抛错。
- null 头哨兵（「删除继承头」）只在 `Model.headers` 携带时到达请求边界，由 `getApiKeyAndHeaders` / `withoutDeletedHeaders` 过滤。
- header-only provider 存在 compat/stream 分歧：`getApiKeyAndHeaders` 走 `getCompatibilityRequestConfig` 兜底返回 `{ok:true, headers}`，而 `getAuth` 返回 undefined → `prepareRequest` 抛「Provider is not configured」。连接检查通过≠请求可用，`auth-compatibility.test.ts` 已钉住。
- compaction / branch-summary 经 `_getSummarizationRequestAuth` 取 auth，失败被吞成 `{}`；但 streamFn 是 SDK 构建的 `modelRuntime.streamSimple`，`prepareRequest` 会二次解析兜底。`summarization-auth.test.ts` 在 provider `streamSimple`（wire 边界）断言两类摘要请求都实际携带 key/headers。
