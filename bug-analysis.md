# Bug 根本原因分析

## 问题现象
1. 用户发送消息后，用户气泡消失
2. 上一条已结束的 Agent 回复消息左下角出现白色竖方块（流式光标）
3. Agent 开始回复后，白色方块消失，但用户消息气泡仍然不显示
4. 切换会话后恢复正常

## 根本原因

在 `transcript-model.ts` 的 `sourceMessages()` 函数中，存在**计数错误**：

### type === "message" 的处理（✅ 正确）
```typescript
if (type === "message") {
  const message = entryProjectedMessage(record, () => asAgentMessage(record.message));
  if (message) {
    projectedMessageCount += 1;  // ✅ 只有成功投影才计数
    sources.push(...);
  }
  continue;
}
```

### type === "custom_message" 的处理（❌ 错误）
```typescript
if (type === "custom_message") {
  projectedMessageCount += 1;  // ❌ 无条件自增！
  const message = entryProjectedMessage(record, () =>
    ({
      role: "custom",
      customType: typeof record.customType === "string" ? record.customType : "custom",
      content: (record.content as SerializableAgentContent[] | string) ?? "",
      display: record.display === true,
      ...
    }) as SerializableAgentMessage,
  ) as SerializableAgentMessage;
  sources.push({
    kind: "message",
    message,
    ...
  });
  continue;
}
```

### type === "compaction" 的处理（❌ 错误）
```typescript
if (type === "compaction") {
  projectedMessageCount += 1;  // ❌ 无条件自增！
  const message = entryProjectedMessage(record, () => ...);
  sources.push(...);
  continue;
}
```

### type === "branch_summary" 的处理（⚠️ 部分正确）
```typescript
if (type === "branch_summary") {
  const summary = typeof record.summary === "string" ? record.summary : "";
  if (summary) projectedMessageCount += 1;  // ⚠️ 有条件，但逻辑可能不完整
  const message = entryProjectedMessage(record, () => ...);
  sources.push({
    kind: "message",
    message,
    ...
  });
  continue;
}
```

## Bug 触发条件

当 entries 中存在以下情况时：

1. **`custom_message` 条目，但 `display: false`**
   - `projectedMessageCount` 自增了 +1
   - 但该消息最终不会渲染（`customMessageVisible` 返回 false）
   - 不会出现在 `session.messages` 中

2. **`compaction` 条目**
   - `projectedMessageCount` 自增了 +1
   - 但某些情况下可能不对应 `session.messages` 中的一条消息

3. **`branch_summary` 条目，但 summary 为空**
   - 正确地不自增 `projectedMessageCount`
   - 但仍然会 `sources.push`，导致不一致

## 为什么会导致用户气泡消失？

```javascript
// sourceMessages 函数的尾部对齐逻辑
const tailStart = Math.min(projectedMessageCount, messages.length);
for (let index = tailStart; index < messages.length; index += 1) {
  const message = messages[index];
  sources.push({
    kind: "message",
    message,
    key: `stream:${index}`,
    ...
  });
}
```

**场景示例**：
- `messages` 数组有 3 条：[user1, assistant1, user2]（user2 是刚发送的乐观消息）
- `entries` 数组有 3 条：[message:user1, message:assistant1, custom_message:hidden]
  - 第 1 条：`type="message"` → 成功投影 → `projectedMessageCount = 1`
  - 第 2 条：`type="message"` → 成功投影 → `projectedMessageCount = 2`
  - 第 3 条：`type="custom_message"` → **无条件自增** → `projectedMessageCount = 3`
    - 但这个 custom_message 的 `display: false`，不在 `messages` 数组中
- `tailStart = min(3, 3) = 3`
- 实时尾部从 `index=3` 开始，但 `messages` 只有 3 条（index 0-2）
- **结果：`messages[2]` (user2) 被跳过，没有添加到 `sources`**

## 为什么会出现白色光标？

```typescript
export function findStreamingAssistantKey(
  rows: readonly TranscriptRow[],
  messages: readonly SerializableAgentMessage[],
  isStreaming: boolean,
): string | undefined {
  if (!isStreaming) return undefined;
  const tailRow = rows[rows.length - 1];
  if (tailRow?.role !== "assistant") return undefined;

  const lastMessage = messages[messages.length - 1];
  if (
    !lastMessage ||
    lastMessage.role !== "assistant" ||
    numberField(lastMessage, "endedAt") !== undefined
  ) {
    return undefined;
  }

  return tailRow.key;
}
```

**场景**：
- 用户刚发送消息，`isStreaming = false`，Agent 还没开始回复
- 但由于 user2 气泡被"吞掉"，`rows` 的最后一条是 `assistant1`（已结束）
- 当 Agent 开始回复时，`isStreaming = true`
- `tailRow` 是 `assistant1`（role="assistant"）
- `lastMessage` 是... 等等，如果 user2 也在 messages 里，那 lastMessage 应该是 user2
- 但如果 `isStreaming = true`，说明已经有新的 assistant message 了

让我重新分析这个光标问题...

实际上，问题可能是这样的：
1. user2 气泡被吞掉后，rows 最后是 assistant1
2. Agent 开始回复，新的 assistant2 开始流式输出
3. 但由于计数错误，assistant2 也可能被"吞掉"或延迟出现
4. 此时 `findStreamingAssistantKey` 错误地返回了 assistant1 的 key
5. 导致 assistant1 显示流式光标

## 修复方案

**核心原则**：`projectedMessageCount` 只应该计数那些**实际出现在 `session.messages` 数组中的消息**。

### 修复1：custom_message
```typescript
if (type === "custom_message") {
  const message = entryProjectedMessage(record, () =>
    ({
      role: "custom",
      customType: typeof record.customType === "string" ? record.customType : "custom",
      content: (record.content as SerializableAgentContent[] | string) ?? "",
      display: record.display === true,
      ...
    }) as SerializableAgentMessage,
  ) as SerializableAgentMessage;
  
  // ✅ 只有 display: true 的 custom_message 才会出现在 session.messages 中
  if (record.display === true) {
    projectedMessageCount += 1;
  }
  
  sources.push(...);
  continue;
}
```

### 修复2：compaction
需要确认 compaction 条目是否总是对应 session.messages 中的一条消息。
如果不是，需要添加条件判断。

### 修复3：branch_summary
当前的逻辑可能是对的（空 summary 不计数），但需要确保：
- 如果 summary 为空，不应该 push 到 sources
- 或者 push 到 sources 但标记为 `kind: "row"` 而不是 `kind: "message"`

## 为什么切换会话能恢复？

切换会话时会触发完整的快照重算（`applySessionSnapshot`），这时会绕过增量更新的路径，
重新从头计算行模型，所以消失的气泡会重新出现。
