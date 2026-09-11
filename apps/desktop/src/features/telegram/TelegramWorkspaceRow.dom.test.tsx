/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, TelegramSessionSummary } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { TelegramWorkspaceRow } from "./TelegramWorkspaceRow";
import { useTelegramViewStore } from "./telegram-view-store";

const TELEGRAM_WORKSPACE_PATH = "C:/agent/workspace/telegram";

const host: HostStatusSnapshot = {
  protocolVersion: 1,
  hostInstanceId: "host-1",
  workspaceId: "workspace-1",
  workspaceRevision: 1,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 1,
  sdkVersion: "0.84.2",
  nodeVersion: "v22",
  agentDir: "C:/agent",
  phase: "ready",
  capabilities: {
    packageUpdateCheck: true,
    extensionUi: true,
    sessionExport: true,
  },
  modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
};

const sessions: TelegramSessionSummary[] = [
  {
    sessionPath: "C:/agent/sessions/--P--/a.jsonl",
    name: "PiAbyss 概览",
    cwd: "C:/work",
    updatedAt: 1787029396000,
    telegramMessageCount: 3,
    preview: "帮我看看这个项目",
  },
];

describe("TelegramWorkspaceRow", () => {
  let refreshTelegramSessions: ReturnType<typeof vi.fn>;
  let refreshBridgeStatus: ReturnType<typeof vi.fn>;
  let startTelegramBridge: ReturnType<typeof vi.fn>;
  let startTelegramBridgeInBackground: ReturnType<typeof vi.fn>;
  let ensureWorkspace: ReturnType<typeof vi.fn>;
  let onActivate: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    refreshTelegramSessions = vi.fn().mockResolvedValue(undefined);
    refreshBridgeStatus = vi.fn().mockResolvedValue(undefined);
    startTelegramBridge = vi.fn().mockResolvedValue(true);
    startTelegramBridgeInBackground = vi.fn().mockResolvedValue(true);
    ensureWorkspace = vi.fn().mockResolvedValue(TELEGRAM_WORKSPACE_PATH);
    onActivate = vi.fn().mockResolvedValue(undefined);
    useTelegramViewStore.setState({
      profile: {
        profile: "default",
        botUsername: "liu_worker_bot",
        botName: "Worker",
        configured: true,
      },
      workspacePath: TELEGRAM_WORKSPACE_PATH,
      sessions,
      loaded: true,
      loading: false,
      error: null,
      bridgeStatus: null,
      bridgeLoading: false,
      refreshTelegramSessions,
      refreshBridgeStatus,
      startTelegramBridge,
      startTelegramBridgeInBackground,
      ensureTelegramWorkspace: ensureWorkspace,
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("hides the telegram row until a profile is added and configured", () => {
    useTelegramViewStore.setState({ profile: null, sessions: [], loaded: true });
    render(<TelegramWorkspaceRow onActivate={onActivate} />);
    expect(screen.queryByText("Telegram")).not.toBeInTheDocument();
    // The row stays mounted invisibly so its config-load duties still run and
    // it appears the moment a profile is saved elsewhere.
    expect(ensureWorkspace).toHaveBeenCalled();
  });

  it("shows the telegram row with the bot handle", () => {
    render(<TelegramWorkspaceRow onActivate={onActivate} />);
    expect(screen.getByText("@liu_worker_bot")).toBeInTheDocument();
  });

  it("switches to the real telegram workspace on click", async () => {
    const user = userEvent.setup();
    render(<TelegramWorkspaceRow onActivate={onActivate} />);
    await user.click(screen.getByRole("button", { name: /@liu_worker_bot/ }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(TELEGRAM_WORKSPACE_PATH);
    // Switching workspaces must NOT auto-start the bridge.
    expect(startTelegramBridge).not.toHaveBeenCalled();
  });

  it("does not auto-start the bridge at app startup", async () => {
    useAppStore.setState({
      host,
      workspace: {
        id: "workspace-folder",
        cwd: "C:/work",
        canonicalCwd: "C:/work",
        revision: 1,
        servicesReady: true,
      },
      session: {
        sessionId: "session-1",
        cwd: "C:/work",
        revision: 1,
        isStreaming: false,
        isIdle: true,
        isCompacting: false,
        isRetrying: false,
        thinkingLevel: "high",
        autoCompactionEnabled: false,
        autoRetryEnabled: false,
        steeringMode: "all",
        followUpMode: "all",
        pending: { revision: 0, steering: [], followUp: [] },
        tools: {
          revision: 0,
          workspaceId: "workspace-folder",
          sessionId: "session-1",
          sessionRevision: 1,
          tools: [],
          active: [],
        },
        messages: [],
      },
      connecting: false,
      rehydrating: false,
      desynchronized: false,
    });
    render(<TelegramWorkspaceRow onActivate={onActivate} />);
    // Startup must never bootstrap the bridge — a configured profile alone is
    // not enough. The bridge only starts via the manual settings switch.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(startTelegramBridgeInBackground).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("does not auto-enter at startup when the bridge preference is off", async () => {
    globalThis.localStorage?.setItem("piabyss.telegram.bridgeEnabled.v1", "0");
    useAppStore.setState({
      host,
      connecting: false,
      rehydrating: false,
      desynchronized: false,
    });
    render(<TelegramWorkspaceRow onActivate={onActivate} />);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onActivate).not.toHaveBeenCalled();
    globalThis.localStorage?.removeItem("piabyss.telegram.bridgeEnabled.v1");
  });

  it("shows a green status dot when the bridge is connected", () => {
    globalThis.localStorage?.setItem("piabyss.telegram.bridgeEnabled.v1", "1");
    useTelegramViewStore.setState({
      bridgeStatus: { connected: true },
      bridgeLoading: false,
    });
    render(<TelegramWorkspaceRow onActivate={onActivate} />);
    const row = screen.getByRole("button", { name: /@liu_worker_bot/ });
    expect(row.querySelector(".bg-success.status-dot-pulse")).not.toBeNull();
    expect(row.querySelector(".bg-danger")).toBeNull();
    globalThis.localStorage?.removeItem("piabyss.telegram.bridgeEnabled.v1");
  });

  it("shows no status dot when the bridge is turned off", () => {
    globalThis.localStorage?.setItem("piabyss.telegram.bridgeEnabled.v1", "0");
    useTelegramViewStore.setState({
      bridgeStatus: { connected: false },
      bridgeLoading: false,
    });
    render(<TelegramWorkspaceRow onActivate={onActivate} />);
    const row = screen.getByRole("button", { name: /@liu_worker_bot/ });
    expect(row.querySelector(".bg-success.status-dot-pulse")).toBeNull();
    expect(row.querySelector(".bg-danger")).toBeNull();
    globalThis.localStorage?.removeItem("piabyss.telegram.bridgeEnabled.v1");
  });

  it("shows no status dot by default when the bridge has never been started", () => {
    // No persisted preference: the bridge is off by default, so a disconnect
    // reading must NOT surface a false red error dot.
    globalThis.localStorage?.removeItem("piabyss.telegram.bridgeEnabled.v1");
    useTelegramViewStore.setState({
      bridgeStatus: { connected: false },
      bridgeLoading: false,
    });
    render(<TelegramWorkspaceRow onActivate={onActivate} />);
    const row = screen.getByRole("button", { name: /@liu_worker_bot/ });
    expect(row.querySelector(".bg-success.status-dot-pulse")).toBeNull();
    expect(row.querySelector(".bg-danger")).toBeNull();
  });

  it("shows a red status dot when the bridge has been turned on but is disconnected", () => {
    globalThis.localStorage?.setItem("piabyss.telegram.bridgeEnabled.v1", "1");
    useTelegramViewStore.setState({
      bridgeStatus: { connected: false },
      bridgeLoading: false,
    });
    render(<TelegramWorkspaceRow onActivate={onActivate} />);
    const row = screen.getByRole("button", { name: /@liu_worker_bot/ });
    expect(row.querySelector(".bg-danger")).not.toBeNull();
    globalThis.localStorage?.removeItem("piabyss.telegram.bridgeEnabled.v1");
  });
});
