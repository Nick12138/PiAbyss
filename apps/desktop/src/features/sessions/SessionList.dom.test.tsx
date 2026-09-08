/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, SessionSummary, WorkspaceSnapshot } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { closeContextMenu } from "../../lib/context-menu";
import { MenuHost } from "../../components/Menu";
import { SessionList } from "./SessionList";

const summary: SessionSummary = {
  sessionId: "session-1",
  sessionPath: "/sessions/session-1.jsonl",
  name: "Position the menu",
  cwd: "/workspace",
  updatedAt: 1,
  messageCount: 1,
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
  cwd: "/workspace",
  canonicalCwd: "/workspace",
  revision: 1,
  servicesReady: true,
};

describe("SessionList actions", () => {
  beforeEach(() => {
    useAppStore.setState({
      host,
      workspace,
      session: null,
      connecting: false,
      rehydrating: false,
      desynchronized: false,
      hostFatal: null,
      sessionCatalog: { workspaceId: null, entries: {}, order: [], loaded: false },
      sessionTerminalStates: {},
      workspaceActivities: {},
    });
    useAppStore.getState().replaceSessionCatalog(workspace.id, [summary]);
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      result: { items: [summary] },
    } as never);
  });

  afterEach(() => {
    closeContextMenu();
    cleanup();
    vi.restoreAllMocks();
  });

  it("archives the session directly when the archive button is clicked", async () => {
    render(<SessionList />);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => {
      expect(hostClient.request).toHaveBeenCalledWith("session.archive", expect.anything(), {
        sessionId: "session-1",
        sessionPath: "/sessions/session-1.jsonl",
      });
    });
  });

  it("unpins the session when the pin button is clicked", () => {
    globalThis.localStorage.setItem(
      "piabyss.sessions.pinned.workspace-1",
      JSON.stringify(["session-1"]),
    );
    render(<SessionList />);

    const unpin = screen.getByRole("button", { name: "Unpin" });
    fireEvent.click(unpin);

    expect(
      JSON.parse(globalThis.localStorage.getItem("piabyss.sessions.pinned.workspace-1") ?? "[]"),
    ).toEqual([]);
    expect(screen.queryByRole("button", { name: "Unpin" })).not.toBeInTheDocument();
  });

  it("exposes reload and archive in the session context menu", async () => {
    render(
      <>
        <MenuHost />
        <SessionList />
      </>,
    );
    fireEvent.contextMenu(screen.getByText("Position the menu"));

    expect(await screen.findByRole("menuitem", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeInTheDocument();
  });

  it("keeps a live session's green dot visible without hover", () => {
    useAppStore.getState().setSessionRuntimeState("session-1", "running", undefined, 10);
    render(<SessionList />);

    expect(screen.getByTitle("Running")).toBeInTheDocument();
  });

  it("keeps the live dot on a session switched away while it is still running", () => {
    useAppStore.getState().setSessionRuntimeState("session-1", "running", undefined, 10);
    // The user switches to another session while session-1 keeps running in
    // the background — its green dot must not disappear with the switch.
    useAppStore.getState().applySessionSnapshot({
      sessionId: "session-2",
      sessionPath: "/sessions/session-2.jsonl",
      cwd: "/workspace",
      revision: 1,
      isIdle: true,
      isStreaming: false,
      isCompacting: false,
      isRetrying: false,
      thinkingLevel: "off",
      autoCompactionEnabled: false,
      autoRetryEnabled: false,
      steeringMode: "all",
      followUpMode: "all",
      pending: { revision: 0, steering: [], followUp: [] },
      messages: [],
      tools: {
        revision: 1,
        workspaceId: "workspace-1",
        sessionId: "session-2",
        sessionRevision: 1,
        tools: [],
        active: [],
      },
    });
    render(<SessionList />);

    expect(screen.getByTitle("Running")).toBeInTheDocument();
  });

  it("hides the archive action while a live (green) dot is showing", () => {
    useAppStore.getState().setSessionRuntimeState("session-1", "running", undefined, 10);
    render(<SessionList />);

    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("hides the archive action while a queued (yellow) dot is showing", () => {
    useAppStore.getState().setSessionRuntimeState("session-1", "queued", undefined, 10);
    render(<SessionList />);

    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it.each([
    ["error (red)", { state: "error", acknowledged: false }],
    ["done (gray)", { state: "done", acknowledged: false }],
  ] as const)(
    "hides the archive action while an unacknowledged %s terminal dot is showing",
    (_label, terminal) => {
      useAppStore.setState({
        sessionTerminalStates: {
          "workspace-1": {
            "session-1": terminal,
          },
        },
      });
      render(<SessionList />);

      expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    },
  );

  it("keeps the restore action for archived sessions (no status dot)", async () => {
    vi.mocked(hostClient.request).mockResolvedValue({
      ok: true,
      result: { items: [{ ...summary, archived: true }] },
    } as never);
    useAppStore.getState().replaceSessionCatalog(workspace.id, [{ ...summary, archived: true }]);
    render(<SessionList />);
    fireEvent.click(screen.getByRole("button", { name: "Show archived sessions (1)" }));

    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("shows an unacknowledged done marker and clears it when reopened", async () => {
    useAppStore.setState({
      sessionTerminalStates: {
        "workspace-1": {
          "session-1": { state: "done", acknowledged: false },
        },
      },
    });
    render(<SessionList />);

    expect(screen.getByTitle("Done")).toBeInTheDocument();

    // Returning to the session acknowledges the marker so it stops showing.
    useAppStore.setState({
      session: {
        sessionId: "session-1",
        sessionPath: "/sessions/session-1.jsonl",
        cwd: "/workspace",
        revision: 2,
        isIdle: true,
        isStreaming: false,
        isCompacting: false,
        isRetrying: false,
        thinkingLevel: "off",
        autoCompactionEnabled: false,
        autoRetryEnabled: false,
        steeringMode: "all",
        followUpMode: "all",
        pending: { revision: 0, steering: [], followUp: [] },
        messages: [],
        tools: {
          revision: 1,
          workspaceId: "workspace-1",
          sessionId: "session-1",
          sessionRevision: 2,
          tools: [],
          active: [],
        },
      },
    });

    await waitFor(() => {
      expect(
        useAppStore.getState().sessionTerminalStates["workspace-1"]?.["session-1"]?.acknowledged,
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByTitle("Done")).not.toBeInTheDocument();
    });
  });

  it("shows an unacknowledged error marker for a failed session", () => {
    useAppStore.setState({
      sessionTerminalStates: {
        "workspace-1": {
          "session-1": { state: "error", acknowledged: false },
        },
      },
    });
    render(<SessionList />);

    expect(screen.getByTitle("Failed")).toBeInTheDocument();
  });

  it("acknowledges a terminal marker when the already-active session is clicked", async () => {
    useAppStore.setState({
      session: {
        sessionId: "session-1",
        sessionPath: "/sessions/session-1.jsonl",
        cwd: "/workspace",
        revision: 2,
        isIdle: true,
        isStreaming: false,
        isCompacting: false,
        isRetrying: false,
        thinkingLevel: "off",
        autoCompactionEnabled: false,
        autoRetryEnabled: false,
        steeringMode: "all",
        followUpMode: "all",
        pending: { revision: 0, steering: [], followUp: [] },
        messages: [{ role: "user", content: "hi" }],
        tools: {
          revision: 1,
          workspaceId: "workspace-1",
          sessionId: "session-1",
          sessionRevision: 2,
          tools: [],
          active: [],
        },
      },
    });
    render(<SessionList />);

    // Completion happens while this session remains active. The focused
    // session hides its sidebar dot, so the marker is not visible even though
    // it exists; clicking the already-active row acknowledges it.
    useAppStore.setState({
      sessionTerminalStates: {
        "workspace-1": {
          "session-1": { state: "done", acknowledged: false, generation: 3 },
        },
      },
    });
    expect(screen.queryByTitle("Done")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Position the menu"));

    await waitFor(() => {
      expect(useAppStore.getState().sessionTerminalStates["workspace-1"]?.["session-1"]).toEqual({
        state: "done",
        acknowledged: true,
        generation: 3,
      });
    });
    expect(screen.queryByTitle("Done")).not.toBeInTheDocument();
  });
});
