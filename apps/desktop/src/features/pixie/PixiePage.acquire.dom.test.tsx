/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettings, HostStatusSnapshot, WorkspaceSnapshot } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { usePixieViewStore } from "./pixie-store";
import { PixiePage } from "./PixiePage";

/**
 * 进页面锚定获取（acquire）的并发回归。
 *
 * React StrictMode 在 dev 下会「挂载 effect → 立即清理 → 再跑一次」，于是进小精灵
 * 页会并发跑两次 acquire：两次都发 workspace.setCurrent（同一 cwd），宿主侧必然撞
 * 一次 SERVICE_GRAPH_BUSY，前端 workspaceSwitchTarget 槽位又互相踩，慢的那次被判
 * 为被取代 → blocked → 页面闪「暂不可用」。生产构建没有这次重放，所以只在 dev 复现。
 */
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CWD = "/workspace/other";
const PIXIE_CWD = "/agent/workspace/pixie";

const host: HostStatusSnapshot = {
  protocolVersion: 1,
  hostInstanceId: HOST_ID,
  workspaceId: "22222222-2222-4222-8222-222222222222",
  workspaceRevision: 1,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 1,
  sdkVersion: "test",
  nodeVersion: process.version,
  agentDir: "/agent",
  phase: "ready",
  capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
  modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
};

const otherWorkspace: WorkspaceSnapshot = {
  id: "33333333-3333-4333-8333-333333333333",
  cwd: OTHER_CWD,
  canonicalCwd: OTHER_CWD,
  revision: 1,
  servicesReady: true,
};

const openSpy = vi.hoisted(() => vi.fn(async () => ({ status: "opened" }) as const));
const activateSpy = vi.hoisted(() => vi.fn(async () => ({ status: "opened" }) as const));

vi.mock("../../lib/bridge/session-navigation", () => ({
  openSessionAcrossWorkspaces: openSpy,
  activateWorkspaceAcrossWorkspaces: activateSpy,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
    if (method === "pixie.ensureCurrent") {
      return {
        ok: true,
        result: { cwd: PIXIE_CWD, sessionId: "live-1", sessionPath: `${PIXIE_CWD}/live-1.jsonl` },
      } as never;
    }
    if (method === "pixie.dispatches") return { ok: true, result: { dispatches: [] } } as never;
    return { ok: true, result: null } as never;
  });
  vi.spyOn(hostClient, "onEvent").mockReturnValue(() => {});
  useAppStore.setState({
    host,
    workspace: otherWorkspace,
    session: null,
    connecting: false,
    rehydrating: false,
    desynchronized: false,
    hostFatal: null,
    activeSubagentNodeId: null,
    desktopSettings: {
      theme: "system",
      language: "zh",
      knownWorkspaces: [],
    } as unknown as DesktopSettings,
  });
  usePixieViewStore.setState({ current: null, dispatches: [], error: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAppStore.getState().setHost(null);
  useAppStore.getState().setWorkspace(null);
  usePixieViewStore.setState({ current: null, dispatches: [], error: null });
});

describe("PixiePage 锚定获取（acquire）", () => {
  it("StrictMode 重放挂载 effect 时只锚定一次，不闪「暂不可用」", async () => {
    render(
      <StrictMode>
        <PixiePage />
      </StrictMode>,
    );

    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    // 给重放的第二次 effect 足够时间落地（若未被拦截，这里会变成 2 次）。
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith({
      cwd: PIXIE_CWD,
      sessionId: "live-1",
      sessionPath: `${PIXIE_CWD}/live-1.jsonl`,
      optimistic: false,
      quiet: true,
    });
    expect(document.body.textContent ?? "").not.toContain("暂不可用");
  });
});
