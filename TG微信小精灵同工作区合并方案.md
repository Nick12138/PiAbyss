# 方案：TG / 微信 / 小精灵共处一个工作区，三条独立会话互不干扰

> 状态：设计稿，未开工。目标读者：后续实现者。本文只给方案与改造点，不含代码。

## 一、目标与范围

- **要**：让 Telegram、微信、小精灵三者各自使用**独立会话**，但都落在**同一个工作区目录**（小精灵工作区 `workspace/pixie`）里，互不干扰。
- **不要**：把三者合并成同一条会话；做跨通道的「统一人格 + peer 路由」。
- **不改动**：`@llblab/pi-telegram` 插件本体（它天然按 `(cwd, slot a–z, sessionId)` 各开各的会话）；小精灵的指针/换段/委派核心机制。

## 二、已验证、无需担心的部分

1. **「小精灵不会认错当前会话」这条已经作废（v6）**，转为下面的冲突 4。打盹取消后，当前段的权威变成「工作区目录里**创建时间最新**的那条会话」：`acquireCurrentSession` 每次取段先跑 `reconcilePointer`（`packages/pi-host/src/pixie-agent-runner.ts:1414`、:1597）扫 `<agentDir>/sessions/--<pixieCwd>--/*.jsonl`，按 header 的创建时间认领最新一条并把它当自己的段。同目录下混进 TG/微信会话后，它们每新开一条会话都会被小精灵认下来。
2. **TG / 微信运行时本就隔离**。TG 插件状态在 `<agentDir>/tmp/pi-telegram/`（`owners.json`/`state.json`/journal），微信在 `~/.pi/wechat/channel-state.json`，各写各的，不冲突。
3. **一个工作区可放多会话**是 Pi 的常规能力，物理层没有障碍。

## 三、真正的冲突点（必须解决）

根因只有一个：**小精灵的身份逻辑按「工作区 cwd」判定，而不是按「具体会话」判定**。三条通道共用同一 cwd 后会被误命中：

- **冲突 1 · 前导注入漏染**
  `packages/pi-host/src/agent-controller.ts:575` 调用 `maybeWrapPixiePrompt(factory, g.canonicalCwd, prompt.text, g.agentSession)`，命中条件是 `isPixieWorkspaceCwd(cwd)`（`pixie-agent-runner.ts:1808`）+「这条会话还没有用户消息」（`needsSegmentPreamble`，:1683）。
  → 后果：v6 已经把「全局单 flag」换成按会话条目判定（原来那个 `state.needsPreamble` 位会漏给界面新建的段），但**门控仍然只看 cwd**——TG / 微信的首条消息照样会被套上 `<pixie-context>`「你是小精灵…」人格前导。

- **冲突 2 · 自动起名被误抑制（v6 已消解）**
  原先 `agent-controller.ts` 用 `suppressProvisionalTitle: isPixieWorkspaceCwd(cwd)` 把整个工作区的「新建即自动起名」关掉（段名等打盹收尾再定）。v6 打盹取消后这个开关连同 `segmentSessionName` 一起删了：**同工作区里所有会话都按首条消息自动落名**，小精灵段名同理（用的是包装掉前导之前的原话）。本冲突不再需要改造。

- **冲突 4 · 段认领会抢走外来会话（v6 新增，必须解决）**
  `reconcilePointer`（`pixie-agent-runner.ts:1414`）按「创建时间最新」认段，判定只看时间戳，不看这条会话是谁的。TG / 微信若真落在 `workspace/pixie` 里，它们每建一条新会话就会：小精灵当前段被改走、`pixie.segmentChanged` 推给前端、后续委派回报与前导都落到那条外来会话上。
  → 改造方向：候选段要按**归属**过滤而不是只看时间——小精灵自己创建的段已经在会话缓存里带 `role: "pixie"`（`rememberPixieSegmentSession`，:1131；界面新建的段由 `notePixieSessionCreatedFromUi`，:1530 当场认下并登记），扫描时只认这批；或给段 header 加一个 Host 自有标记（Pi 的 `SessionHeader` 目前只有 `type/version/id/timestamp/cwd/parentSession`，加字段要评估与 SDK 的兼容）。

- **冲突 3 · 会话列表混合（展示层，非致命）**
  `pixie.listSessions` / 侧栏会列出该工作区目录下**全部**会话（含 TG、微信）。运行正确性不受影响，但界面噪音大。

## 四、改造点清单

### 阶段 A：把「按 cwd」改成「按会话」（核心，解决冲突 1、2）

1. **给 prompt 路径传入 sessionId**。`agent-controller.ts:573` 目前只传 `g.canonicalCwd`；改为同时传入被 prompt 的那条会话的 `sessionId`（或等价会话标识）。
2. **收紧 `maybeWrapPixiePrompt`**（`pixie-agent-runner.ts:1808`）。把判定从「`isPixieWorkspaceCwd(cwd)` 且本会话无用户消息就注入」改为「仅当该会话确为小精灵当前段（`state.pointer.sessionId`）才注入」。v6 的按会话判定已经解决「界面新建的段漏前导」，但还没有解决「外来通道被误染」。
3. ~~收紧 `suppressProvisionalTitle`~~ **v6 已删除该开关**，本工作区内一律按首条消息自动起名；只需确认外来的 TG/微信会话拿到的是自己的名字而不是小精灵的段名口径。
4. **保持兼容**：`isPixieWorkspaceCwd` 仍可作为「是否小精灵工作区」的前置粗筛（避免非小精灵工作区白跑指针比较），但**最终门控以指针 sessionId 为准**；`reconcilePointer` 的候选集要同时按归属过滤（见冲突 4）。

> 验收标准：在同一工作区里，TG 触发一条新会话时，其首条消息文本**不含** `<pixie-context>`；该会话**能**被自动起名；**小精灵的当前段不因这条会话而改变**（`pixie.ensureCurrent` 仍返回她自己的段，委派回报仍回到派单的那一段）。

### 阶段 B：把 TG / 微信安装到小精灵工作区（通道落点）

5. **安装目标切换**。TG 以 project scope 安装，源常量 `TELEGRAM_PLUGIN_SOURCE = "npm:@llblab/pi-telegram"`（`apps/desktop/src/features/telegram/telegram-plugin.ts:4`、`packages/pi-host/src/telegram-sessions-controller.ts:52`）。把安装/读写的工作区根从 `workspace/telegram` 指向 `workspace/pixie`。微信同理指向各自插件安装位。
   - 注意：`telegram-sessions-controller.ts:23-36` 目前硬编码专用 TG 工作区路径与会话扫描目录，需要一并改。
6. **会话来源标记不变**。TG 消息仍以 `[telegram|...]` 前缀写入 Pi 会话 jsonl（插件行为，无需改），后续可用它做列表过滤。

### 阶段 C：会话列表与入口收敛（解决冲突 3，可选）

7. **列表过滤**。`pixie.listSessions` / 侧栏 / `PixieSessionsButton` 浮层，按「是否小精灵指针段」与「是否含 `[telegram|]`/微信标记」区分展示，避免小精灵页被外来会话淹没。
8. **入口归属**。决定 TG/微信会话在小精灵工作区里如何被打开与查看：沿用现有 TG 视图（`TelegramSessionList` / `TelegramHistoryView`）挂载到小精灵页，还是并入统一会话列表。

### 阶段 D：配置与开关（UI 聚合，非必须）

9. 可选：把 TG 的配置/状态入口（`telegram-view-store` 动作）在小精灵页里呈现，达成「在小精灵中管理 TG/微信」的 UX。底层不动。

## 五、风险与注意事项

- **段认领与并发的边界（v6）**：打盹换段已删，现在只有两条路径会动当前段——用户点「新会话」（`notePixieSessionCreatedFromUi`）和 `reconcilePointer` 认领；收领旧段进图走 `openPixieSessionInGraph`（`pixie-agent-runner.ts:1272`），它会调 `markParkedForegroundSession` 补前台槽位（图在前台时跳过）、`promoteBackgroundRuntime` 只发生在收领后图恰好在前台时。需确认这些只作用于被认领的那条会话，不会把 TG/微信活动会话卷进小精灵的图槽位。
- **26 槽位上限**：`@llblab/pi-telegram` 每工作区最多 26 个并发实例（slot a–z，`workspace-slots.js:8`），满则回收最久不活跃者。TG+微信并发多时要评估是否够用。
- **thread 模式**：插件当前 `threadMode: disabled`（`<agentDir>/tmp/pi-telegram/state.json`），即单 DM 会话；要靠「每话题一条会话」需开启 forum topic 模式，行为与多槽位分配需一并验证。
- **迁移**：已有 `workspace/telegram` 历史会话/配置迁到 pixie 工作区的兼容与去重。
- **安全**：`<agentDir>/telegram.json` 内含明文 botToken，勿入库、勿外泄；确认已被 `.gitignore` 覆盖。

## 六、涉及文件索引

- `packages/pi-host/src/agent-controller.ts:573, 587, 1031`（前导注入 / 起名抑制）
- `packages/pi-host/src/pixie-agent-runner.ts:1593, 1609, 1628, 1658, 1880-1895, 1900-1914`（指针 / 前导 / 换段）
- `packages/pi-host/src/telegram-sessions-controller.ts:23-36, 52`（TG 工作区与安装源）
- `apps/desktop/src/features/telegram/telegram-plugin.ts:4`（TG 插件源常量）
- `apps/desktop/src/features/telegram/*`、`apps/desktop/src/features/pixie/*`（前端视图与入口）
- 外部：`@llblab/pi-telegram`（`dist/lib/workspace-identity.js`、`workspace-slots.js`、`threads.js`、`routing.js`，只读参考，不改）

## 七、落地顺序建议

先做**阶段 A**（最小改动、根治串味，且不动插件与安装），单独验证「TG/微信会话不再被小精灵化」；再做**阶段 B**（切安装落点，真正同工作区）；**阶段 C/D** 作为体验收敛按需跟进。
