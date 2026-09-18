# 周期计划智能创建 · 待办列表改造 + 渲染改动交接文档

> 日期：2026-09-18
> 状态：代码已完成、类型检查通过、相关测试通过，**但未经过人工实测**。
> 本文档写给继续接手的 AI/开发者：先读「背景」，再按「待验证清单」实测，最后看「遗留问题」。

---

## 1. 背景：本轮解决了什么

### 1.1 用户报的 Bug：智能创建的会话在周期计划里不显示、无法继续

**根因**：旧待办机制只把会话写进前端 `localStorage`（key `piabyss.schedule.agentPending.v1`），且**只在智能创建页内点「返回」按钮**时（`handleBack → leaveScheduleAgent`）才写入。用户从侧边栏等其他任何路径离开页面，会话就从待办里消失了（但会话文件本身一直留在 `~/.pi/schedule/agent-sessions/` 下）。

**修复方案**：待办列表改为**以宿主为准**。pi-host 新增 `schedule.agentList` 方法，直接扫描 `agent-sessions` 目录列出所有智能创建会话；前端只维护一个「已处理」索引（localStorage），用于过滤已确认/已忽略的会话。这样会话不再依赖任何特定退出路径，重启宿主后也能列出。

**已实测验证**（用真实会话文件跑过 `listAgentSessions()`）：磁盘上的 4 个会话全部能正确列出，标题取自首条用户消息的需求正文，如「新建一个测试的定时器」。

### 1.2 用户报的 Bug：模型下拉只剩「宿主默认模型」

旧实现借用聊天页的会话级 `model.list`，需要活跃会话才能拿到列表；没有会话时静默降级为纯文本。已改为与设置页同源的 host 级 `piSettings.get`（无需会话），并按供应商分组显示。**已提交**（commit `fe08863`）。

### 1.3 渲染改进（用户要求）

1. **隐藏 schedule-plan 代码块**：Agent 仍按提示词每次输出完整配置 JSON（右侧预览面板靠解析它更新），但前端渲染时剥离这些代码块；整条消息只剩代码块时显示「计划配置已更新（见右侧预览）」占位。
2. **提示词注入拆分渲染**：pi-host 的注入提示词用 `<schedule-preamble>...</schedule-preamble>` 哨兵包裹；前端把首条用户消息拆成「提示词注入（默认折叠）+ 用户需求」两块展示，实际发给 Agent 的仍是一条消息。

---

## 2. 本次改动清单（未提交部分）

> 注意：工作区里还混有**另一拨并行改动**（git 异步任务：`git-async-tasks.ts`、`git-controller.ts`、`git-service.ts`、`main.ts`、`server.ts`、`events.ts`、`App.tsx`、`ChangesPanel*`、`cross-workspace-events.test.ts`，以及 protocol 里 git.push/pull 改为异步的契约）。这些与 schedule 改动在 protocol 同一文件里交织，**无法按文件拆分提交**，已合并为一次提交。git 异步任务那部分**不是本会话的工作**，其状态未知，接手者需自行评估（它自带测试 `git-async-tasks.test.ts`，pi-host 全量测试跑的时候是过的）。

### 2.1 protocol（packages/protocol/src）

- `methods.ts`：新增 `"schedule.agentList"`（host 作用域）。
- `contracts.ts`：
  - params：`"schedule.agentList": null`
  - result：`"schedule.agentList": { sessions: ScheduleAgentSessionSummary[] }`
  - `"schedule.agentContinue"` 的 result 从 `{ sessionId }` 扩为 `{ sessionId: string; sessionPath: string }`
- `types.ts`：新增 `ScheduleAgentSessionSummary = { sessionId, sessionPath, title, updatedAt, resident }`。
- `validate.ts` / `dto-validate.ts`：对应参数/结果校验（`agentList` params 必须为 null；`agentContinue` result 要求 sessionId + sessionPath）。
- `protocol-coverage.test.ts`：补了 agentList 的样例（668 个测试全过）。

### 2.2 pi-host（packages/pi-host/src）

- `schedule-agent-runner.ts`：
  - 新增 `listAgentSessions()`：扫描 `agentSessionsDir()`（=`~/.pi/schedule/agent-sessions`）下所有 `*.jsonl`，从文件头 `"type":"session"` 行提取 sessionId（回退用文件名后缀），mtime 排序倒序；驻留内存的会话即使文件未落盘也会列出；`resident` 标记该会话是否还在宿主内存（决定前端走 `agentSend` 还是 `agentContinue`）。
  - 新增 `extractTitle(sessionPath)`：从首条 user 消息里取「用户需求：」之后的内容作为标题；老格式的尾部「计划的默认工作目录（cwd）」行用正则剥掉；空/读不了的会话跳过。
  - `continueAgentConversation` 返回值扩为 `{ sessionId, sessionPath }`（fork 会产生新会话文件，调用方需要新路径）。
  - 注入提示词用 `<schedule-preamble>...</schedule-preamble>` 哨兵包裹（cwd 移进哨兵内）；`用户需求：` 标签保留在正文。
- `schedule-controller.ts`：注册 `"schedule.agentList"` handler；`agentContinue` 结果带上新 sessionPath。

### 2.3 desktop（apps/desktop/src）

- `features/schedule/schedule-agent-store.ts`：
  - 删除旧的 localStorage 待办（`ScheduleAgentPending` / `listAgentPending` / `addAgentPending` / `removeAgentPending`）和 store 里的 `pendingId` 字段。
  - 新增 `HANDLED_KEY = "piabyss.schedule.agentHandled.v1"`（string[]，存 sessionPath）+ `listHandledAgentSessions()` / `markAgentSessionHandled(path)`。
- `features/schedule/schedule-agent-flow.ts`：
  - `reopenScheduleAgent(entry)` 入参去掉 `id`，只需 `{ sessionId, sessionPath }`。
  - `leaveScheduleAgent()`：只有 `created === true` 时 `markAgentSessionHandled(sessionPath)`；未完成的不写任何东西（列表由宿主给）。
  - 删除了 `AGENT_SESSION_NAME` 常量（无人引用）。
- `features/schedule/SchedulePage.tsx`：
  - 新增 `agentSessions` state + `refreshAgentSessions()`（调 `schedule.agentList`，用 handled 索引过滤），挂载时 + 30s 轮询时刷新。
  - 待办区块渲染 `agentSessions`：标题、`继续`（reopen）、`移除`（markAgentSessionHandled 本地过滤）。
  - 空态条件改为 `jobs.length === 0 && agentSessions.length === 0`。
- `features/schedule/ScheduleAgentPage.tsx`：
  - 渲染前 `stripPlanBlocks(message.text)` 剥离 schedule-plan 代码块（含流式未闭合尾）；纯代码块消息渲染占位 `scheduleAgentPlanUpdated`。
  - 首条用户消息经 `splitUserMessage()` 拆成「提示词注入（可折叠胶囊按钮，默认收起）+ 用户需求气泡」；旧会话（无哨兵）回退按「用户需求：」分隔符拆。
  - 滚动到底部按钮：锚定进滚动区自己的 `relative isolate` 容器、`z-10`、`bottom-3 left-1/2` 居中、`ArrowDown`，与聊天页同款。
  - `send()` 里 fork 继续成功后：`markAgentSessionHandled(旧 sessionPath)` + `setSession({ sessionId, sessionPath: 新路径 })`，避免待办重复、后续轮次丢历史。
- `features/schedule/schedule-model.test.ts`：新增 `stripPlanBlocks` 4 个用例、`splitUserMessage` 3 个用例。
- `lib/i18n/zh.ts` / `en.ts`：新增 `scheduleAgentPlanUpdated`、`scheduleAgentPreambleToggle`。

### 2.4 已提交的部分（本轮早些时候）

- `fe08863`：模型选择改用 `piSettings.get` + Select 组件分组头支持。
- `6f9f9d0`：Dialog headerExtra 插槽（另一会话的工作）。

---

## 3. 待验证清单（接手者先做这个）

重启应用（pi-host 代码改了，必须重启宿主），然后：

1. **待办列表**：打开周期计划页 → 左侧应出现「待办（智能创建）」区块，列出 `~/.pi/schedule/agent-sessions` 里的会话（现在应有 4 条，标题为需求正文）。
2. **继续会话**：点「继续」→ 进入智能创建页，能看到历史消息；发一条消息：
   - 宿主活着（resident）→ 直接 `agentSend`，同文件追加。
   - 宿主重启过（resident=false）→ 走 `agentContinue` fork 出新文件；**验证点**：回到周期计划页，待办里应该只有新条目（旧条目已被标记 handled 消失），不再重复。
3. **确认创建**：走完一次确认创建 → 返回周期计划页，该会话应从待办消失（handled）。
4. **移除**：点待办条目的「移除」→ 本地消失（文件仍在磁盘，属预期）。
5. **提示词注入**：新建一个智能创建会话 → 首条用户消息上方应有「提示词注入」胶囊按钮，默认收起；展开显示系统指令；用户气泡只显示自己输入的需求。
6. **schedule-plan 块隐藏**：Agent 确定配置的那几轮，正文不应出现 JSON 代码块；右侧预览仍实时更新；纯配置消息显示「计划配置已更新」占位。
7. **滚动按钮**：消息区滚动离开底部 → 底部居中出现「↓」圆钮；点击回底；不应被输入框压住。
8. **模型选择**：新建计划 → 手动模式 → 模型下拉应列出全部模型并按供应商分组（无需先开聊天会话）。

---

## 4. 遗留问题 / 已知瑕疵（未修，按优先级）

1. **[中] fork 继续时 cwd 取自当前工作区**：`ScheduleAgentPage.send()` 里 `agentContinue` 传 `cwd: workspace?.cwd ?? ""`，但非驻留会话原本是在别的目录创建的（会话文件头 `"cwd"` 字段有真实值）。跨工作区继续会跑错目录。**建议修法**：`ScheduleAgentSessionSummary` 加 `cwd` 字段（host 从会话文件头读），前端存进 store 并在 continue 时传它。
2. **[低] handled 索引只增不减**：`piabyss.schedule.agentHandled.v1` 里被移除/确认的 sessionPath 永远留着。影响极小（每次过滤比对），可选做清理（比如按目录现存文件修剪）。
3. **[低] extractTitle 的 120 字截断**：超长需求标题被截断且无省略号标记；UI 上 `truncate` 了，问题不大。
4. **[既有，非本轮引入] `model-runtime-refresh.test.ts` 失败**：断言只有 `agent-session-factory.ts` 调用 `createAgentSession`，但 `schedule-agent-runner.ts`（本会话之前就存在）也调用。在 HEAD 上 stash 验证过同样失败。修法：把该测试的期望列表加上 schedule-agent-runner.ts，或让 runner 改用 factory。
5. **[提示] localStorage 的 origin 差异**：dev（127.0.0.1:1420）与生产（tauri.localhost）的 localStorage 是分开的，handled 索引互不相通。dev 里确认的会话在生产环境会重新出现在待办。可接受，知悉即可。

---

## 5. 架构速查（给接手者）

```
~/.pi/schedule/agent-sessions/*.jsonl   ← 智能创建会话文件（唯一事实来源）
        ↑ 扫描
schedule.agentList (pi-host schedule-agent-runner.listAgentSessions)
        ↓
SchedulePage.refreshAgentSessions()  ──过滤──>  localStorage "piabyss.schedule.agentHandled.v1"
        ↓ 继续
reopenScheduleAgent({sessionId, sessionPath}) → ScheduleAgentPage
        ↓ 发消息
resident ? schedule.agentSend : schedule.agentContinue（fork，返回新 sessionPath）
        ↓ 确认创建
markCreated() → leaveScheduleAgent() → markAgentSessionHandled(路径)
```

首条用户消息格式（新）：

```
<schedule-preamble>
你是「周期计划」智能创建助手…（规则、字段说明、cwd）
</schedule-preamble>
用户需求：
<用户输入的需求>
```

前端 `splitUserMessage()`：有哨兵按哨兵拆；无哨兵按「用户需求：」拆；都失败原样显示。

## 6. 验证命令

```bash
pnpm --filter @piabyss/protocol test          # 668 通过
pnpm --filter @piabyss/protocol build         # desktop 依赖 dist，改 protocol 后必须重建
cd apps/desktop && npx tsc --noEmit -p tsconfig.json
cd apps/desktop && npx vitest run src/features/schedule   # 21 通过
cd packages/pi-host && npx tsc --noEmit -p tsconfig.json
cd packages/pi-host && npx vitest run          # 923 通过 + 1 个既有失败（见 §4.4）
```

快速肉眼验证待办列表（不起应用）：

```bash
cd packages/pi-host && npx tsx -e "import('./src/schedule-agent-runner.js').then(m => console.log(m.listAgentSessions()))"
```
