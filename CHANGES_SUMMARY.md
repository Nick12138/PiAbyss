# 周期计划智能创建对话改进

## 修改内容

### 1. 修改提示词 - 减少代码块输出 ✅
**文件**: `apps/desktop/src/features/schedule/schedule-agent-flow.ts`

- 修改规则 2：只在用户明确要求查看配置或确认最终方案时才输出 `schedule-plan` 代码块
- 说明右侧预览面板会实时显示当前配置，平时对话中不需要重复输出
- 强调 `prompt` 字段的重要性，需要详细描述任务内容、目标和要求
- 添加 `loadExtensions` 字段说明

### 2. 完善预览面板 - 显示所有配置 ✅
**文件**: `apps/desktop/src/features/schedule/ScheduleAgentPage.tsx`

**新增预览字段**:
- 计划类型 (kind): 提示词计划 / 命令计划
- 权限 (permission): 只读 / 可写 / 完整
- 错过窗口 (missedWindow): 补执行一次 / 跳过
- 超时 (timeout): 显示秒数
- 执行次数上限 (maxRuns)
- 标签 (tags): 逗号分隔显示
- 完成推送 (notify): 系统通知 / Telegram / 无
- 加载扩展 (loadExtensions): 是 / 否

**新增内容预览**:
- **提示词计划**：显示完整的 `prompt` 内容（最关键的字段）
  - 最高 200px 可滚动区域
  - 保留换行和格式
  - 这是周期任务执行时的实际指令
- **命令计划**：显示 `command` 内容
  - 使用等宽字体
  - 保留命令格式

### 3. 添加跳到最新按钮 ✅
**文件**: `apps/desktop/src/features/schedule/ScheduleAgentPage.tsx`

- 当用户滚动离开底部时，显示"跳到最新"按钮
- 按钮位置：右下角，悬浮在对话区域上方
- 点击后滚动到底部并隐藏按钮
- 用户发送消息时自动隐藏按钮
- 样式：圆形按钮，向下箭头图标

### 4. 新增 i18n 键 ✅
**文件**: `apps/desktop/src/lib/i18n/zh.ts` 和 `en.ts`

中文:
- `scheduleFormTimeout`: "超时"
- `scheduleFormLoadExtensions`: "加载扩展"
- `transcriptScrollToBottom`: "跳到最新"

英文:
- `scheduleFormTimeout`: "Timeout"
- `scheduleFormLoadExtensions`: "Load extensions"
- `transcriptScrollToBottom`: "Jump to latest"

## 关于手动模式模型选择问题

### 当前状态
`ScheduleJobDialog.tsx` 中的模型列表获取依赖活动会话：
```typescript
hostClient.request(
  "model.list",
  activeSessionContext(host, workspace, session),
  ...
)
```

### 现有降级处理
当 `models.length === 0` 时（即没有会话或模型列表获取失败）：
- 显示一个不可选的文本框
- 显示默认模型标签
- 用户无法选择其他模型，但可以继续创建计划（使用默认模型）

### 为什么会这样
1. **后端限制**：`model.list` 端点需要 `requireSession: true`
2. **架构原因**：模型列表从 `modelRegistry.getAvailable()` 获取，理论上不依赖 session，但端点强制要求
3. **周期计划页面**：可能没有活动的聊天会话

### 可能的解决方案（未实施）
1. **创建临时会话**：在打开手动模式时创建一个隐藏的临时会话
2. **新端点**：添加 `model.listGlobal` 端点，不要求 session
3. **使用配置文件**：直接从 `models.json` 读取（需要新的后端支持）
4. **复用智能模式会话**：从智能创建模式切换到手动模式时保持会话

### 建议
- **短期**：当前降级处理已足够，大多数用户使用默认模型
- **长期**：添加不依赖 session 的全局模型列表端点

## 测试建议

### 1. 提示词优化测试
- 创建新的智能计划
- 与 AI 对话，观察是否减少了代码块输出
- 检查右侧预览面板是否实时更新所有字段

### 2. 预览面板测试
- 确认所有新增字段都正确显示
- 测试提示词计划：检查 `prompt` 内容是否完整显示
  - 尝试较长的提示词，测试滚动
  - 确认换行和格式保留
- 测试命令计划：检查 `command` 显示
  - 确认使用等宽字体
  - 测试多行命令

### 3. 跳到最新按钮测试
- 滚动到历史消息，确认按钮出现
- 点击按钮，确认跳到底部且按钮消失
- 发送新消息，确认按钮自动隐藏
- 测试按钮位置和样式

### 4. 手动模式测试
- 打开新建周期计划 → 手动模式
- 选择"提示词计划"
- 观察模型下拉框：
  - **有活动会话时**：应该可以选择模型
  - **无活动会话时**：显示默认模型（不可选）—— 这是预期行为

## 文件修改清单
```
apps/desktop/src/features/schedule/ScheduleAgentPage.tsx    | 95 ++++++++++++++++++++--
apps/desktop/src/features/schedule/schedule-agent-flow.ts   | 10 ++-
apps/desktop/src/lib/i18n/en.ts                             |  3 +
apps/desktop/src/lib/i18n/zh.ts                             |  3 +
```

所有修改已通过类型检查 ✅
