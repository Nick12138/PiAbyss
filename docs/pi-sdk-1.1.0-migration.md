# PI SDK 0.84.2 → 1.1.0 迁移说明

> 状态：已执行（2026-10-10） | PiAbyss 适配的 PI SDK 已从 0.84.2 升级到 1.1.0（npm latest 正式版）
> 执行记录见文末第 6 节。

## 1. 版本基线

| 项目                            | 当前               | 迁移后 | 备注                      |
| ------------------------------- | ------------------ | ------ | ------------------------- |
| @earendil-works/pi-coding-agent | 0.84.2（带 patch） | 1.1.0  | 需重建 patch              |
| @earendil-works/pi-ai           | 0.84.2（带 patch） | 1.1.0  | 需重建 patch              |
| @earendil-works/pi-agent-core   | 0.84.2（override） | 1.1.0  | 根 pnpm.overrides         |
| @earendil-works/pi-tui          | 0.84.2             | 1.1.0  |                           |
| Node（engines）                 | >=22.19.0          | 不变   | 1.1.0 要求相同，无需升级  |
| 内置运行时 Node                 | 24.18.0            | 不变   | release-runtime.lock.json |
| pnpm                            | 9.15.0             | 不变   |                           |

## 2. 需要同步修改的位置

- `package.json`（根）：pnpm.overrides 四项 → 1.1.0；patchedDependencies 键名改为 @1.1.0
- `packages/pi-host/package.json`：pi-ai / pi-coding-agent / pi-tui 依赖 → 1.1.0
- `patches/`：两个 0.84.2 patch 需对照新代码重新移植（先确认上游是否已内置原 patch 内容）
- `scripts/release-sdk-evidence.mjs` 校验的 `sdkPatchSha256` 会变化，相关测试同步更新
- `pnpm.overrides` 中 `undici@8 → 8.9.0`：SDK 1.1.0 依赖 undici 8.10.2，建议 override 提升到 8.10.2（或移除让 SDK 自带版本生效）
- `pnpm-lock.yaml` 冻结哈希在 `scripts/release-runtime.lock.json`，升级后需重新生成并更新该哈希

## 3. 上游破坏性变更（按影响排序）

1. **0.87.0 会话/扩展架构重构**（对 pi-host、protocol 影响最大）：
   - `SessionManager` 成为 AgentSession 上下文权威，直接赋值 `session.agent.state.messages` 失效
   - `SessionEntry` 联合类型新增 `ContextEditEntry`，protocol 层如有 exhaustive switch 需处理
   - 扩展事件：`TurnEndEvent` 新增必填边界字段、新增 `AgentBeforeSettleEvent`、`emitBoundary()`；`shouldStopAfterTurn` 移除 → `finishTurn`
2. **0.86.0**：自定义 provider 流式输入 `Context` → `TranscriptContext`；`ToolCall.arguments`/`ToolResultMessage.details` 限 JSON 值；`user_bash` fail-closed
3. **1.0.3**：Azure provider 更名 `azure-openai-responses` → `azure`（配置层，影响用户 auth.json/models.json/settings.json 迁移）
4. 新增能力（顺手接入）：`agent_settled` 事件新增 `aborted` 字段（区分取消/完成）；OSC 7501 程序状态上报

## 4. 验证命令

按仓库现有门禁逐级执行：

```
pnpm install（重建 lockfile 与 patch）
pnpm verify:release-metadata   # SDK 证据/哈希校验，最先暴露 patch 与 lock 问题
pnpm typecheck                 # 破坏性 API 变更在此集中报错
pnpm test && pnpm verify:quick
pnpm verify:p0                 # 最终门禁（含 rust 测试）
```

## 5. 风险提示

- 0.87.0 重构跨 major，pi-host 对 SDK 内部 API 的依赖面需先盘点（grep 引用点）
- 两个 patch 若上游已合入等价修复，直接删除 patch 即可；否则以 1.1.0 为基重新 diff
- Node 无需任何改动；仅注意 undici override 与 SDK 依赖（8.10.2）的版本协调

## 6. 执行记录（2026-10-10）

- **版本落地**：四个 pi 包 → 1.1.0；undici override 与 pi-host 依赖 → 8.10.2（对齐 SDK）；brace-expansion override 5.0.9 → 5.0.12（上游 1.0.1 修复的 GHSA-q2hr-2g5m-vwhr 等三个安全公告，5.0.9 为已知受影响版本）
- **patch 重新移植**：两个 patch 均为 PiAbyss 定制功能，上游 1.1.0 未合入任何等价实现，已按 1.1.0 代码重新移植——
  - `pi-coding-agent@1.1.0`（14 个文件）：clearModel/NO_MODEL、ExtensionInvocationRunner 全套（含 1.1.0 新增的 boundary/context_with_system/cache_warming 事件路径也纳入 invocation 包装）、PackageManager.setOperationSignal + update(scope) + runCommand 重写、resource-loader 元数据回退、createAgentSession(model:null)、shell.js 捆绑 bash 回退（1.1.0 已自带 taskkill 绝对路径，仅补 process.kill 兜底）、扩展对话框 piabyss 元数据与 editor 第三参
  - `pi-ai@1.1.0`：retry 模式追加 "temporarily unavailable"（上游仍未合入）
- **aborted 接入**（1.1.0 新能力）：`agent_settled.aborted` 经 event-normalize 白名单透传；protocol `SessionSnapshot` 新增可选 `lastRunAborted`；pi-host session-snapshot 以 WeakMap 记录运行结局并写入快照；desktop transcript-reducer 在 agent_settled/agent_start 乐观维护。桌面端的展示位为后续工作
- **上游适配（3 处）**：VirtualTerminal 补 `setProgramStatus`（OSC 7501，虚拟终端不转发）；model-thinking 对 models.json 的 image/classifier 条目跳过（0.99 起 type 条目无 reasoning 字段）；emitBeforeAgentStart 新签名（prompt, images, systemPromptOptions）
- **凭据命令加固**：findWindowsBash 增加捆绑 bash 回退（PIABYSS_BUNDLED_BASH / Portable Git），打包后不再依赖 WSL 冷启动；credential-config-value 测试在 Windows 下先预热 WSL
- **用户侧迁移提示（发布说明需保留）**：Azure provider id `azure-openai-responses` → `azure`，用户需改 auth.json/models.json/settings.json 或重新登录；旧会话恢复时回退到其他模型
- **验证**：verify:quick 全绿（protocol 775 / pi-host 1053 / desktop 1562）、build 通过、cargo test 119 通过、clippy -D warnings 与 fmt 通过
