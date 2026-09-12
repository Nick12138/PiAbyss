/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiSettingsSnapshot } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { DefaultToolsSetting } from "./DefaultToolsSetting";

const CONNECTED_HOST = {
  protocolVersion: 1 as const,
  hostInstanceId: "11111111-1111-4111-8111-111111111111",
  agentDir: "/agent",
  phase: "waitingForWorkspace" as const,
};

function settingsResult(defaultTools?: string[]): { ok: true; result: PiSettingsSnapshot } {
  return {
    ok: true,
    result: {
      defaultThinkingLevel: "medium",
      retryMaxRetries: 3,
      defaultProjectTrust: "ask",
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      ...(defaultTools ? { defaultTools } : {}),
      models: [],
    },
  };
}

beforeEach(() => {
  useAppStore.getState().setHost(CONNECTED_HOST as never);
  useAppStore.getState().setDesktopSettings({
    theme: "system",
    language: "en",
    autoStartOnBoot: false,
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "auto",
    terminalProfile: "auto",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAppStore.getState().setHost(null);
});

describe("DefaultToolsSetting", () => {
  it("selects exactly the four SDK defaults when the setting is absent", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue(settingsResult() as never);
    render(<DefaultToolsSetting />);

    const group = screen.getByRole("group", { name: "Default tools" });
    expect(within(group).getByRole("checkbox", { name: /Read/ })).toBeChecked();
    expect(within(group).getByRole("checkbox", { name: /Run/ })).toBeChecked();
    expect(within(group).getByRole("checkbox", { name: /Edit/ })).toBeChecked();
    expect(within(group).getByRole("checkbox", { name: /Write/ })).toBeChecked();
    expect(within(group).getByRole("checkbox", { name: /Grep/ })).not.toBeChecked();
    expect(within(group).getByRole("checkbox", { name: /Find/ })).not.toBeChecked();
    expect(within(group).getByRole("checkbox", { name: /List/ })).not.toBeChecked();
  });

  it("mirrors a stored selection and sends the toggle to piSettings.patch", async () => {
    const user = userEvent.setup();
    const request = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue(settingsResult(["read", "bash", "grep"]) as never);
    render(<DefaultToolsSetting />);

    const group = screen.getByRole("group", { name: "Default tools" });
    await waitFor(() =>
      expect(within(group).getByRole("checkbox", { name: /Grep/ })).toBeChecked(),
    );

    await user.click(within(group).getByRole("checkbox", { name: /List/ }));
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        "piSettings.patch",
        { expectedHostInstanceId: CONNECTED_HOST.hostInstanceId },
        { defaultTools: ["read", "bash", "grep", "ls"] },
      ),
    );
  });

  it("rolls the checkbox back when the Host rejects the patch", async () => {
    const user = userEvent.setup();
    vi.spyOn(hostClient, "request")
      .mockResolvedValueOnce(settingsResult(["read", "bash"]) as never)
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "disk full" },
      } as never);
    render(<DefaultToolsSetting />);

    const group = screen.getByRole("group", { name: "Default tools" });
    await waitFor(() =>
      expect(within(group).getByRole("checkbox", { name: /Read/ })).toBeChecked(),
    );

    await user.click(within(group).getByRole("checkbox", { name: /Grep/ }));
    await waitFor(() =>
      expect(within(group).getByRole("checkbox", { name: /Grep/ })).not.toBeChecked(),
    );
  });
});
