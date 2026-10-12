/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopSettings,
  HostStatusSnapshot,
  PixieAgentState,
  PixieSessionRundown,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { usePixieViewStore } from "./pixie-store";
import { PixiePage } from "./PixiePage";

// jsdom 没有 scrollIntoView；命令补全高亮项滚动依赖它。
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    sdkVersion: "test",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function pixieState(): PixieAgentState {
  return {
    resident: true,
    sessionPath: "/sessions/pixie/seg.jsonl",
    running: false,
    error: null,
    messages: [],
    segments: [],
    askPending: false,
    modelName: null,
    dispatches: [],
  };
}

function rundown(): PixieSessionRundown {
  return {
    model: { provider: "muapi", id: "grok-4.5" },
    thinkingLevel: "off",
    availableThinkingLevels: ["off", "high"],
    isStreaming: false,
    isCompacting: false,
    autoCompactionEnabled: true,
    stats: null,
    contextUsage: null,
  };
}

beforeEach(() => {
  useAppStore.getState().setHost(host());
  // desktopSettings 必须是稳定对象（knownWorkspaces 用 `?? []` 会在每次渲染
  // 新建数组并触发无限循环）。
  useAppStore.setState({
    desktopSettings: {
      theme: "system",
      language: "en",
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "legacy-modal",
      terminalProfile: "auto",
      knownWorkspaces: [],
    } as unknown as DesktopSettings,
  });
  usePixieViewStore.setState({ state: pixieState(), error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  useAppStore.getState().setHost(null);
  useAppStore.setState({ desktopSettings: null });
  usePixieViewStore.setState({ state: null, error: null });
});

function mockPixieHost() {
  return vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
    if (method === "pixie.state") return { ok: true, result: pixieState() } as never;
    if (method === "pixie.rundown") return { ok: true, result: rundown() } as never;
    if (method === "pixie.models") {
      return {
        ok: true,
        result: {
          models: [{ provider: "muapi", id: "grok-4.5", label: "Grok 4.5" }],
          current: { provider: "muapi", id: "grok-4.5" },
        },
      } as never;
    }
    if (method === "pixie.send") return { ok: true, result: { sessionId: SESSION_ID } } as never;
    return { ok: true, result: null } as never;
  });
}

describe("PixiePage 复用共享 Composer", () => {
  it("在 textarea 上保留 data-testid=pixie-input，并按 Enter 发出 pixie.send", async () => {
    const request = mockPixieHost();
    const user = userEvent.setup();
    render(<PixiePage />);

    const input = await screen.findByTestId("pixie-input");
    await user.type(input, "你好");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pixie.send",
        expect.objectContaining({ expectedHostInstanceId: HOST_ID }),
        { text: "你好" },
        expect.anything(),
      ),
    );
  });

  it("复用模型控件（pixie.models）与 / 命令补全", async () => {
    mockPixieHost();
    const user = userEvent.setup();
    render(<PixiePage />);

    // 模型按钮显示 pixie.models 的当前模型。
    expect(await screen.findByRole("button", { name: "Grok 4.5" })).toBeVisible();

    // 斜杠命令补全：小精灵只列出 /compact。
    await user.type(await screen.findByTestId("pixie-input"), "/");
    expect(await screen.findByText("/compact")).toBeVisible();
  });
});
