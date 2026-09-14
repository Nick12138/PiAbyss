/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { TelegramInstallDialog } from "./TelegramInstallDialog";

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

describe("TelegramInstallDialog", () => {
  beforeEach(() => {
    readyHostState();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("installs the plugin and jumps straight to the token flow on success", async () => {
    const installSpy = vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      method: "package.install",
      id: "1",
      result: { mutations: [], installs: {} },
    } as never);
    const onInstalled = vi.fn();
    render(<TelegramInstallDialog onCancel={vi.fn()} onInstalled={onInstalled} />);

    await waitFor(() => {
      expect(installSpy).toHaveBeenCalledWith(
        "package.install",
        expect.anything(),
        { source: "npm:@llblab/pi-telegram", scope: "user" },
        expect.any(Number),
      );
    });
    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1));
  });

  it("retries PACKAGE_MUTATION_BUSY before giving up", async () => {
    vi.useFakeTimers();
    const installSpy = vi
      .spyOn(hostClient, "request")
      .mockResolvedValueOnce({
        ok: false,
        method: "package.install",
        id: "1",
        error: { code: "PACKAGE_MUTATION_BUSY", message: "Another package operation is running" },
      } as never)
      .mockResolvedValue({
        ok: true,
        method: "package.install",
        id: "1",
        result: { mutations: [], installs: {} },
      } as never);
    const onInstalled = vi.fn();
    render(<TelegramInstallDialog onCancel={vi.fn()} onInstalled={onInstalled} />);

    await vi.advanceTimersByTimeAsync(1500);
    expect(installSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it("retries STALE_REVISION with a fresh host context", async () => {
    vi.useFakeTimers();
    const installSpy = vi
      .spyOn(hostClient, "request")
      .mockResolvedValueOnce({
        ok: false,
        method: "package.install",
        id: "1",
        error: { code: "STALE_REVISION", message: "Session revision mismatch" },
      } as never)
      .mockResolvedValue({
        ok: true,
        method: "package.install",
        id: "1",
        result: { mutations: [], installs: {} },
      } as never);
    const onInstalled = vi.fn();
    render(<TelegramInstallDialog onCancel={vi.fn()} onInstalled={onInstalled} />);

    await vi.advanceTimersByTimeAsync(1500);
    expect(installSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it("surfaces a non-busy install failure with a retry action", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: false,
      method: "package.install",
      id: "1",
      error: { code: "PACKAGE_INSTALL_FAILED", message: "boom" },
    } as never);
    const onCancel = vi.fn();
    render(<TelegramInstallDialog onCancel={onCancel} onInstalled={vi.fn()} />);

    expect(await screen.findByText("boom")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
