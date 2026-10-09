import { describe, expect, it, vi } from "vitest";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import {
  createProvisionalSessionTitle,
  extractLatestAssistantText,
  generateRefinedSessionTitle,
  sanitizeSessionTitle,
} from "./session-title.js";

describe("session titles", () => {
  it("creates a concise provisional title from the first sentence", () => {
    expect(createProvisionalSessionTitle("修复 session 恢复问题。然后补测试")).toBe(
      "🐛 修复 session 恢复问题",
    );
    expect(createProvisionalSessionTitle("   ")).toBe("💬 新会话");
  });

  it("cleans model labels, quotes, punctuation, and excessive length", () => {
    expect(sanitizeSessionTitle('标题："修复桌面会话恢复。"')).toBe("🐛 修复桌面会话恢复");
    expect(sanitizeSessionTitle("a".repeat(40))).toBe(`💬 ${"a".repeat(15)}…`);
  });

  it("keeps an existing leading emoji and avoids a duplicate emoji", () => {
    expect(sanitizeSessionTitle("🌊 修复会话恢复。")).toBe("🌊 修复会话恢复");
  });

  it("picks a topic-related emoji when the title has none", () => {
    expect(sanitizeSessionTitle("修复登录 bug")).toBe("🐛 修复登录 bug");
    expect(sanitizeSessionTitle("配置部署流水线")).toBe("⚙️ 配置部署流水线");
    expect(sanitizeSessionTitle("添加单元测试覆盖")).toBe("🧪 添加单元测试覆盖");
    expect(sanitizeSessionTitle("优化数据库查询性能")).toBe("⚡ 优化数据库查询性能");
  });

  it("matches more development categories by keyword", () => {
    expect(sanitizeSessionTitle("调试日志输出")).toBe("🧩 调试日志输出");
    expect(sanitizeSessionTitle("Docker 容器编排")).toBe("🐳 Docker 容器编排");
    expect(sanitizeSessionTitle("实现国际化翻译")).toBe("🌍 实现国际化翻译");
    expect(sanitizeSessionTitle("创建桌面托盘")).toBe("🖥️ 创建桌面托盘");
    expect(sanitizeSessionTitle("绑定快捷键")).toBe("⌨️ 绑定快捷键");
    expect(sanitizeSessionTitle("实现截图功能")).toBe("📸 实现截图功能");
    expect(sanitizeSessionTitle("添加定时调度任务")).toBe("⏰ 添加定时调度任务");
    expect(sanitizeSessionTitle("多工作区管理")).toBe("💼 多工作区管理");
    expect(sanitizeSessionTitle("邮箱验证码")).toBe("🔒 邮箱验证码");
    expect(sanitizeSessionTitle("监控状态指标")).toBe("📊 监控状态指标");
    expect(sanitizeSessionTitle("删除卸载插件")).toBe("🔌 删除卸载插件");
    expect(sanitizeSessionTitle("压缩解压 zip 包")).toBe("🗜️ 压缩解压 zip 包");
  });

  it("strips emoji embedded mid-title to keep exactly one", () => {
    expect(sanitizeSessionTitle("修复 bug 🚀 发布")).toBe("🐛 修复 bug 发布");
  });

  it("extracts the latest assistant text blocks", () => {
    expect(
      extractLatestAssistantText([
        { role: "assistant", content: "old" },
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      ]),
    ).toBe("first\nsecond");
  });

  it("uses a separate minimal completion and sanitizes its result", async () => {
    const complete = vi.fn(
      async (
        _model: Model<Api>,
        _context: Context,
        _options?: SimpleStreamOptions,
      ) =>
        ({
        role: "assistant",
        content: [{ type: "text", text: "Title: Restore desktop sessions." }],
        stopReason: "stop",
        }) as AssistantMessage,
    );
    const model = { provider: "test", id: "title", api: "test" } as Model<Api>;
    const title = await generateRefinedSessionTitle({
      model,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      },
      userPrompt: "Restore desktop sessions",
      assistantText: "Implemented session restoration.",
      complete,
    });

    expect(title).toBe("💬 Restore desktop…");
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[1]).toMatchObject({
      systemPrompt: expect.stringContaining(
        "Begin with exactly one emoji that matches the topic, and use no other emoji",
      ),
    });
    expect(complete.mock.calls[0]?.[2]).toMatchObject({
      apiKey: "test-key",
      maxTokens: 96,
      maxRetries: 0,
      reasoning: "minimal",
      timeoutMs: 120_000,
    });
  });
});
