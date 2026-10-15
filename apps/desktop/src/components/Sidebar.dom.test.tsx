/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, WorkspaceSnapshot } from "@piabyss/protocol";
import { hostClient } from "../lib/bridge/host-client";
import { useAppStore } from "../lib/stores/app-store";
import { SidebarLayout } from "./Sidebar";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
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

const pixieWorkspace: WorkspaceSnapshot = {
  id: "33333333-3333-4333-8333-333333333333",
  cwd: PIXIE_CWD,
  canonicalCwd: PIXIE_CWD,
  revision: 1,
  servicesReady: true,
};

describe("Sidebar「新会话」（小精灵页）", () => {
  beforeEach(() => {
    useAppStore.setState({
      host,
      workspace: pixieWorkspace,
      session: null,
      page: "pixie",
      connecting: false,
      rehydrating: false,
      desynchronized: false,
      hostFatal: null,
    });
    vi.spyOn(hostClient, "request").mockResolvedValue({ ok: true, result: null } as never);
    vi.spyOn(hostClient, "onEvent").mockReturnValue(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useAppStore.getState().setPage("chat");
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
  });

  it("建在 pixie 工作区自己身上，且不离开小精灵页", async () => {
    // 小精灵页的会话列表与「新会话」同属 pixie 工作区：点「新会话」= 开一条
    // 新的小精灵会话。曾经的分流是「先切回进入小精灵前的工作区再建」，
    // 那与左下列表显示的会话不再是同一个工作区，已废。
    const user = userEvent.setup();
    render(<SidebarLayout page="pixie" setPage={useAppStore.getState().setPage} />);

    await user.click(screen.getByRole("button", { name: "New conversation" }));

    await waitFor(() =>
      expect(hostClient.request).toHaveBeenCalledWith(
        "session.create",
        expect.objectContaining({
          expectedHostInstanceId: HOST_ID,
          expectedWorkspaceId: pixieWorkspace.id,
        }),
        {},
      ),
    );
    expect(useAppStore.getState().page).toBe("pixie");
  });
});
