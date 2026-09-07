/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesktopSettings, HostStatusSnapshot, WorkspaceSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { WorkspacePicker } from "./WorkspacePicker";
import { useTelegramViewStore } from "../telegram/telegram-view-store";

const desktopSettings: DesktopSettings = {
  theme: "light",
  restoreLastSession: false,
  autoRestartHostOnce: false,
  extensionDecisionPresentation: "auto",
  terminalProfile: "auto",
  language: "en",
  knownWorkspaces: ["/p/alpha", "/p/beta"],
};

const host: HostStatusSnapshot = {
  protocolVersion: 1,
  hostInstanceId: "host-1",
  workspaceId: "workspace-1",
  workspaceRevision: 1,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 1,
  sdkVersion: "0.82.1",
  nodeVersion: process.version,
  agentDir: "/agent",
  phase: "ready",
  capabilities: {
    packageUpdateCheck: true,
    extensionUi: true,
    sessionExport: true,
  },
  modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
};

const workspace: WorkspaceSnapshot = {
  id: "workspace-1",
  cwd: "/p/alpha",
  canonicalCwd: "/p/alpha",
  revision: 1,
  servicesReady: true,
};

describe("WorkspacePicker activity dots", () => {
  beforeEach(() => {
    useAppStore.setState({
      host,
      workspace,
      session: null,
      connecting: false,
      rehydrating: false,
      desynchronized: false,
      hostFatal: null,
      desktopSettings,
      sessionTerminalStates: {},
      workspaceActivities: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows a green dot for a workspace with a running session", () => {
    useAppStore.getState().setWorkspaceActivities({
      "/p/alpha": {
        busy: true,
        hasBeenBusy: true,
        errorCount: 0,
        doneCount: 0,
        terminalSessions: {},
      },
    });
    render(<WorkspacePicker />);

    expect(screen.getByText("alpha").closest("li")).not.toBeNull();
    // The active workspace row carries the green pulse dot.
    const alphaRow = screen.getByText("alpha").closest("li");
    expect(alphaRow?.querySelector(".bg-success.status-dot-pulse")).not.toBeNull();
  });

  it("shows a muted dot for a workspace with unacknowledged completions", () => {
    useAppStore.getState().setWorkspaceActivities({
      "/p/alpha": {
        busy: false,
        hasBeenBusy: true,
        errorCount: 0,
        doneCount: 2,
        terminalSessions: {},
      },
    });
    render(<WorkspacePicker />);

    const alphaRow = screen.getByText("alpha").closest("li");
    expect(alphaRow?.querySelector(".bg-muted")).not.toBeNull();
    expect(alphaRow?.querySelector(".bg-success")).toBeNull();
  });

  it("does not show an activity dot before any session ran or finished", () => {
    useAppStore.getState().setWorkspaceActivities({
      "/p/alpha": {
        busy: false,
        hasBeenBusy: false,
        errorCount: 0,
        doneCount: 0,
        terminalSessions: {},
      },
    });
    render(<WorkspacePicker />);

    const alphaRow = screen.getByText("alpha").closest("li");
    expect(alphaRow?.querySelector(".bg-success")).toBeNull();
    expect(alphaRow?.querySelector(".bg-muted")).toBeNull();
    expect(alphaRow?.querySelector(".bg-warning")).toBeNull();
    expect(alphaRow?.querySelector(".bg-danger")).toBeNull();
  });

  it("falls back to a warning dot only for a services-not-ready active workspace", () => {
    useAppStore.setState({
      workspace: { ...workspace, servicesReady: false },
    });
    useAppStore.getState().setWorkspaceActivities({
      "/p/alpha": {
        busy: false,
        hasBeenBusy: false,
        errorCount: 0,
        doneCount: 0,
        terminalSessions: {},
      },
    });
    render(<WorkspacePicker />);

    const alphaRow = screen.getByText("alpha").closest("li");
    expect(alphaRow?.querySelector(".bg-warning")).not.toBeNull();
  });

  it("shows a red dot whenever a session failed unacknowledged, even while another runs", () => {
    useAppStore.getState().setWorkspaceActivities({
      "/p/alpha": {
        busy: true,
        hasBeenBusy: true,
        errorCount: 1,
        doneCount: 1,
        terminalSessions: {},
      },
    });
    render(<WorkspacePicker />);

    const alphaRow = screen.getByText("alpha").closest("li");
    expect(alphaRow?.querySelector(".bg-danger.status-dot-pulse")).not.toBeNull();
    expect(alphaRow?.querySelector(".bg-success")).toBeNull();
  });

  it("downgrades to green while a session still runs once failures are acknowledged", () => {
    useAppStore.getState().setWorkspaceActivities({
      "/p/alpha": {
        busy: true,
        hasBeenBusy: true,
        errorCount: 0,
        doneCount: 1,
        terminalSessions: {},
      },
    });
    render(<WorkspacePicker />);

    const alphaRow = screen.getByText("alpha").closest("li");
    expect(alphaRow?.querySelector(".bg-success.status-dot-pulse")).not.toBeNull();
    expect(alphaRow?.querySelector(".bg-danger")).toBeNull();
  });

  it("shows no dot once every terminal marker is acknowledged and nothing runs", () => {
    useAppStore.getState().setWorkspaceActivities({
      "/p/alpha": {
        busy: false,
        hasBeenBusy: true,
        errorCount: 0,
        doneCount: 0,
        terminalSessions: {},
      },
    });
    render(<WorkspacePicker />);

    const alphaRow = screen.getByText("alpha").closest("li");
    expect(alphaRow?.querySelector(".bg-muted")).toBeNull();
    expect(alphaRow?.querySelector(".bg-success")).toBeNull();
    expect(alphaRow?.querySelector(".bg-danger")).toBeNull();
  });

  it("single-selects: the folder workspace loses its highlight while the telegram workspace is active", () => {
    render(<WorkspacePicker />);
    const alphaRow = screen.getByText("alpha").closest("li");
    expect(alphaRow?.querySelector("button")?.getAttribute("aria-current")).toBe("true");

    // Entering the telegram workspace switches the real workspace path; the
    // folder rows must lose their highlight (single-selection semantics).
    useTelegramViewStore.setState({ workspacePath: "/agent/workspace/telegram" });
    act(() =>
      useAppStore.setState({
        workspace: {
          ...workspace,
          id: "workspace-tg",
          cwd: "/agent/workspace/telegram",
          canonicalCwd: "/agent/workspace/telegram",
        },
      }),
    );
    expect(alphaRow?.querySelector("button")?.getAttribute("aria-current")).not.toBe("true");

    act(() =>
      useAppStore.setState({
        workspace: { ...workspace, id: "workspace-1", cwd: "/p/alpha", canonicalCwd: "/p/alpha" },
      }),
    );
    expect(alphaRow?.querySelector("button")?.getAttribute("aria-current")).toBe("true");
  });
});
