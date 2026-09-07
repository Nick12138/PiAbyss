# PiAbyss 独立全项目代码 Review（2026-07-27）

只读审查，未修改任何代码。未参考 docs/history/ 中的历史报告。

## 审查方式与覆盖声明

**方法**：阶段 0 由我本人读三份架构文档并扫描四层入口；阶段 1–4 由 13 个并行深审通道（3 边界 + 5 状态机 + 3 安全 + 2 测试体系）执行，共完整读取 108 个源文件；40 条候选发现逐条交给独立的「作者视角反驳」通道复核（4 条被反驳删除，36 条存活）；合并同根因重复后剩 **34 条独立发现**（高危 2 / 中危 15 / 低危 17）。两个高危及关键中危的代码锚点由我本人二次抽查确认。

**基线验证**：`pnpm typecheck` 通过；`pnpm test` 1230 个测试全绿（protocol 395 / desktop 411 / pi-host 424）。即：下文所有发现均不被现有测试拦截。

**我本人完整读过的文件**（阶段 0）：docs/architecture/{overview,process-boundaries,protocol}.md、package.json、packages/pi-host/src/main.ts（头部）；以及对高危/中危锚点的定点复查（pi_host.rs:20-30,960-1000、provider-journal.ts:118-135,200-230、workspace-lifecycle.ts:238-310、commands.rs:38-48、App.tsx:155-170、agent-controller.ts:300-310、session-lifecycle.ts:560-580）。**当时跳过**：docs/history/（任务禁止）、.planning/、notes.md、task_plan.md（scratch）、全部测试文件（留给阶段 4）、node_modules SDK（阶段 1–3 按需定点读）。

**明确未覆盖 / 只做了源码推理**：
- Windows 运行时行为（Job Object 清理、ConPTY、MoveFileExW）——只读代码未运行；仓库 bundle 目标为 nsis，Windows 恰是发布平台。
- Tauri IPC 传输 32MB emit payload 的实际行为。
- Rust `resolve_portable_git` 只探测 `git.exe`——非 Windows release 构建能否启动 Host 存疑（功能性，与 Windows-only 发布目标或许一致，仅记录）。
- 7 条置信度为 [待验证] 的发现（各条注明还缺什么运行时确认）。
- App.tsx 前 440 行的层内 reducer、渲染层组件未审（边界外）；SDK 内部为定点阅读而非全读。

## 总体评价

这套代码的**设计成熟度明显高于平均**：身份/修订号（hostInstanceId + workspace/session/packageRevision）体系贯穿三层并有机器生成的协议覆盖测试；出站队列的背压/合并/超限 shed 有完整文档和实现；进程树清理有单 owner CAS 防重复信号；凭据存储有跨进程文件锁和真实进程竞态测试。低级的注入、路径穿越、CSP 过宽问题几乎没有——安全面 review 确认 CSP 严格、无 innerHTML、远程 webview 零权限、所有 spawn 走 argv 数组。

但 34 条发现呈现三个**系统性模式**，比单点 bug 更值得关注：

1. **锁跨越无界 I/O（Rust 3 处、Node 3 处）**。`pi_host_send` 持管理器 mutex 跨无超时 stdin 写、PTY 写持锁、serviceGraphLock 跨网络刷新/无界目录遍历/无超时 abort。共同后果：一个卡住的下游把**包括恢复路径在内**的整个管理层永久楔死——Restart Host 按钮和退出应用恰好走同一把锁。
2. **异步窗口内的身份/代际不校验**。SDK 在 auth 检查、extension 前置钩子、pre-prompt 自动压缩完成之前 `isIdle=true`（可长达数秒到数分钟），至少 5 处代码把这个窗口当作「空闲」来 retain/剥离订阅/dispose；长 await 之后不重查身份就直接用当前图重建快照。
3. **恢复/回滚路径的破坏性默认值**。journal 恢复把「备份丢失」等同于「从未存在」并删除真实凭据；登录写凭据不持锁、与 journaled mutation 的全文件回滚不互斥；扩展激活回滚不检查被恢复的会话是否已被 dispose。

测试体系数量充足（1230 个）且协议层对抗性很强，但存在**结构性盲点**（详见测试体系评价）：Rust 生产监督路径零执行覆盖、SDK fake 无法表达 pre-run 窗口、App.tsx 组合分发未测——高危和中危发现几乎全落在这三个盲区里，解释了为什么它们能全部通过 CI。

---

## 高危

### H1. 协议帧无尺寸契约：>32MB 单行响应让 Rust 杀掉健康的 Host，并烧掉唯一一次自动重启

- **位置**：`apps/desktop/src-tauri/src/pi_host.rs:23`（32MB 常量；杀进程在 pi_host.rs:968-983）；无界写入端 `packages/pi-host/src/outbound-queue.ts:124`（响应「永不合并永不丢弃」）；无界快照 `packages/pi-host/src/session-snapshot.ts:70-72`
- **触发序列**：用户在一个会话中积累 >32MB 序列化内容——可达，因为 Composer 允许每条消息 4×5MB 原图（≈27MB base64），`validate.ts:74-85` 的 validateImages 不限制尺寸，且快照把 messages+entries 双份序列化（一条顶格消息 ≈56MB）。下一次 `session.open`/`system.rehydrate` 响应或 `session.snapshot` 事件序列化为单行 >32MB → 出站队列整行写出 → Rust `read_bounded_utf8_line` 返回 InvalidData → stdout 任务 break → `force_cleanup_unix_host_group` **杀掉仍然健康的 Host 整个进程组** → 合成 host.fatal → 一次性自动重启。`restoreLastSession` 开启时恢复循环重开同一个超大会话 → 新 Host 的响应再次 >32MB → 再被杀 → 自动重启额度耗尽。
- **后果**：进程崩溃 → 实质挂死。该工作区对这个会话永久不可用，直到用户关闭会话恢复或手动删除会话文件。16–32MB 区间队列设计的 shed-and-rehydrate 尚能工作；>32MB 时 rehydrate 响应本身就超限，**恢复在结构上不可能**。
- **严重级**：高。**置信度**：已在代码确认（未实跑 32MB 快照，但机制全程静态可追；尺寸数学基于 Composer 上限）。

### H2. journal 恢复把「auth.json 备份丢失」当作「从未存在」，静默删除全部已存凭据

- **位置**：`packages/pi-host/src/provider-journal.ts:211`（`readFile(authBackup).catch(() => null)`）；`credential-store.ts:224-228`（content:null → unlink 真实 auth.json）；`provider-journal.ts:125` 的 `auth.absent` 标记**只写不读**——grep 全仓仅这一处引用
- **触发序列**：任一 provider mutation（save/remove/logout）期间 Host 崩溃或机器断电，使 journal.json 落盘而 auth 备份未落盘（journal 路径全程无 fsync，跨文件持久顺序依赖文件系统）；或备份在下次启动时不可读（EACCES/损坏/杀毒隔离）。下次启动 `recoverProviderJournals` → 备份读取失败被 catch 成 null → `restore({content:null})` 删除真实的 `~/.pi/agent/auth.json` → 不进 failures[] → 报 `restored:true` → 健康状态显示 recovered 而非 degraded。
- **后果**：静默数据错误——所有 provider 的 API key 和 OAuth token 被删，无任何告警，用户被静默登出；专门为区分「文件本不存在」与「备份丢失」而设计的 auth.absent 标记在读侧是死代码。
- **严重级**：高。**置信度**：已在代码确认（断电窗口有条件性，但 EACCES/损坏/隔离路径无条件成立）。普通进程崩溃下 OS 页缓存会救场（begin 先写备份再写 journal），这缩小但不消除触发面。

---

## 中危（按主题归并）

### A. 进程监督与锁（Rust ↔ sidecar ↔ 前端）

**M1. `pi_host_send` 持 PiHostManager mutex 跨无超时 stdin 写：sidecar 停止读 stdin 时永久死锁，且 Restart Host 与退出应用同归于尽**（合并两条独立报告）
- 位置：`apps/desktop/src-tauri/src/commands.rs:42`（持锁跨 await）+ `apps/desktop/src-tauri/src/pi_host.rs:1169-1180`（write_all/flush 无超时）
- 触发：Host 的 Node 事件循环停止 drain stdin——同步阻塞的工作区扩展（扩展在 Host 进程内执行）或 `main.ts:305-329` 启动预载窗口（server.start() 前故意不读 stdin）——前端再发够填满 64KB 管道的内容（一条带大图粘贴的 agent.prompt 就够）。写永久 Pending 且持锁：Restart Host（start_unlocked 也需 host.lock()）、状态轮询、settings patch、`RunEvent::Exit` 的退出路径（lib.rs:149）全部卡死；`shutdown()` 自己的 send_line（pi_host.rs:1200）同样无界。
- 后果：**挂死**——包括 UI 提供的唯一恢复手段（Restart Host）和应用退出；前端 30s JS 超时只 reject promise，Tauri invoke 不可取消，Rust future 持锁永远挂着。直接违背 pi_host.rs:1336-1337 的明示设计目标（「sidecar 挂起时 IPC 与退出保持响应」）。
- 严重级：中（原报高，下调：需要 sidecar 先进入不读 stdin 状态）。置信度：已确认。

**M2. 单行 stderr 超 1MB：Rust 永久关闭子进程 stderr 管道但不杀子进程，Host 下次写日志时 EPIPE 退出**
- 位置：`apps/desktop/src-tauri/src/pi_host.rs:910`（Err 分支 break，reader 被 drop）；`pi_host.rs:24`（1MB 常量）
- 触发：sidecar（logger 的无上限 meta、SDK、进程内扩展）写出一行 >1MB stderr → 读任务报错退出并 drop 掉唯一的管道读端 → 不杀不重启子进程（与 stdout 路径不对称）→ Host 下一次 stderr 写（logger 几乎每个操作都写）撞上 EPIPE，process.stderr 无 error 监听 → uncaughtException → main.ts:286-292 exit(1) → 被当作崩溃，消耗一次性自动重启。
- 后果：**进程崩溃**（所有在途 agent 工作丢失）+ 烧掉自动重启；若某平台 EPIPE 链不触发，则退化为诊断信息全丢而 Host 表面健康。
- 严重级：中。置信度：[待验证]——Rust 侧弃管已在代码确认；Node EPIPE→exit(1) 升级链需运行时确认（造一行 >1MB stderr 再触发任意 logger 调用）。

**M3. Rust 合成的崩溃 host.fatal（硬编码 sequence=1）被前端序号去重丢弃：启动后的意外崩溃永不显示 Host 不可用横幅**
- 位置：`apps/desktop/src/app/App.tsx:162`（noteSequence 先于 switch）；`apps/desktop/src-tauri/src/pi_host.rs:1021`（合成帧 sequence 1）
- 触发：首次 rehydrate 后 `lastSequence ≥ 1`（正常状态）→ sidecar 意外崩溃 → Rust 发 sequence=1 的合成 host.fatal → HostClient 正确拒绝在途请求，但 App 的 handleHostEvent 先过 noteSequence(1) 得到 "drop" → `case "host.fatal"`（唯一设置 hostFatal 横幅+通知的路径）永不执行。
- 后果：**静默数据错误（UI 状态错）**——一次性自动重启已消耗或被用户关闭时，UI 在死 Host 上继续显示健康；Sidebar/SessionList 的门控读取 hostFatal 保持开放。直到用户下一次请求撞上死管道才暴露。
- 严重级：中。置信度：已确认（相邻两层各自有测试，组合无人测——见测试评价）。

**M4. `shell_terminal_write` 持 ShellTerminalManager mutex 做阻塞式 PTY 写：满输入缓冲让全部终端命令（含能解围的 close）循环等待**
- 位置：`apps/desktop/src-tauri/src/shell_terminal.rs:204`（阻塞 write_all）；`apps/desktop/src-tauri/src/commands.rs:82`（持锁）
- 触发：终端里跑不读 stdin 的前台程序（如 `sleep 1000`），用户粘贴大段内容。内核 PTY 输入队列（KB 级）填满 → 同步 write_all 阻塞且持管理器锁 → close/resize/create 都需要同一把锁（循环等待）；应用退出在 lib.rs:146 同样卡住。Ctrl+C 也走这条被堵的写路径。
- 后果：**挂死**——所有 dock 终端冻结、无法关闭（前端 `.catch(()=>{})` 吞掉），应用无法退出。
- 严重级：中。置信度：已确认（portable-pty 0.9 的 writer 是无 O_NONBLOCK 的裸 fd）。

### B. pi-host 会话/代理状态机

**M5. 会话切换把「已提交但未进入运行」的 prompt 当空闲：剥离事件订阅或中途 dispose 会话**
- 位置：`packages/pi-host/src/session-lifecycle.ts:852`（unguarded retain/dispose，851-870）；同类在 createSession:588、session-runtime-cache.ts:466-484,606-622
- 触发：用户对会话 A 发 prompt，agent.prompt 持有 A 的 AgentOperationLock 并返回 accepted；但 SDK 在 auth 检查、before_agent_start 扩展钩子、**pre-prompt 自动压缩（一次完整 LLM 调用）**完成前 `_isAgentRunActive=false`，即 `isIdle=true` 窗口可达秒级到分钟级。此时用户点开另一会话：openSession 持 serviceGraphLock，retainBusySession 因 A「空闲」返回 null → 走到 851-868：retainIdleSession 无条件下掉 A 的 agent 事件订阅（从不检查 operationLock），或更糟——若 A 的运行在切换期间开始了——直接 `disposeAgentSessionOnly` 中途 abort+dispose。
- 后果：**静默数据错误**——用户已获 accepted 的运行被无声 abort，或完全无人观测地执行（无任何事件发布，hasBusySessions=false，工具副作用已发生但不可见）；LRU 挤兑时甚至中途 dispose 正在跑的会话。
- 严重级：中。置信度：已确认（窗口在打过 patch 的 SDK dist 中逐行核实；最小情形下微任务原子性可救场，但自动压缩是长会话的常规路径）。

**M6. 扩展激活回滚把已被 agent_settled 定时器 dispose 的旧会话复活为活动会话**
- 位置：`packages/pi-host/src/session-lifecycle.ts:573`（createSession 回滚 `commitActiveSessionState(g, identity, prev)`；openSession:837 同型）
- 触发：A 运行中 → session.create 把 A 驻留后台、提交候选 B、`await activateExtensionUi`（等扩展 session_start，可挂数秒）→ 该 await 期间 A 运行结束，settle 定时器（不持 serviceGraphLock）dispose 掉 A → activate 抛错 → 回滚把**已 dispose、已退订**的 A 恢复为 g.agentSession 并回滚身份。
- 后果：**静默数据错误**——活动会话是一具尸体：后续 prompt/steer 失败或静默无效，快照停止更新；客户端收到 SESSION_SWITCH_FAILED 仍以为 A 活跃，卡到手动切换。
- 严重级：中。置信度：已确认（回滚侧从不检查 prev 是否仍驻留/未 dispose）。

**M7. delete/archive/rename 只失效当前图的运行时；同 cwd 驻留图在 LRU 中保有活 SessionManager，重激活时已删会话复活**
- 位置：`packages/pi-host/src/session-lifecycle.ts:224`（unlink）；`workspace-lifecycle.ts:361-368`（指纹不含 sessions 目录）、`:474`（重激活不查会话文件存在性）
- 触发：`workspace.setCurrent(A)` 在 A 已是当前时被接受（无同 cwd 防护）→ 旧 A 图（其空闲会话 S 指向文件 X）被驻留 → 在新图上 `session.delete(X)` 删文件（驻留图的内存态不受影响）→ 再次 setCurrent(A)：重激活指纹只扫 `.pi`、settings/models/auth、包目录，**不含 sessions 存储目录** → 驻留图通过校验，S 复活为活动会话，下一条持久化 append 把 X 重新写回磁盘。
- 后果：**静默数据错误**——用户显式删除的会话复活；archive 变体产生两份发散副本；rename 丢失。
- 严重级：中。置信度：已确认（前端 WorkspacePicker 的字符串比较挡不住非规范拼写，且协议层本就该自持）。

**M8. `startDetachedPrompt` 在 detached IIFE 创建前同步抛错 → AgentOperationLock 永久泄漏，会话永远 AGENT_BUSY**（合并两条独立报告）
- 位置：`packages/pi-host/src/agent-controller.ts:305`（无 try/catch 的调用点）+ `:84`（同步 `setActiveSessionName`）；唯一 release 在 IIFE 的 finally（:121）
- 触发：对一个**有持久化历史但未命名**的会话发 prompt（纯图片首条消息即可造成：有历史但无 session_info 条目），且会话文件不可写（磁盘满/权限/目录被删）：:84 同步走 SDK `setSessionName → _persist → appendFileSync` 抛错 → IIFE 尚未创建，finally 不会跑；`setPhase("agentBusy")` 已执行。对比：agent.runNow 有 try/catch（718-729），compact/navigateTree 有 try/finally。
- 后果：**挂死**——该会话的 AgentOperationLock 被一个失败请求 id 永久持有：后续 prompt/compact/navigateTree 全部 AGENT_BUSY，runNow 2s 超时，reload/rename/setCurrent 被 isHeld 检查挡住；只能切走再切回恢复。一次磁盘错误静默废掉当前会话。
- 严重级：中。置信度：已确认（SDK `_persist` 同步 appendFileSync 无内部 try/catch；锁无 TTL 无看门狗）。

**M9. `ready`（bindExtensions）promise 在 activate() await 之前无 rejection 处理器：候选丢弃窗口内的拒绝变成 unhandledRejection，整个 Host 致命关闭**
- 位置：`packages/pi-host/src/extension-ui-bridge.ts:784`（`.then` 只有 onFulfilled；唯一观察者是 activate() 内的 `await ready`，:811）
- 触发：bindForCandidate 立即发起 bindExtensions；三个窗口里 activate 尚未/不会被调用：(a) buildServices 在 bindForCandidate(:749) 与 activateOnce(:279) 之间 await 数秒的 buildPackageSnapshot；(b) tryReactivateRetainedGraph 同类窗口；(c) createSession/openSession 的 throwIfAborted 丢弃路径。此间 bindExtensions 因扩展提供的坏资源路径（extendResources/resolvePath 抛错——SDK 只吞 handler 异常，不吞扩展返回数据的后处理）而拒绝 → main.ts:275-284 把 unhandledRejection 路由到 requestFatalShutdown。
- 后果：**进程崩溃**——本应优雅返回 WORKSPACE_SWITCH_FAILED 的场景变成整个 Host 致命关闭，杀掉所有会话和后台运行。
- 严重级：中。置信度：[待验证]——窗口与无处理器已在代码确认；还需运行时证明 bindExtensions 的可达拒绝路径（注册返回不可读 skill 路径的 resources_discover 扩展即可确认）。

**M10. 登录流程写凭据不持 serviceGraphLock：并发 journaled mutation 的全文件 auth.json 回滚把刚拿到的凭据静默抹掉**
- 位置：`packages/pi-host/src/provider-controller.ts:1249`（runLoginFlow await modelRuntime.login，无锁）；journal begin/rollback 在 :1382/:1418
- 触发：用户开始 OAuth 登录（浏览器流程数分钟，全程不持锁；activeLogin 只有 loginStart/Respond/Cancel 检查，save/remove/logout/setEnabled 都不查）→ 登录完成前另一请求跑 provider.save：journal.begin 快照**整个** auth.json → 登录凭据写入 → save 在 commit 后失败（如 Pi CLI 持锁导致 lock_timeout）→ journal.rollback 用登录前的快照整文件覆写。Host 崩溃场景下，下次启动的 recoverProviderJournals 同样恢复旧快照。
- 后果：**静默数据错误**——UI 已显示登录成功，凭据却已从磁盘删除；登录流程还可能顺手 enable 了 provider，留下「已启用但无凭据」。
- 严重级：中。置信度：已确认（文件锁只串行单次读/写，快照→回滚的跨段不互斥；restore 不做新鲜度比较）。

### C. 跨工作区与包管理

**M11. 新工作区的扩展在旧工作区仍持有 provider 时完成注册：SDK 合并把 A 的 apiKey 并进 B 的注册，ownership 层随后拒绝注销**
- 位置：`packages/pi-host/src/workspace-lifecycle.ts:306`（旧 owner 直到这里才 suspend；incoming 注册早在 :243 buildServices → :699-710 runAsOwner 完成）；retained 路径同序颠倒（:484 vs :583）
- 触发：工作区 A 的扩展注册了带真实 apiKey 的 provider "X" → 切到工作区 B：B 的扩展用 partial config（只有 baseUrl 指向攻击者端点）注册同名 "X" → ModelRuntime.registerProvider 的 merge 语义（undefined 字段保留旧值）使 "X" = A 的 apiKey + B 的 baseUrl，owners={A,B} → 之后 retainGraph(A) 的 suspendOwner 拿到的是**已合并**配置，且因 holders 非空拒绝注销 → B 的 agent 带着 A 的 key 流向攻击者端点 → 切回 A 时 resumeOwner 重放被污染的快照，A 的 provider 永久带上 B 的 baseUrl。
- 后果：**静默数据错误（跨工作区凭据泄露 + 持久 provider 投毒）**——正是 extension-provider-ownership 模块头注释声称要隔离的场景。
- 严重级：中（原报高，下调：需要两个工作区都装注册同名 provider 的扩展；但 triggered 后后果是凭据外发）。置信度：已确认（顺序在代码中逐行核实；co-ownership 测试 pin 的是原语语义，不构成对此顺序的背书）。

**M12. 用户态包的 package.update 连带更新同身份的项目态包：在未获项目授权的情况下向 `<workspace>/.pi/npm` 执行 npm install**
- 位置：`packages/pi-host/src/package-controller.ts:1021`
- 触发：同一 npm 包同时存在于用户级和项目级 settings（快照会发出 user-shadowed + project-effective 两条记录）→ 用户在 Packages 页选中 **user 作用域**那条点 Update：UI 的 isProjectMutation 只看该记录作用域 → 不弹项目确认 → Host 执行 `pm.update(rec.source)`，SDK 的 `getPackageIdentity` 不带作用域（npm/git 身份跨 scope 相同）→ 两条都被匹配 → updateConfiguredSources 对项目侧跑 `npm install foo@latest --prefix <cwd>/.pi/npm`，执行其生命周期脚本并写入工作区目录。
- 后果：**静默数据错误**——以用户态确认的名义完成了项目态的拉取+安装+脚本执行，绕过 UI 对所有其他项目态包操作设立的确认门。
- 严重级：中。置信度：已确认（shadowed 记录在 UI 真实可选；assertProjectTrustedForScope 只查工作区级 trust，替代不了逐操作确认门）。

**M13. retainGraph 对整个 `<workspace>/.pi` 树做无界、串行、不可取消的递归指纹遍历，且全程持 serviceGraphLock**
- 位置：`packages/pi-host/src/workspace-lifecycle.ts:400`（注意：此处不传 AbortSignal，与 :462 的重激活调用不一致）；`package-controller.ts:90-140` 同型（每次包变更对同样的 npm/git 根扫两遍）
- 触发：工作区装过任意项目态 npm 包（`<W>/.pi/npm/node_modules` 可达数万到数十万文件）→ 切换工作区 → retainGraph 逐个 await lstat+readdir，无深度/条数/时间上限，全程持锁 → 期间所有图操作 SERVICE_GRAPH_BUSY；此时请求 shutdown 的话 quiesce 取消信号无处观测，遍历跑到完，可能错过 quiesce 期限。
- 后果：**挂死（有界但不可控的停顿）**——工作区切换和每次包变更卡顿时长等于 stat 整个安装树的时间。
- 严重级：中。置信度：机制已确认；[待验证] 仅为量级（秒级还是分钟级取决于安装树大小）。

### D. 日志与前端渲染

**M14. `redact()` 能把合法 JSON meta 变成非法 JSON（连引号一起替换掉整个带引号的 secret 值），log() 抛 SyntaxError 崩掉调用路径**
- 位置：`packages/pi-host/src/logger.ts:35`（无 try/catch 的 `JSON.parse(redact(JSON.stringify(meta)))`）；吞引号的正则 :20
- 触发：任意 logger 调用的 meta 含「整个值就是 sk-/key-/Bearer 前缀 token」的字符串字段，且序列化后的 meta 任意位置出现 token/secret/apikey 等关键词——实际执行验证：`{message:"invalid token", detail:"sk-abcdef123456"}` → redact 产出 `{"detail":[REDACTED]}`（引号被反向引用吃掉）→ JSON.parse 抛 SyntaxError。在 detached 异步路径里变成 unhandledRejection → requestFatalShutdown；若发生在 unhandledRejection 处理器自身的 logger.error 里，直接 uncaughtException 退出。
- 后果：**进程崩溃**——一次「想记录凭据形状错误」的日志调用杀掉或致命重启 Host，原始日志也丢失。
- 严重级：中。置信度：已确认（用真实正则管线在 node 中执行复现；请求处理器路径有 dispatch catch 兜底，detached 路径和进程级处理器没有）。

**M15. `reuseStableRows` 把 live 流行 key 永久收养到持久化行上：压缩使 messages 数组收缩后，新 live 尾行与旧收养 key 碰撞，同帧出现重复 React key**
- 位置：`apps/desktop/src/features/chat/transcript-model.ts:1214`（key 改写）；`:1206-1209`（bySourceId 永久再收养）；渲染处 `Transcript.tsx:233`
- 触发：正常流式轮次的尾行 key 为 `assistant:stream:N`（N=messages 绝对下标）→ agent_settled 快照把同一消息变成 entry-keyed 行时发生收养，旧 stream key 被永久改写/再收养（内容变了也不还）→ 压缩后 messages 收缩为 [summary, kept...]，新流式下标从小数重新开始，而被保留行仍带着压缩前的大下标收养 key → 数组长回旧下标 N 时，新尾行 byKey 命中旧收养行、rowEquivalent 失败、两行同 key 同帧渲染。
- 后果：**静默数据错误（UI）**——React duplicate-key 告警， reconciliation 可能丢行或把 ExecutionTrace/ThinkingBlock 的开合状态串到另一轮——恰好发生在本应用主打的超长压缩会话场景。
- 严重级：中。置信度：已确认（机制静态可追；复现需要压缩过的长会话）。

---

## 低危（按主题归并）

### 边界 / Rust

- **L1 `commands.rs:245`：macOS 上 `desktop_open_path` 对 .app bundle 执行 `open <dir>` 等于启动该应用**，而不是在 Finder 中显示。Files 面板的「Open folder」按钮（FilesPanel.tsx:263-272）对任何目录条目可达；分类逻辑（commands.rs:212-214）只看 `is_dir()`。原报高危，下调理由：渲染进程本就持有 shell_terminal_* 这一更大原语（任意命令执行是设计内能力），且工作区内容按文档化策略已被信任——剩余实质缺陷是「按钮做的不是它说的事」+ commands.rs:187-189 注释夸大了保证。一行修复（目录改用 `open -R`）。静默错误动作，已确认。
- **L2 `pi_host.rs:1258`（及 :1138、:1204-1208）：多条清理路径先 reap 子进程再向进程组发信号**，留出 pid 复用窗口——若内核把该 pid 分给新的进程组组长（PiAbyss 自己就在并发制造组长：新 Host、PTY 终端），SIGKILL/SIGTERM 落到无关进程组。cleanup_claimed CAS 只防重复信号，不防 signal-after-reap。仅理论风险（需要 pid 计数器回绕恰好落在微秒窗口内），已确认。
- **L3 `capabilities/default.json:23`：`shell:allow-open` 的 URL allowlist 是死的**——tauri-plugin-shell 2.3.5 的 open 命令从不解析 ACL scope（只读 tauri.conf.json 的 `plugins.shell.open`，而这里是 `"plugins": {}`），且 `{"url":...}` 条目本身不符合 ShellScopeEntry schema。实际生效的是插件内置默认正则（mailto:/tel: 也被允许）。无注入后果（open-5.4.0 走 argv/环境变量），但声明的策略与实际策略不一致且会随插件升级静默漂移。仅理论风险，已确认。

### 前端

- **L4 `apps/desktop/src/lib/desktop-settings.ts:56`：desktop_settings_patch 的任何失败被为浏览器 mock 写的裸 catch 吞掉，按乐观成功应用到本地 store**（SettingsPage.tsx:66 同型）。真实桌面运行时里磁盘满/权限/rename 失败走同一路径：UI 显示新设置，磁盘和 Rust 内存仍是旧的，重启后静默回退，且 agentDir/autoRestart 到 PiHostManager 的传播从未发生。静默数据错误，已确认。
- **L5 `BrowserPanel.tsx:210`：navigate() 在 invoke resolve 之后才 setLoading(true)**，与 webview 的 load Started/Finished 事件无顺序保证——秒开页面（about:blank/缓存页/localhost）可能先处理 Finished(false) 再执行 setLoading(true)，loading 永远卡住，按钮停在 Stop。静默 UI 状态错。[待验证]：Tauri 事件与 invoke 响应的实际顺序需运行时日志确认。
- **L6 `host-client.ts:102-105`：协议校验失败的响应被静默丢弃（无任何日志、不 settle pending），而 agent.prompt/agent.compact 以 timeoutMs=null 发送**——前后端 protocol 版本错位（本仓「dist 需手动重建」的工作流使错位常态化）时，一条非法响应让发送/压缩 promise 永久 pending：草稿不恢复、无错误提示、零诊断输出。挂死（直到 Host epoch 终结），已确认。
- **L7 `transcript-model.ts:725`：projectedMessageCount 无条件计入 branch_summary，而 SDK 仅在 summary 非空时把它投影进 messages**——空 summary 的 branch_summary（SDK 公共 API branchWithSummary 不校验非空）使 tailStart 多算 1，整轮运行期间刚发出的用户气泡被吞掉，settle 后才出现。静默 UI 数据错。[待验证]：真实会话文件出现空 summary 的频率。
- **L8 `transcript-model.ts:837`：工具结果经单一 session 级 Map（key=toolCallId, last-write-wins）关联工具调用**——OpenAI 兼容后端复用 id（如每条 assistant 消息从 `call_0` 重新计数）时，所有同 id 工具卡都链到全 session 最后一个结果，早轮结果显示错误的输出/状态。静默数据错误。[待验证]：所支持的 provider 中是否确有跨轮复用 id 者（SDK 原样透传 id，无归一化）。

### pi-host 状态机

- **L9 `agent-controller.ts:419`：agent.abort 只看 `session.isIdle`，对 pre-run 窗口（auth/扩展/pre-prompt 压缩）中的已提交 prompt 是静默 no-op**——返回 `{aborted:false, settled:true}` + idle 快照，前端据此隐藏运行状态，而被提交的运行照常启动（LLM 花费、工具副作用）。对比 agent.runNow 额外用 operationLock 守护。静默数据错误，已确认。
- **L10 `agent-controller.ts:824`：agent.compact 在长 LLM await 后不重查身份**，用彼时的活动会话 B 重建快照、覆写 `g.sessionSnapshot`（不持锁），响应被贴上 B 的身份——违反 never-relabel 规则（server.ts 的 relabel 守卫因 handler 不设 outcome.identity 而旁路）。前端恰好用 request-generation 守卫丢弃它，所以表现为「用户得不到任何反馈，而 A 已在后台被压缩」。静默数据错误，已确认。
- **L11 `session-runtime-cache.ts:253`：disposeAgentSessionOnly 无超时 await `session.abort()`，调用方持 serviceGraphLock**——agent_settled 扩展 handler 永不 resolve 时整个图楔死，后续一切图操作永久 SERVICE_GRAPH_BUSY。同文件 :245 的 session_shutdown emit 同样无界（空闲会话也可触发）。agent-controller.ts:48-49 明知此险并对 abortAndWait 设了 15s 上限，dispose 路径漏了。挂死。[待验证]：SDK 对 agent_settled 是否确无超时（读 runner.js 未见，但需运行时坐实）。
- **L12 `session-runtime-cache.ts:411`：announceRetainedRuntime 硬编码 `state:"running"` 且在长 activateExtensionUi await 之后才发**——其间已 settle 的会话先发了正确的 "idle"，再被这条过期 "running" 覆盖（且绕过 runtimeStates 去重，不自愈）；已 dispose 的运行时也会收到。会话列表徽标永久错误。静默 UI 状态错，已确认。

### provider / 凭据 / 日志

- **L13 `provider-controller.ts:1897`：provider.logout 在持 serviceGraphLock 期间触发 SDK 内部的联网模型刷新**（ModelRuntime.logout → refresh({allowNetwork:true})，无 signal 无超时；`allowModelNetwork:false` 只关 create 时那一次）。目录端点黑洞时卡到 undici 默认超时（约 300s）：期间一切图操作 SERVICE_GRAPH_BUSY，shutdown 超过 8s quiesce 期限以退出码 1 不干净退出。违背本文件自己的纪律（其它 mutation 全走 refreshModelsLocal）。挂死（有界但分钟级），已确认。
- **L14 `provider-controller.ts:1285`：provider.list 是全文件唯一无锁调用 refreshRegistry + 读 models.json 的入口**（dispatch 是逐行并发）——可与 mutation 的 commit/rollback 窗口交错，把即将被回滚的瞬时配置返回给 UI（models.json 不受任何 revision 保护，无 STALE_REVISION 兜底），极端交错下运行时停留在旧合成直到下一次刷新自愈。静默数据错误（瞬时、自愈），已确认。
- **L15 `provider-controller.ts:409`：每次 commitModelsConfig 生成一个唯一命名的 `models-<ts>-<rand>.bak`，全仓无任何清理**——每次 provider 变更（含登录后自动启用、checkConnection 后 authHeader 持久化）留一个文件，在使用寿命内无界堆积在共享的 `~/.pi/agent`。仅理论风险（缓慢磁盘/inode 消耗），已确认。
- **L16 `logger.ts:22`：结构化 meta 的脱敏对其主要输入形态无效**——key-value 正则匹配不到 JSON 序列化形态（`"apiKey":"v"` 中 key 名与冒号之间隔着引号），值前缀正则只认 sk-/key-/Bearer。今天没有调用点往 meta 传原始凭据（已逐一核查），所以是纵深防御失效而非现役泄露；但 stderr 会被 Rust 原样转发给前端 webview 并留在 50 行崩溃尾部里。仅理论风险，已确认（用真实管线执行验证）。
- **L17 `credential-store.ts:333`：ensureFileExists 在 advisory lock 外做无串行的 `writeFileSync("{}")`**——首跑机器上，PiAbyss 用 `openSync("wx")` 创建空文件后到写 "{}" 之前的毫秒窗口里，共享此文件的 Pi CLI 可正常持锁写入真实凭据，随后被这次无锁覆写截断。窗口小、仅首跑，但写本身就是多余的（空文件经 readRoot 已等价于 {}）。静默数据错误，已确认。

---

## 测试体系评价

**数量**：1230 个测试全绿。**强项是真实的**，不是 happy-path 充数：

- 协议层对抗性覆盖堪称样板：protocol-coverage 对每个 HostMethod 机器生成正/反参数用例和多余上下文字段拒绝，对每个 HostEventName 生成正/缺字段信封；validate.test 覆盖 NaN/function/undefined 投毒、不一致 rehydrate 身份。
- STALE_REVISION 在多层有真实测试：真实 spawn 的 Host 上的错误 hostInstanceId、A→B→A 重激活后旧上下文保持 stale、relabel 屏障。
- 关机/quiesce 失败路径、包操作超时/取消（杀真实 npm 子进程）、锁的 waiter 移交/错误属主释放、出站队列背压、凭据存储的跨进程真实竞态、journal 多类回滚——都有。
- 前端：HostClient 身份过滤、合成 fatal 处理、epoch reducer、原子 rehydrate 重放、transcript reducer 的流式/压缩/工具追踪——覆盖良好。

**但有三个结构性盲点，高危/中危发现几乎全部落在里面：**

1. **Rust 生产监督路径零执行覆盖**。pi_host_tests.rs 从不构造 PiHostManager——所有「崩溃/关机/清理」测试跑在 HostChildSession 上，那是一束**重新实现** spawn/shutdown/kill 的同步测试线束，与生产代码只共享几个小 helper。begin_start/complete_start 的代际 supersede、send_line、shutdown() 的 10s 升级、cleanup_dead_child、begin_auto_restart_after_crash、两个 monitor 任务（含合成 host.fatal 的那段 JSON）——从未在任何测试里执行过。M1/M2/H1 和 L2 全在这个盲区；「Rust 测试全绿」对应用实际运行的代码没有任何说明力。最具讽刺意味的是：唯一的 32MB 测试断言的是**常量的数值**，把行为编码成了数字而不是测试其后果。
2. **SDK fake 无法表达 pre-run 窗口**。单测用 plain-object AgentSession fake（isIdle 可写、方法都是 vi.fn()），表达不了「isIdle=true 但 prompt 已提交」（auth/扩展/pre-prompt 压缩窗口）、setSessionName 的同步抛错 appendFileSync、compact 期间 isIdle 仍为 true、bindExtensions 的拒绝时机。M5/M8/M9/L9/L10 因此结构性不可见——每条恰好躺在测试把长 await 折叠为零的地方。
3. **App.tsx 的组合分发未测**。HostClient 交付合成 fatal（有测）+ noteSequence 去重（有测）→ 组合后 sequence=1 被 drop（M3）——两层各自测试给出虚假信心，组合无人测。scheduleRecovery 循环、transport 修复看门狗同样只在 rehydrate 重放切片下有测。

**具体缺失场景**（每条都对应确认发现，均可写成确定性测试）：

- journal 恢复：备份文件单独丢失/不可读（journal.json 完好）→ 断言不删除 auth.json 且报 degraded。现有 4 类 journal 测试恰好绕过这一形态。（H2）
- agent.prompt：让 fake 的 setActiveSessionName 抛错 → 断言锁被释放。现有测试从不让该方法抛错。（M8）
- 会话切换：fake「operationLock 持有 + isIdle=true」组合后做 session.open/create → 断言不剥离订阅/不 dispose。现有 fake 的 isIdle 是静态布尔。（M5）
- abort/compact：abort 打在 lock-held-but-idle 窗口；compact 在 resolve 前换掉 graph.agentSession。现有测试里 compact 同步 resolve。（L9/L10）
- 回滚 × settle 定时器：两条各自有测的路径从不同时触发。（M6）
- 删除会话 → 同 cwd 驻留图重激活 → 列会话。指纹测试只改 .pi/extensions 和 models-store.json。（M7）
- bindExtensions 在 activate 之前拒绝 → 断言无 unhandledRejection 逃逸。现有只测 awaited 路径。（M9）
- PiHostManager 生产路径：不读 stdin 的 fixture + 大 payload send_line + tokio timeout 断言（M1）；>32MB stdout 行后继续服务的 fixture 断言 Host 不被杀（H1）；>1MB stderr 行后再写日志断言存活（M2）。read_bounded_lossy_line 的超行错误分支连单测都没有（只有 invalid-UTF-8）。
- handleHostEvent 组合：lastSequence≥1 后派发生产形态的合成 host.fatal → 断言 hostFatal 被设置。（M3）
- 合成信封的跨端契约：Rust 手写的 fatal JSON 与前端手写的 sentinel 匹配逻辑各测各的，无共享 fixture——M3 正是这个契约已经悄悄破掉的证据。
- 真实 Host 的 agent 失败事件流（auth 错误 → runtime error → 恢复 idle）：唯一的真 Host prompt 测试明确「不读 agent.event」。前端依赖的整个错误上报面零端到端断言。
- 畸形传输输入打真实 server（非 JSON 行/标量行/重复 id）：协议拒绝只在纯函数层测过，wire 级错误路径零覆盖。
- package.update：全仓没有任何 update 测试（unit 或 integration），scope 交叉场景自然没有。（M12）
- logger 模块无直接测试文件：M14/L16 两条发现位于零测试模块。
- transcript-model 三个边界：压缩收缩后的 key 唯一性、空 summary branch_summary、跨轮复用 toolCallId——932 行测试文件全部使用全局唯一 id 和增长方向消息数组。（M15/L7/L8）

## 建议修复顺序

**立即**（会丢用户凭据/数据，或让应用永久楔死，且修复都小）：
1. **H2** journal 恢复：restore 前查 auth.absent 标记；备份读取失败必须进 failures[] 并报 degraded，禁止 content:null 的静默 unlink。
2. **M8** startDetachedPrompt：把 :72-84 的同步段包进 try，失败时释放 operationLock 并复位 phase（对齐 runNow 的写法）。
3. **M1** pi_host_send：send_line 加写超时（或将 stdin 写入移出管理器 mutex，用每子代 channel）；shutdown 的 send_line 同理。
4. **M9** bindExtensions 的 ready promise 在创建处即挂 rejection 兜底（`ready.catch(()=>{})` 存根，activate 仍 await 原 promise）。
5. **M6** 激活回滚前检查 prev 是否仍在 backgroundSessions 且未 dispose；settle 定时器的 dispose 路径纳入 serviceGraphLock 或至少做 isHeld 检查。

**发版前**（正确性/恢复性契约）：
6. **H1** 帧尺寸契约：host 侧对 response/event 行设上限（超限降级为错误响应或强制 rehydrate），或 Rust 侧对超行只丢帧并通知而非杀进程组；同时在 validate.ts 给 images/消息设尺寸上限，快照侧对超长内容截断。两侧任选其一都不够——契约要成文。
7. **M5 + L9 + L10** pre-run 窗口：retainIdle/dispose/abort 前统一查 `getSessionOperationLock(id).isHeld()`；或推动 SDK 在 prompt() 入口即置 run-active。
8. **M10** 登录流程纳入 serviceGraphLock（或与 journal mutation 互斥），rollback 前与活动登录协调。
9. **M11** workspace-lifecycle：先 suspend 旧 owner 再 buildServices（调整 :243/:306 顺序）；resumeOwner 重放前校验快照未被合并污染。
10. **M12** package.update 在 host 侧按 identity 过滤跨 scope 目标，或把「连带更新哪些记录」如实返回给 UI 纳入确认文案。
11. **M3** 合成 host.fatal 走绕过序号去重的专用通道（或发单调递增的特殊序号）。
12. **M2** stderr 超行：截断而非弃管（与 stdout 对称的恢复策略）。
13. **M14 + L16** logger：redact 产出做 try/catch 兜底；改用「先按 key 名单递归脱敏对象、再序列化」而非对 JSON 文本跑正则。
14. **M4** PTY 写移出管理器锁（每会话写通道），close 不依赖写路径。

**中期**：
15. M13 指纹遍历跳过 node_modules/.git 内部（对齐 SDK 自己的 fingerprint 做法）并接入取消信号；M15/L7/L8 transcript-model 三处（key 唯一性兜底、branch_summary 计数对齐 SDK 投影、toolCallId 关联按轮次作用域）；L13 logout 改用 refreshModelsLocal 或传 signal；L14 provider.list 纳入 withStableGraphRead；L15 .bak 保留最近 N 份；L17 删掉多余的 "{}" 写；L1 目录改 `open -R`；L3 把 shell open 策略挪到 tauri.conf.json `plugins.shell.open` 或删假 allowlist；L4 区分「无 Tauri 环境」与「命令失败」；L5/L6 前端时序与诊断。
16. 测试体系补强按上面三个结构性盲点排优先级：PiHostManager 生产路径测试（最高优先——目前最严重的发现全在这）、fake 的 pre-run 表达能力、App.tsx 组合分发与合成信封跨端契约 fixture。
