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

async function openToolDialog() {
  const user = userEvent.setup();
  const entry = await screen.findByRole("button", { name: /^Configure/ });
  await user.click(entry);
  return screen.findByRole("dialog");
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

    const dialog = await openToolDialog();
    const group = within(dialog).getByRole("group", { name: "Default tools" });
    expect(within(group).getByRole("checkbox", { name: /Read/ })).toBeChecked();
    expect(within(group).getByRole("checkbox", { name: /Run/ })).toBeChecked();
    expect(within(group).getByRole("checkbox", { name: /Edit/ })).toBeChecked();
    expect(within(group).getByRole("checkbox", { name: /Write/ })).toBeChecked();
    expect(within(group).getByRole("checkbox", { name: /Grep/ })).not.toBeChecked();
    expect(within(group).getByRole("checkbox", { name: /Find/ })).not.toBeChecked();
    expect(within(group).getByRole("checkbox", { name: /List/ })).not.toBeChecked();
  });

  it("mirrors a stored selection and sends the saved draft to piSettings.patch", async () => {
    const user = userEvent.setup();
    const request = vi
      .spyOn(hostClient, "request")
      .mockImplementation(((method: string, _context: unknown, payload: unknown) =>
        Promise.resolve(
          settingsResult(
            method === "piSettings.patch"
              ? ((payload as { defaultTools?: string[] } | null)?.defaultTools ?? [
                  "read",
                  "bash",
                  "grep",
                ])
              : ["read", "bash", "grep"],
          ) as never,
        )) as unknown as typeof hostClient.request);
    render(<DefaultToolsSetting />);

    const dialog = await openToolDialog();
    const group = within(dialog).getByRole("group", { name: "Default tools" });
    await waitFor(() =>
      expect(within(group).getByRole("checkbox", { name: /Grep/ })).toBeChecked(),
    );

    await user.click(within(group).getByRole("checkbox", { name: /List/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        "piSettings.patch",
        { expectedHostInstanceId: CONNECTED_HOST.hostInstanceId },
        { defaultTools: ["read", "bash", "grep", "ls"] },
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^Configure/ })).toHaveAccessibleName(/4/);
  });

  it("keeps the dialog selection pending until Save and discards it on Cancel", async () => {
    const user = userEvent.setup();
    vi.spyOn(hostClient, "request")
      .mockResolvedValueOnce(settingsResult(["read", "bash"]) as never)
      // piSettings.get is not re-issued on cancel, so the mock stays unused.
      .mockResolvedValue(settingsResult(["read", "bash"]) as never);
    render(<DefaultToolsSetting />);

    const dialog = await openToolDialog();
    const group = within(dialog).getByRole("group", { name: "Default tools" });
    await waitFor(() =>
      expect(within(group).getByRole("checkbox", { name: /Read/ })).toBeChecked(),
    );

    await user.click(within(group).getByRole("checkbox", { name: /Grep/ }));
    expect(within(group).getByRole("checkbox", { name: /Grep/ })).toBeChecked();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const entry = screen.getByRole("button", { name: /^Configure/ });
    expect(entry).toHaveAccessibleName(/2/);
    const request = vi.mocked(hostClient.request);
    expect(request.mock.calls.filter(([method]) => method === "piSettings.patch")).toHaveLength(0);
  });

  it("rolls the saved value back when the Host rejects the patch", async () => {
    const user = userEvent.setup();
    vi.spyOn(hostClient, "request")
      .mockResolvedValueOnce(settingsResult(["read", "bash"]) as never)
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "disk full" },
      } as never);
    render(<DefaultToolsSetting />);

    const dialog = await openToolDialog();
    const group = within(dialog).getByRole("group", { name: "Default tools" });
    await waitFor(() =>
      expect(within(group).getByRole("checkbox", { name: /Read/ })).toBeChecked(),
    );

    await user.click(within(group).getByRole("checkbox", { name: /Grep/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    const entry = await screen.findByRole("button", { name: /^Configure/ });
    expect(entry).toHaveAccessibleName(/2/);
  });
});
