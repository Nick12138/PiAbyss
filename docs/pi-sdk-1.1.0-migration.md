# PI SDK 0.84.2 → 1.1.0 迁移说明

> 状态：待执行 | 目标：将 PiAbyss 适配的 PI SDK 从 0.84.2 升级到 1.1.0（npm latest 正式版）
> 本文档为交接摘要，供主操作会话展开执行。

## 1. 版本基线

| 项目 | 当前 | 迁移后 | 备注 |
|---|---|---|---|
| @earendil-works/pi-coding-agent | 0.84.2（带 patch） | 1.1.0 | 需重建 patch |
| @earendil-works/pi-ai | 0.84.2（带 patch） | 1.1.0 | 需重建 patch |
| @earendil-works/pi-agent-core | 0.84.2（override） | 1.1.0 | 根 pnpm.overrides |
| @earendil-works/pi-tui | 0.84.2 | 1.1.0 | |
| Node（engines） | >=22.19.0 | 不变 | 1.1.0 要求相同，无需升级 |
| 内置运行时 Node | 24.18.0 | 不变 | release-runtime.lock.json |
| pnpm | 9.15.0 | 不变 | |

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
