# 关于乐观回显的 Bug 文档

## 概述

这个文件夹记录了一个间歇性出现的 UI bug：用户发送消息后，消息气泡消失，同时上一条 Agent 回复左下角出现白色方块光标。

**修复状态**：✅ 已修复（2026-09-14）

**修复 Commit**：`d305598`

## 文档结构

### 1. [问题现象.md](./1-问题现象.md)
详细描述了 bug 的表现：
- 用户气泡消失
- 白色竖方块异常显示
- 切换会话后恢复
- 间歇性发生

### 2. [分析过程.md](./2-分析过程.md)
深入分析了 bug 的根本原因：
- 核心问题：`projectedMessageCount` 计数错误
- 为什么会出现白色方块
- 为什么切换会话能恢复
- 为什么只影响部分会话
- 完整的时间线和代码位置

### 3. [修复方案.md](./3-修复方案.md)
记录了修复的具体实现：
- 修复前后代码对比
- 修复效果验证
- 测试场景
- 回滚方案（如果修复失败）

### 4. [原始问题会话.jsonl](./原始问题会话.jsonl)
原始的问题排查会话记录，包含完整的分析过程。

## 快速参考

### 根本原因
在 `transcript-model.ts` 的 `sourceMessages()` 函数中，对于 `custom_message` 类型的条目，无条件地对 `projectedMessageCount` 计数 +1，但实际上只有 `display: true` 的 custom_message 才会进入 `session.messages` 数组。这导致计数虚高，实时尾部消息被跳过。

### 修复方法
只在 `record.display === true` 时才对 `projectedMessageCount` 计数 +1。

### 修复位置
```
文件：apps/desktop/src/features/chat/transcript-model.ts
函数：sourceMessages()
行号：约 1023-1045
```

## 如果问题仍然存在

如果修复后仍然遇到类似问题，请：

1. **查看控制台错误**：打开开发者工具，检查是否有 JavaScript 错误
2. **检查会话数据**：查看 `.pi/agent/sessions/` 下的会话文件，确认是否有异常的 entry
3. **对比修复代码**：确认 `transcript-model.ts` 中的修复是否生效
4. **添加调试日志**：在 `sourceMessages()` 函数中添加 `console.log`，输出 `projectedMessageCount` 和 `messages.length`
5. **创建最小复现**：尝试创建一个包含 `display: false` custom_message 的测试会话

## 相关资源

- Git commit: `d305598`
- 修复日期：2026-09-14
- 问题发现日期：2026-09-13
- 影响版本：修复前的所有版本
- 修复版本：当前版本（2026-09-14 及之后）

## 联系方式

如有问题，请参考本文件夹中的详细文档，或查看原始会话记录。
