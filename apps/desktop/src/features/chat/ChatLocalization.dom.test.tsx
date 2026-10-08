/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { Composer } from "./Composer";
import { SessionStatsPills } from "./StatsPills";
import { ToolView } from "./ToolView";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

/** One billed assistant step and no reported context usage: enough for the
 *  stats row (home of the context chip) to render, and enough for that chip to
 *  fall back to the "no model context available" label. */
function session(): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: "/workspace",
    revision: 1,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 1, steering: [], followUp: [] },
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [],
        usage: {
          input: 100,
          output: 40,
          cacheRead: 700,
          cacheWrite: 0,
          totalTokens: 840,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    ],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 1,
      tools: [],
      active: [],
    },
  };
}

describe("Chinese chat localization", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().setDesktopSettings({
      theme: "system",
      language: "zh",
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "legacy-modal",
      terminalProfile: "auto",
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.getState().setDesktopSettings(null);
  });

  it("localizes tool activity, Composer controls, and context details", async () => {
    const user = userEvent.setup();
    useAppStore.getState().applySessionSnapshot(session());
    render(
      <>
        <ToolView
          name="read"
          args={{ path: "/workspace/src/app.ts" }}
          result="export const ready = true;"
          status="done"
        />
        <Composer disabled welcomeWorkspaceName="Demo" />
        <SessionStatsPills />
      </>,
    );

    expect(screen.getByText("读取")).toBeVisible();
    expect(screen.getByText("已完成")).toBeVisible();
    expect(screen.getByText("/workspace/src/app.ts")).toBeVisible();
    expect(screen.queryByText("从 Demo 开始")).not.toBeInTheDocument();
    expect(screen.queryByText("你想先处理什么？")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBeTruthy();
    expect(screen.queryByRole("button", { name: "了解代码库" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查找问题" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "运行测试" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进行修改" })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("对话不可用")).toBeDisabled();
    expect(screen.getByRole("button", { name: "添加 PDF、DOCX、图片或文本文件" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();

    // The context chip (auto-compaction plus Compact now live in its panel) is
    // the stats row's third chip below the composer, not a composer control.
    const contextChip = screen.getByRole("button", { name: "没有可用的模型上下文信息" });
    expect(contextChip.closest("[data-composer-stats]")).not.toBeNull();
    await user.click(contextChip);

    expect(screen.getByText("上下文用量")).toBeVisible();
    expect(screen.getByText("自动压缩")).toBeVisible();
    // Idle session, nothing pending: the manual compaction is available.
    expect(screen.getByRole("button", { name: "立即压缩" })).toBeEnabled();
  });
});
