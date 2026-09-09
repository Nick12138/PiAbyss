/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiSettings } from "./PiSettings";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import type { DesktopSettings, HostStatusSnapshot } from "@piabyss/protocol";

const invokeMock = vi.fn(async () => undefined);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [])),
  isTauri: () => true,
}));

const host: HostStatusSnapshot = {
  hostInstanceId: "11111111-1111-4111-8111-111111111111",
  workspaceId: null,
  workspaceRevision: 0,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 0,
  protocolVersion: 1,
  sdkVersion: "test",
  nodeVersion: "test",
  agentDir: "C:/agent",
  phase: "ready" as const,
  capabilities: { packageUpdateCheck: false, extensionUi: true, sessionExport: true },
  modelConfigHealth: { state: "ok" as const, source: "ModelRegistry.getError" as const },
  extensionDecisionPresentation: "auto" as const,
};

const settings = {
  defaultProvider: "test-provider",
  defaultModel: "test-model",
  defaultThinkingLevel: "medium" as const,
  retryMaxRetries: 3,
  defaultProjectTrust: "ask" as const,
  steeringMode: "one-at-a-time" as const,
  followUpMode: "one-at-a-time" as const,
  models: [
    {
      provider: "test-provider",
      providerName: "Test Provider",
      modelId: "test-model",
      name: "Test Model",
    },
    {
      provider: "test-provider",
      providerName: "Test Provider",
      modelId: "test-model-2",
      name: "Test Model 2",
    },
  ],
};

describe("PiSettings", () => {
  afterEach(() => {
    cleanup();
    useAppStore.getState().setDesktopSettings(null);
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    invokeMock.mockClear();
    useAppStore.getState().setHost(host);
    useAppStore.getState().setDesktopSettings({
      theme: "system",
      language: "en",
      restoreLastSession: true,
      autoRestartHostOnce: true,
      idleSessionCacheLimit: 5,
      idleSessionTimeoutMinutes: 30,
      extensionDecisionPresentation: "auto",
      terminalProfile: "auto",
    });
    vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "piSettings.get") return { ok: true, result: settings } as never;
      return { ok: true, result: settings } as never;
    });
  });

  it("loads and patches the default model", async () => {
    const user = userEvent.setup();
    render(<PiSettings />);
    const modelButton = await screen.findByRole("button", { name: "Default model" });
    await waitFor(() => expect(modelButton).toBeEnabled());
    await user.click(modelButton);
    await user.click(
      within(screen.getByRole("listbox")).getByRole("option", { name: "Test Model 2" }),
    );
    await waitFor(() =>
      expect(hostClient.request).toHaveBeenCalledWith(
        "piSettings.patch",
        { expectedHostInstanceId: host.hostInstanceId },
        { defaultProvider: "test-provider", defaultModel: "test-model-2" },
      ),
    );
  });

  it("patches thinking, retry, trust, and queue modes", async () => {
    const user = userEvent.setup();
    render(<PiSettings />);
    await screen.findByRole("button", { name: "Default model" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Default thinking level" })).toBeEnabled(),
    );

    await user.click(screen.getByRole("button", { name: "Default thinking level" }));
    await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: "High" }));
    await user.click(screen.getByRole("button", { name: "Project trust" }));
    await user.click(
      within(screen.getByRole("listbox")).getByRole("option", { name: "Always trust" }),
    );
    await user.click(screen.getByRole("button", { name: "Steering messages" }));
    await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: "All" }));

    expect(hostClient.request).toHaveBeenCalledWith(
      "piSettings.patch",
      { expectedHostInstanceId: host.hostInstanceId },
      { defaultThinkingLevel: "high" },
    );
    expect(hostClient.request).toHaveBeenCalledWith(
      "piSettings.patch",
      { expectedHostInstanceId: host.hostInstanceId },
      { defaultProjectTrust: "always" },
    );
    expect(hostClient.request).toHaveBeenCalledWith(
      "piSettings.patch",
      { expectedHostInstanceId: host.hostInstanceId },
      { steeringMode: "all" },
    );
  });

  it("persists the idle session cache limit via desktop settings", async () => {
    (
      invokeMock as unknown as { mockImplementation: (fn: (cmd: string) => unknown) => void }
    ).mockImplementation(async (cmd: string) => {
      if (cmd === "desktop_settings_patch") {
        const current = useAppStore.getState().desktopSettings ?? ({} as DesktopSettings);
        const next = { ...current, idleSessionCacheLimit: 8 } as DesktopSettings;
        useAppStore.getState().setDesktopSettings(next);
        return next;
      }
      return undefined;
    });
    render(<PiSettings />);
    await screen.findByRole("button", { name: "Default model" });

    const cacheLimit = screen.getByRole("spinbutton", {
      name: /Idle session queue capacity/,
    });
    fireEvent.change(cacheLimit, { target: { value: "8" } });

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("desktop_settings_patch", {
        patch: { idleSessionCacheLimit: 8 },
      }),
    );
    expect(screen.getByRole("spinbutton", { name: /Idle session queue capacity/ })).toHaveValue(8);
  });

  it("persists the idle session timeout via desktop settings", async () => {
    (
      invokeMock as unknown as { mockImplementation: (fn: (cmd: string) => unknown) => void }
    ).mockImplementation(async (cmd: string) => {
      if (cmd === "desktop_settings_patch") {
        const current = useAppStore.getState().desktopSettings ?? ({} as DesktopSettings);
        const next = { ...current, idleSessionTimeoutMinutes: 45 } as DesktopSettings;
        useAppStore.getState().setDesktopSettings(next);
        return next;
      }
      return undefined;
    });
    render(<PiSettings />);
    await screen.findByRole("button", { name: "Default model" });

    const timeout = screen.getByRole("spinbutton", { name: /Idle session timeout/ });
    fireEvent.change(timeout, { target: { value: "45" } });

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("desktop_settings_patch", {
        patch: { idleSessionTimeoutMinutes: 45 },
      }),
    );
    expect(screen.getByRole("spinbutton", { name: /Idle session timeout/ })).toHaveValue(45);
  });
});
