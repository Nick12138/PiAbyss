# 2026-09-18 Git 拉取/推送异步化 — 交接文档

> 状态：**主体已完成并测试通过，已停在收尾阶段**。本文档供后续会话接续修复与提交。
> 代码改动当前全部在工作区未提交（另有若干与本任务无关的 schedule WIP，见「无关改动」一节）。

## 1. 需求回顾

用户原始需求（右侧改动面板 / ChangesPanel）：

1. **拉取（pull）和推送（push）改成异步**：点击后立即返回，不等网络操作结束。
2. **随时可切换工作区**：pull/push 进行中可以切到别的工作区，对其它工作区再发起拉取/推送，互不阻塞。
3. **通知带工作区名**：例如「PiAbyss推送成功」，方便多个工作区并行拉取/推送时区分提醒；**失败提醒同样**要带工作区名；其余改动类操作提醒（commit、建分支、切分支）也统一加了工作区名。

## 2. 根因（修复前为什么报「服务繁忙，请稍后重试」）

- `git.pull` / `git.push` 原先走 `withRegisteredGraphMutation`，**整个网络阶段（最长 30s 超时 + 前后两次 getStatus）持有全局 `serviceGraphLock`**。
- 切工作区 `workspace.setCurrent` 对该锁只等待 `WORKSPACE_SWITCH_LOCK_WAIT_MS = 2s`（`workspace-lifecycle.ts:68`），等不到即返回 `SERVICE_GRAPH_BUSY` → 前端文案「服务繁忙，请稍后重试」。
- 前端 `requestWithRetry` 重试窗口总共约 0.8s，盖不住 pull 时长。

## 3. 实现方案（已完成）

### 3.1 Host 端

| 文件 | 改动 |
|---|---|
| `packages/pi-host/src/git-async-tasks.ts` **（新文件）** | `GitAsyncTaskRunner`：pull/push 火后不管任务执行器。网络阶段**不持 `serviceGraphLock`**，按仓库用 `RepoMutex` 串行；完成后短暂 tryAcquire 刷新状态快照，然后 emit `git.taskFinished`（含 workspaceName）+ `git.changed`（仅当该工作区仍是当前活跃工作区时才发 git.changed，避免 parked 工作区快照触发前端跨 epoch 恢复）。`abortAll(reason)` 供 shutdown 调用。 |
| `packages/pi-host/src/git-service.ts` | 新增 `RepoMutex`（per-repo 互斥，win32 路径归一化）；`runNetworkTask`（无锁网络阶段，返回分类结果而非抛错）；`classifyGitTaskError`（clean-worktree / conflict / network / auth / other）；`syncNetworkMutation`（runner 未接线时的同步回退路径）；getter `gitExecutable`。 |
| `packages/pi-host/src/git-controller.ts` | `git.pull` / `git.push` 改为 `asyncGitTask`：在 `withRegisteredGraphMutation` 内只做身份校验 + 提交任务，立即返回 `{ accepted: true, taskId, workspaceCwd }`；同工作区已有任务在跑时返回 `GIT_OPERATION_FAILED`（message 含 "already running"）。 |
| `packages/pi-host/src/server.ts` | 新增 `currentWorkspaceId()`、`isBoundWorkspaceIdentity(workspaceId, revision)`（活跃或 parked 绑定均算 bound）。 |
| `packages/pi-host/src/main.ts` | 构造 `GitAsyncTaskRunner` 注入 `createGitHandlers`；`onShutdown` 时 `gitAsyncTasks.abortAll("Host shutdown")`。 |

### 3.2 协议层（packages/protocol）

- `types.ts`：新增 `GitAsyncAccepted`、`GitTaskFinishedPayload`（含 `errorKind: "conflict" | "clean-worktree" | "network" | "auth" | "other"`）。
- `contracts.ts`：`git.pull` / `git.push` 结果类型 `GitMutationResult` → `GitAsyncAccepted`；新增事件 `git.taskFinished`。
- `events.ts`：`HOST_EVENT_NAMES` 增加 `git.taskFinished`。
- `dto-validate.ts`：新增 `isGitAsyncAccepted`、`isGitTaskFinishedPayload` 校验；**注意**：曾误把 `git.stage` 等同步 mutation 一并切到新校验器导致测试红，已修正——现在只有 `git.push`/`git.pull` 用新校验器，`git.stage/stageAll/unstage/unstageAll/discard/mutateHunk` 仍是 `isGitMutationResult`。
- `protocol-coverage.test.ts`：补 `git.taskFinished` 样例 payload。

### 3.3 前端（apps/desktop）

- `features/dock/ChangesPanel.tsx`：
  - pull/push 改为 `startNetworkTask(kind)`：发请求（15s 超时，只等受理）→ 受理后立即清 spinner；「already running」错误映射到新文案 `gitTaskAlreadyRunning`；pull 前置的干净工作树检查保留。
  - 删除了旧的通知逻辑与 `pullErrorMessage`（脏工作树检测移到 Host 分类器）。
  - 分支创建/切换、commit 成功的提醒加 `{workspace}` 名。
- `app/App.tsx`：
  - `handleHostEvent` 放行规则新增 `gitTaskEvent`（`git.taskFinished` 且属于活跃工作区或 bound parked 工作区），避免被当作身份漂移触发全量恢复。
  - switch 新增 `case "git.taskFinished"`：成功 → `{workspace} 拉取成功` / `{workspace} 推送成功`（toast, success）；失败 → 按 `errorKind` 本地化详情（`gitTaskFailedConflict/CleanWorktree/Network/Auth`，其它用原始 git 消息），`{workspace} 拉取失败：{detail}`（toast, error）。
  - 若 payload 带 snapshot 且事件属于**当前活跃工作区**，合成 `git.changed` 事件 `publishValidatedHostEvent` 给面板订阅链路（刷新快照/历史）。
- `lib/i18n/zh.ts` / `en.ts` 新增 key：`gitTaskAlreadyRunning`、`gitPullSuccessNamed`、`gitPushSuccessNamed`、`gitPullFailedNamed`、`gitPushFailedNamed`、`gitTaskFailedConflict/CleanWorktree/Network/Auth`；并给 `gitCommitSuccess`、`gitBranchCreated`、`gitBranchSwitched` 加了 `{workspace}` 占位符。

## 4. 已验证

- `packages/protocol`：`npx vitest run` → **665/665 通过**。
- `packages/pi-host`：`git-async-tasks.test.ts`（新增，8 个用例，用真实 git 临时仓库）——受理即返、网络阶段不持锁、同仓库防重入、脏工作树分类为 clean-worktree、**切走后仍能收到失败通知且不发 git.changed**；`git-controller.test.ts`（18）、`git-service.test.ts`（16）均通过。
- `apps/desktop`：`npx tsc --noEmit -p .` 通过（仅剩 schedule WIP 的既有报错，见下）；`features/dock` + `app` 共 123 测试通过（含 `cross-workspace-events.test.ts` 新增 2 个用例、ChangesPanel dom 测试断言已更新为 `desktop: committed deadbeef` 格式）。
- ESLint / Prettier 对所有改动文件已清零。

## 5. 未完成 / 已知问题（接手清单）

1. **⚠️ `git.taskFinished` 的本地 spinner 追踪未做**：ChangesPanel 受理后立即清空 `operation`，任务在后台跑时按钮上没有「进行中」指示。可接受，但如果要做：订阅 `git.taskFinished`（scope 用 `gitWatchContext`），按 `taskId` 匹配清除。
2. **历史页在 pull 完成后可能停在空列表**：原同步实现有「拉取后若正停在历史页立即 `loadHistory(false)`」的防护；现在 HEAD 移动后 `historyHeadKey` effect 会清空历史并置 `historyLoaded=false`，但若用户正停在历史视图，没有自动重载触发。建议在 `git.changed` 订阅回调里补：`if (view === "history" && !historyLoading) void loadHistory(false)`。
3. **全仓 `pnpm vitest run`（pi-host）有 2 个既有失败，均与本任务无关**：
   - `model-runtime-refresh.test.ts`：要求 `createAgentSession({` 只出现在 `agent-session-factory.ts`，但未提交的 `schedule-agent-runner.ts` WIP 里新增了一个调用点（见 §6）。
   - `apps/desktop/src/features/schedule/ScheduleAgentPage.tsx:290` 的 tsc 报错（`sessionPath` 不在联合类型上），同样来自 schedule WIP。
4. **通知双语拼接**：中文是 `{workspace} 推送成功`（中间有空格，用户示例是「PiAbyss推送成功」无空格，如需完全一致可去掉 zh 模板里的空格）。
5. **防御性边界**：任务完成时若工作区已被彻底逐出（超出 `MAX_RETAINED_GRAPHS` 且被 dispose），`emitForIdentity` 抛错被吞掉，通知会丢——极端场景，可接受；如要彻底解决需 Host 级别的全局通知通道。
6. **文档**：`docs/architecture/` 下若有 git/changes-panel 相关章节，需要补一段异步任务语义（本次未更新架构文档）。

## 6. 无关改动（schedule WIP，不要和本任务一起提交）

工作区里还有另一批**未提交的 schedule 智能创建 WIP**（别的会话的活）：

- `apps/desktop/src/features/schedule/SchedulePage.tsx`、`ScheduleAgentPage.tsx`、`schedule-agent-flow.ts`、`schedule-agent-store.ts`、`schedule-model.test.ts`
- `packages/pi-host/src/schedule-agent-runner.ts`、`schedule-controller.ts`
- `packages/protocol/src/methods.ts`、`validate.ts`（`schedule.agentList` 方法）

另外 **`git stash` 里有 `stash@{0}: pre-existing SchedulePage WIP`**（本次会话为排查 typecheck 临时 stash 过一次 `SchedulePage.tsx`；当前工作区的 SchedulePage 内容与 stash 内容**不同**——工作区版本更新，stash 是旧版快照。处理时先 diff 确认再决定 drop 或忽略，**别盲目 pop 会冲突**）。

## 7. 本任务涉及的文件清单（供提交时参考）

```
新文件：
  packages/pi-host/src/git-async-tasks.ts
  packages/pi-host/src/git-async-tasks.test.ts

修改：
  packages/pi-host/src/git-controller.ts
  packages/pi-host/src/git-service.ts
  packages/pi-host/src/main.ts
  packages/pi-host/src/server.ts
  packages/protocol/src/types.ts
  packages/protocol/src/contracts.ts
  packages/protocol/src/dto-validate.ts
  packages/protocol/src/events.ts
  packages/protocol/src/protocol-coverage.test.ts
  apps/desktop/src/features/dock/ChangesPanel.tsx
  apps/desktop/src/features/dock/ChangesPanel.dom.test.tsx
  apps/desktop/src/app/App.tsx
  apps/desktop/src/app/cross-workspace-events.test.ts
  apps/desktop/src/lib/i18n/zh.ts
  apps/desktop/src/lib/i18n/en.ts
```

## 8. 验证命令

```bash
# 协议层
cd packages/protocol && npx vitest run

# Host 端 git 相关
cd packages/pi-host && npx vitest run src/git-async-tasks.test.ts src/git-controller.test.ts src/git-service.test.ts

# 前端类型 + 相关测试
cd apps/desktop && npx tsc --noEmit -p .
cd apps/desktop && npx vitest run src/features/dock src/app

# Lint / 格式
npx eslint packages/pi-host/src/git-async-tasks.ts apps/desktop/src/app/App.tsx apps/desktop/src/features/dock/ChangesPanel.tsx
npx prettier --check <改动文件>
```

## 9. 关键设计决策备忘（防止后续会话走回头路）

- **不要**把整个网络阶段包回 `withRegisteredGraphMutation`——那就是本 bug 的根因。锁只覆盖「受理校验」和「完成后的快照刷新」两个短临界区。
- per-repo 串行用 `RepoMutex`，**不要**用全局锁代替，否则多工作区并行拉取会被互相阻塞。
- parked 工作区**只发 `git.taskFinished`，不发 `git.changed`**——`git.changed` 会撞上前端 `handleHostEvent` 的身份守卫触发全量恢复（本会话已验证该约束，`cross-workspace-events.test.ts` 有对应用例）。
- 前端 `git.taskFinished` 必须在 `handleHostEvent` 的放行规则里豁免，否则切走工作区后收到完成事件会 `markDesynchronized`。
