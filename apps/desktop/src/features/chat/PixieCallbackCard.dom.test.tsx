/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostStatusSnapshot, SessionSnapshot, WorkspaceSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { Transcript } from "./Transcript";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

const ERROR_ENVELOPE = [
  '<pixie-error dispatchId="pix_1">',
  "委派任务执行失败（目标 cwd：D:\\proj，第 2 次失败）：",
  "原始错误：Request was aborted",
  "请按会话状态决策：可续跑→原地续跑；方向性错误→调整委派词重派；无法自行判断→如实向用户报告。",
  "</pixie-error>",
].join("\n");

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 1,
    packageRevision: 1,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: 1,
    servicesReady: true,
  };
}

function session(messages: SessionSnapshot["messages"]): SessionSnapshot {
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
    pending: { revision: 0, steering: [], followUp: [] },
    messages,
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

describe("delegation callback cards", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
  });

  afterEach(() => {
    cleanup();
  });

  it("folds a delivery envelope into a collapsed card instead of a user bubble", async () => {
    useAppStore
      .getState()
      .applySessionSnapshot(
        session([{ role: "user", content: `[pixie|system]\n${ERROR_ENVELOPE}` }]),
      );
    const user = userEvent.setup();
    const { container } = render(<Transcript />);

    // 信封原文不出现在气泡里；收起时只留一行“失败原因”摘要。
    expect(screen.queryByText(/请按会话状态决策/)).not.toBeInTheDocument();
    const card = container.querySelector('[data-pixie-callback="error"]');
    expect(card).not.toBeNull();
    expect(card).toHaveAttribute("data-dispatch-id", "pix_1");
    expect(screen.getByText("Delegation failed")).toBeVisible();
    expect(card).toHaveTextContent("Request was aborted");

    await user.click(screen.getByRole("button", { name: /Delegation failed/ }));
    // 展开后才是写给模型的完整指令。
    expect(screen.getByText(/请按会话状态决策/)).toBeVisible();
    expect(screen.getByText(/dispatchId · pix_1/)).toBeVisible();
  });

  it("still renders the user's own words as a bubble", () => {
    useAppStore
      .getState()
      .applySessionSnapshot(session([{ role: "user", content: "帮我看看这个报错" }]));
    render(<Transcript />);
    expect(screen.getByText("帮我看看这个报错")).toBeVisible();
  });
});
