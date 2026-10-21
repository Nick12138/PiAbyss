/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteStatus, HostStatusSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { RemoteSettings } from "./RemoteSettings";

const requestMock =
  vi.fn<(method: string, context: unknown, params: unknown) => Promise<unknown>>();
const openMock = vi.fn(async () => undefined);

vi.mock("../../lib/bridge/host-client", () => ({
  hostClient: {
    request: (...args: unknown[]) => requestMock(...(args as [string, unknown, unknown])),
  },
}));
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: (...args: unknown[]) => openMock(...(args as [])),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => undefined,
  isTauri: () => true,
}));

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: "11111111-1111-4111-8111-111111111111",
    workspaceId: null,
    workspaceRevision: 0,
    sessionId: null,
    sessionRevision: 0,
    packageRevision: 1,
    sdkVersion: "1.1.0",
    nodeVersion: "v24.18.0",
    agentDir: "/agent",
    phase: "ready",
    capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: false },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function makeStatus(overrides: Partial<RemoteStatus> = {}): RemoteStatus {
  const base: RemoteStatus = {
    settings: {
      enabled: false,
      autoStart: true,
      serverUrl: "",
      uvPath: null,
      pypiIndex: null,
      connectorSource: "git+https://example.invalid/connector",
    },
    stage: "idle",
    steps: [
      { id: "uv", state: "pending", detail: null },
      { id: "python", state: "pending", detail: null },
      { id: "connector", state: "pending", detail: null },
      { id: "verify", state: "pending", detail: null },
    ],
    error: null,
    versions: { uv: null, python: null, connector: null },
    paths: {
      installDir: "/agent/piabyss/remote",
      dataDir: "/home/me/.agents-anywhere",
      connectorConfigPath: "/home/me/.agents-anywhere/connector.json",
      connectorLogPath: "/agent/piabyss/remote/connector.log",
      installLogPath: "/agent/piabyss/remote/install.log",
    },
    connector: {
      state: "unconfigured",
      pid: null,
      source: null,
      serverUrl: null,
      connectorId: null,
      configured: false,
    },
    pairing: "idle",
    activeServerOrigin: "https://web.agents-anywhere.com",
    logTail: [],
    runtime: "missing",
    updatedAt: 1,
  };
  return { ...base, ...overrides };
}

function respond(result: RemoteStatus) {
  return Promise.resolve({ ok: true, result });
}

beforeEach(() => {
  requestMock.mockReset();
  openMock.mockClear();
  useAppStore.getState().setHost(host());
  useAppStore.getState().setDesktopSettings({
    theme: "system",
    language: "en",
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "legacy-modal",
    terminalProfile: "auto",
  });
});

afterEach(() => {
  cleanup();
  useAppStore.getState().setHost(null);
  useAppStore.getState().setDesktopSettings(null);
});

describe("RemoteSettings", () => {
  it("shows the gate and installs from a single click", async () => {
    const gate = makeStatus();
    const installing = makeStatus({
      settings: { ...gate.settings, enabled: true },
      stage: "installing",
      steps: [
        { id: "uv", state: "running", detail: null },
        { id: "python", state: "pending", detail: null },
        { id: "connector", state: "pending", detail: null },
        { id: "verify", state: "pending", detail: null },
      ],
    });
    requestMock.mockImplementation(async (method) => {
      if (method === "remote.getStatus") return respond(gate);
      if (method === "remote.configure") return respond(installing);
      return respond(installing);
    });

    render(<RemoteSettings />);
    const enable = await screen.findByRole("button", { name: /Enable and install/i });
    await userEvent.click(enable);

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("remote.configure", expect.anything(), {
        enabled: true,
      });
      expect(requestMock).toHaveBeenCalledWith("remote.install", expect.anything(), null);
    });
    expect(await screen.findByText(/Installing remote-control dependencies/i)).toBeInTheDocument();
  });

  it("renders install progress with the step list and log", async () => {
    requestMock.mockResolvedValue({
      ok: true,
      result: makeStatus({
        settings: { ...makeStatus().settings, enabled: true },
        stage: "installing",
        steps: [
          { id: "uv", state: "done", detail: "uv 0.9.0" },
          { id: "python", state: "running", detail: null },
          { id: "connector", state: "pending", detail: null },
          { id: "verify", state: "pending", detail: null },
        ],
        logTail: ["install started", "downloading uv"],
      }),
    });
    render(<RemoteSettings />);
    expect(await screen.findByText("Prepare uv")).toBeInTheDocument();
    expect(screen.getByText("Install Python 3.12")).toBeInTheDocument();
    expect(screen.getByText(/downloading uv/)).toBeInTheDocument();
  });

  it("shows the failure and retries the install", async () => {
    const failed = makeStatus({
      settings: { ...makeStatus().settings, enabled: true },
      stage: "failed",
      error: "network unreachable",
      steps: [
        { id: "uv", state: "done", detail: null },
        { id: "python", state: "pending", detail: null },
        { id: "connector", state: "failed", detail: "network unreachable" },
        { id: "verify", state: "pending", detail: null },
      ],
    });
    requestMock.mockImplementation(async (method) => {
      if (method === "remote.getStatus") return respond(failed);
      return respond(failed);
    });

    render(<RemoteSettings />);
    expect(await screen.findByText(/Installation failed/i)).toBeInTheDocument();
    expect(screen.getByText("network unreachable")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Retry$/i }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("remote.install", expect.anything(), null),
    );
  });

  it("reflects the detected pi runtime state", async () => {
    requestMock.mockResolvedValue({
      ok: true,
      result: makeStatus({
        settings: { ...makeStatus().settings, enabled: true },
        stage: "installed",
        runtime: "ready",
      }),
    });
    render(<RemoteSettings />);
    expect(await screen.findByText("Pi runtime ready")).toBeInTheDocument();
    expect(screen.getByText(/installed connector includes the Pi runtime/i)).toBeInTheDocument();
  });

  it("reinstalls with the current connector source", async () => {
    requestMock.mockResolvedValue({
      ok: true,
      result: makeStatus({
        settings: { ...makeStatus().settings, enabled: true },
        stage: "installed",
      }),
    });
    render(<RemoteSettings />);
    await userEvent.click(await screen.findByRole("button", { name: /^Show$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /Reinstall dependencies/i }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("remote.install", expect.anything(), null),
    );
  });

  it("shows the management view and generates a pairing code", async () => {
    const ready = makeStatus({
      settings: { ...makeStatus().settings, enabled: true },
      stage: "installed",
      versions: { uv: "uv 0.9.0", python: "3.12", connector: "2.1.0" },
      connector: {
        state: "running",
        pid: 4321,
        source: "piabyss",
        serverUrl: "https://aa.example.com",
        connectorId: "conn_1",
        configured: true,
      },
    });
    requestMock.mockImplementation(async (method) => {
      if (method === "remote.pairStart") {
        return {
          ok: true,
          result: {
            pairingId: "pair_1",
            code: "ABC123",
            webUrl: "https://web.agents-anywhere.com",
            expiresAt: Date.now() + 60_000,
          },
        };
      }
      return respond(ready);
    });

    render(<RemoteSettings />);
    expect(await screen.findByText("Connector running")).toBeInTheDocument();
    expect(screen.getByText("conn_1")).toBeInTheDocument();
    expect(screen.getByText("2.1.0")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Pair again/i }));
    expect(await screen.findByText("ABC123")).toBeInTheDocument();
    expect(requestMock).toHaveBeenCalledWith("remote.pairStart", expect.anything(), null);
    await waitFor(() => expect(openMock).toHaveBeenCalled());
  });

  it("confirms before uninstalling", async () => {
    const ready = makeStatus({
      settings: { ...makeStatus().settings, enabled: true },
      stage: "installed",
    });
    requestMock.mockImplementation(async (method) => {
      if (method === "remote.uninstall") return respond(makeStatus());
      return respond(ready);
    });

    render(<RemoteSettings />);
    await screen.findByText("Connection");
    await userEvent.click(screen.getByRole("button", { name: /^Show$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^Uninstall$/i }));
    expect(await screen.findByText(/Uninstall remote-control dependencies\?/i)).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^Uninstall$/i }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("remote.uninstall", expect.anything(), null),
    );
  });
});
