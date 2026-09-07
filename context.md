# Code Context

## Files Retrieved
1. `apps/desktop/src/components/RightDock.tsx` (lines 1-~1040) - 右侧 Dock 组件、tab 类型/顺序、宽度持久化、命令订阅，以及 files/tree/changes/todo/browser/shell/extension 面板渲染。
2. `apps/desktop/src/app/App.tsx` (lines 1-~1045; 127-480, 1038) - Host 事件路由与最终布局；`page === "chat" && <RightDock />`。
3. `apps/desktop/src/lib/stores/app-store.ts` (lines 109-175, 204-274, 383-388, 907-925) - Zustand 状态及 dock/extension terminal action。
4. `apps/desktop/src/components/DockToggleButton.tsx` (lines 1-35) and `AppTopBar.tsx` (lines 1-175) - 右 Dock 开关入口和顶栏布局。
5. `apps/desktop/src/lib/commands/events.ts` (lines 1-60) - `subscribeDockCommands`/`requestDockCommand` 事件总线。
6. `apps/desktop/src/features/dock/ExtensionTerminal.tsx` (lines 1-~180) - 子代理/插件 `ui.custom()` 终端交互桥。
7. `apps/desktop/src/features/dock/{FilesPanel,TreePanel,ChangesPanel,TodoPanel,BrowserPanel,ShellTerminal}.tsx` - 已有 Dock 面板实现。
8. `apps/desktop/src/components/RightDock.test.ts` (lines 1-43), `RightDock.dom.test.tsx` - Dock 纯逻辑与 DOM 测试；同目录各面板测试覆盖组件。
9. `apps/desktop/package.json` (lines 1-35) - `typecheck`, `build`, `test`, `lint` 入口。
10. `C:/Users/liu/.pi/agent/npm/node_modules/pi-subagents/skills/pi-subagents/SKILL.md` (全文) - pi-subagents 使用约束；用户指定的无扩展名直路径不存在，实际 Skill 位于该路径。
11. `C:/Users/liu/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md` (全文) - 对外 RPC、Fleet status、external runs、事件/状态接口。
12. `C:/Users/liu/.pi/agent/npm/node_modules/pi-subagents/docs/observability.md` (约 lines 1-215) - lifecycle artifacts、status DTO、`events.jsonl` 和 fleet 展示语义。

## Key Code
- `RightDock` 类型 `DockTabId` 当前只有 `files | tree | changes | todo | browser:number | shell:number | extension:string`。新增“子代理”页最自然是新增固定 tab（例如 `subagents`），在 `create*`、`tabInfo`、tabpanel 和 add/empty menu 处接入。
- Dock 通过 Zustand 读取 `dockOpen`, `extensionTerminal`, `session`, `workspace`；关闭最后 tab 会 `setDockOpen(false)` 并写 `piabyss.dock.open`。宽度 key 为 `piabyss.dock.width.v1`，350-720px。
- `App.tsx` 的 `handleHostEvent` 将 `agent.event`、`extensionUi.customStarted/customFrame/customClosed` 等 HostEvent 分派到 store；Dock 不是 Host event 总线本身，而是消费 store/本地事件。
- `app-store.ts`: `dockOpen` 初始值来自 `sidebarPref("piabyss.dock.open")`；`openExtensionTerminal` 自动打开 dock，`setDockOpen` 标记手动接管，`closeExtensionTerminal` 恢复此前状态。
- `events.ts` 的 Dock 命令只提供 `toggle` 或按 visible index 激活 tab；新增 tab 激活命令可复用该总线或增加独立 `subscribeSubagentsPanel`。
- pi-subagents public API：进程内 RPC 事件 `subagents:rpc:v1:ready`, request `subagents:rpc:v1:request`, reply `subagents:rpc:v1:reply:<requestId>`；方法 `ping/status/spawn/steer/interrupt/stop/resume`。`status` 成功且 `ping.capabilities.fleetStatus.version===1` 时返回 `{data.fleet:{version,entries,totalActive,omitted}}`；entry 有 opaque `key`, agent/role/model/effort/goal, startedAt, token totals，但刻意不暴露 run/async/tool IDs。
- pi-subagents 还提供 `registerExternalRun/updateExternalRun/unregisterExternalRun` 与 `snapshotExternalRuns/listExternalRuns`，但这是同一 Pi 进程内、display-only 的 caller-owned job cache，FleetView 不提供 stop/steer/resume；不适合把 PiAbyss Host 中的独立子进程状态直接假设为可见。
- 生命周期 artifacts 位于 `async-subagent-runs/<id>/status.json` 与 `events.jsonl`；status fields 包括 state, startedAt, lastUpdate, endedAt, steps/results/token totals 等。跨进程时 extension-api 明确指出 `pi.events` 不可达子进程，需 artifact lifecycle 或 pi-intercom。

## Architecture
布局链：`App` -> `AppTopBar` + `Sidebar` + chat main + `RightDock`（仅 chat 页面）。Dock 内部维护 tab order/active tab，面板通过条件渲染挂载；外部打开请求由 singleton 本地总线（tree/changes/browser/commands）进入 RightDock。Host transport 事件先到 `handleHostEvent`，再更新 Zustand；`ExtensionTerminal` 通过 `hostClient.request("extensionUi.customInput/customResize")` 回 Host。

对于“子代理”显示，推荐在 PiAbyss Host 增加一个明确的跨进程状态适配层（读取/订阅 pi-subagents status/artifact 或由宿主转发结构化事件），再把规范化 snapshot 存入 `app-store`，而不是在 `RightDock` 内直接读取任意文件或解析 TUI 文本。RightDock 只负责渲染 snapshot、刷新/订阅和 tab 生命周期。若 PiAbyss 与 pi-subagents 同进程且拥有 `pi.events`，才可直接接 RPC；否则使用 sidecar/Host bridge。

## Start Here
先打开 `apps/desktop/src/components/RightDock.tsx` 的 `DockTabId`、订阅 effect、`tabInfo` 和 `dock-panel-*` 渲染段；随后看 `app-store.ts` 的状态/action 和 `App.tsx` 的 Host event 入口，确定跨进程子代理状态如何进入桌面端。

## Review Findings / Risks
- medium: 当前仓库未检出任何 `pi-subagents` 集成、RPC client、subagent status protocol 或子代理状态 store；右 Dock 不能直接获得目标插件状态。
- medium: `pi.events` 是进程内接口，extension-api 明确不跨 separate Pi processes；把它直接接入 Tauri renderer 会失效，必须新增 Host/transport bridge 或共享 artifact watcher。
- low: fleet DTO 明确不暴露 run IDs；若 UI 需要 stop/steer，必须另用 RPC/status control API，而不能仅依赖 `fleet.entries`。
- low: `RightDock` 仅在 chat 页面挂载；若要求设置页也可见子代理面板，需调整 `App.tsx` 条件。

## Validation
只读检查；未修改源码。已执行文件搜索/读取与行号检查。未运行构建或测试（本任务为只读源码勘察）。

```acceptance-report
{
  "criteriaSatisfied": [{"id":"criterion-1","status":"satisfied","evidence":"context.md records concrete right-dock/layout/store/test/build entry points, pi-subagents public interfaces, data flow, and severity-tagged risks."}],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [{"command":"find/grep/read repository and pi-subagents sources","result":"passed","summary":"Inspected right dock, App layout, Zustand store, events, tests/package scripts, SKILL.md and extension API docs."},{"command":"pnpm test/build","result":"not-run","summary":"Read-only scouting task; validation execution not requested."}],
  "validationOutput": ["No source files changed; findings written to D:/我的项目/PiAbyss/context.md."],
  "residualRisks": ["No existing PiAbyss bridge for cross-process pi-subagents status; integration seam and lifecycle transport still require implementation decision."],
  "noStagedFiles": true,
  "diffSummary": "No code changes; added scouting artifact context.md only.",
  "reviewFindings": ["medium: no pi-subagents RPC/status integration exists in the current repository", "medium: pi.events cannot cross separate Pi processes; use Host bridge or lifecycle artifacts"],
  "manualNotes": "The user-specified C:/Users/liu/.pi/agent/npm/node_modules/pi-subagents/SKILL.md path is absent; the installed skill is at skills/pi-subagents/SKILL.md."
}
```
