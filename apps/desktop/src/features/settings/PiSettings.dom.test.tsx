/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiSettings } from "./PiSettings";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import type { HostStatusSnapshot } from "@piabyss/protocol";

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
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    useAppStore.getState().setHost(host);
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
});
