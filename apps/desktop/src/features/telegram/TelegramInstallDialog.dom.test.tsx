/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { TelegramInstallDialog } from "./TelegramInstallDialog";
import {
  installTelegramPlugin,
  type TelegramPluginInstallOutcome,
} from "../../lib/bridge/tauri-transport";

vi.mock("../../lib/bridge/tauri-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge/tauri-transport")>();
  return {
    ...actual,
    installTelegramPlugin: vi.fn(),
  };
});

const installTransportMock = vi.mocked(installTelegramPlugin);

const TELEGRAM_WORKSPACE_PATH = "/agent/workspace/telegram";

function readyHostState() {
  useAppStore.setState({
    host: {
      protocolVersion: 1,
      hostInstanceId: "host-1",
      workspaceId: "w-1",
      workspaceRevision: 1,
      sessionId: null,
      sessionRevision: 0,
      packageRevision: 1,
      sdkVersion: "0.82.1",
      nodeVersion: process.version,
      agentDir: "/agent",
      phase: "ready",
      capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
      modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
    },
    workspace: { id: "w-1", cwd: "/p", canonicalCwd: "/p", revision: 1, servicesReady: true },
  });
}

/** telegram.getConfig response; other host requests (package.list/remove for
 *  migration) are mocked per test. */
function mockTelegramConfigRequest() {
  return vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
    if (method === "telegram.getConfig") {
      return {
        ok: true,
        method,
        id: "cfg",
        result: {
          default: null,
          workspacePath: TELEGRAM_WORKSPACE_PATH,
          pluginInstalled: false,
          pluginScope: null,
        },
      } as never;
    }
    throw new Error(`unexpected host request in test: ${method}`);
  });
}

function outcome(
  overrides: Partial<TelegramPluginInstallOutcome> = {},
): TelegramPluginInstallOutcome {
  return { ok: true, ...overrides };
}

describe("TelegramInstallDialog", () => {
  beforeEach(() => {
    readyHostState();
    installTransportMock.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("installs into the telegram workspace at project scope and jumps to the token flow", async () => {
    const requestSpy = mockTelegramConfigRequest();
    installTransportMock.mockResolvedValue(outcome());
    const onInstalled = vi.fn();
    render(<TelegramInstallDialog onCancel={vi.fn()} onInstalled={onInstalled} />);

    await waitFor(() => {
      expect(installTransportMock).toHaveBeenCalledWith(
        TELEGRAM_WORKSPACE_PATH,
        "npm:@llblab/pi-telegram",
      );
    });
    // The renderer never issues a user-scope package.install itself.
    expect(requestSpy.mock.calls.every(([method]) => method === "telegram.getConfig")).toBe(true);
    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1));
  });

  it("migrate mode removes the legacy user-scope record after the project install", async () => {
    const requestSpy = mockTelegramConfigRequest().mockImplementation(async (method) => {
      if (method === "telegram.getConfig") {
        return {
          ok: true,
          method,
          id: "cfg",
          result: {
            default: null,
            workspacePath: TELEGRAM_WORKSPACE_PATH,
            pluginInstalled: true,
            pluginScope: "user",
          },
        } as never;
      }
      if (method === "package.list") {
        return {
          ok: true,
          method,
          id: "list",
          result: {
            revision: 1,
            workspaceId: "w-1",
            scope: "all",
            configured: [
              {
                id: "user::npm:@llblab/pi-telegram",
                identity: "npm:@llblab/pi-telegram",
                source: "npm:@llblab/pi-telegram",
                scope: "user",
                installed: true,
                displayName: "pi-telegram",
              },
            ],
            resources: [],
            diagnostics: [],
            updateCheck: { supported: true },
            resourceReloadRequired: false,
          },
        } as never;
      }
      if (method === "package.remove") {
        return { ok: true, method, id: "rm", result: {} } as never;
      }
      throw new Error(`unexpected host request in test: ${method}`);
    });
    installTransportMock.mockResolvedValue(outcome());
    const onInstalled = vi.fn();
    render(<TelegramInstallDialog mode="migrate" onCancel={vi.fn()} onInstalled={onInstalled} />);

    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1));
    const removeCall = requestSpy.mock.calls.find(([m]) => m === "package.remove");
    expect(removeCall?.[2]).toEqual({ packageId: "user::npm:@llblab/pi-telegram" });
  });

  it("retries PACKAGE_MUTATION_BUSY before giving up", async () => {
    vi.useFakeTimers();
    mockTelegramConfigRequest();
    installTransportMock
      .mockResolvedValueOnce(
        outcome({
          ok: false,
          errorCode: "PACKAGE_MUTATION_BUSY",
          errorMessage: "Another package operation is running",
        }),
      )
      .mockResolvedValue(outcome());
    const onInstalled = vi.fn();
    render(<TelegramInstallDialog onCancel={vi.fn()} onInstalled={onInstalled} />);

    await vi.advanceTimersByTimeAsync(1500);
    expect(installTransportMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it("retries STALE_REVISION with fresh host state", async () => {
    vi.useFakeTimers();
    mockTelegramConfigRequest();
    installTransportMock
      .mockResolvedValueOnce(
        outcome({
          ok: false,
          errorCode: "STALE_REVISION",
          errorMessage: "Session revision mismatch",
        }),
      )
      .mockResolvedValue(outcome());
    const onInstalled = vi.fn();
    render(<TelegramInstallDialog onCancel={vi.fn()} onInstalled={onInstalled} />);

    await vi.advanceTimersByTimeAsync(1500);
    expect(installTransportMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it("surfaces a non-busy install failure with a retry action", async () => {
    mockTelegramConfigRequest();
    installTransportMock.mockResolvedValue(
      outcome({ ok: false, errorCode: "PACKAGE_INSTALL_FAILED", errorMessage: "boom" }),
    );
    const onCancel = vi.fn();
    render(<TelegramInstallDialog onCancel={onCancel} onInstalled={vi.fn()} />);

    expect(await screen.findByText("boom")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
