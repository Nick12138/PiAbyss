/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { Composer } from "./Composer";
import { ToolView } from "./ToolView";

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
    render(
      <>
        <ToolView
          name="read"
          args={{ path: "/workspace/src/app.ts" }}
          result="export const ready = true;"
          status="done"
        />
        <Composer disabled welcomeWorkspaceName="Demo" />
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

    await user.click(screen.getByRole("button", { name: "没有可用的模型上下文信息" }));

    expect(screen.getByText("上下文用量")).toBeVisible();
    expect(screen.getByText("自动压缩")).toBeVisible();
    expect(screen.getByRole("button", { name: "立即压缩" })).toBeDisabled();
  });
});
