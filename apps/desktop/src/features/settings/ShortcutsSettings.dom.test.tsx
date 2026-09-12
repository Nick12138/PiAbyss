/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { ShortcutsSettings } from "./ShortcutsSettings";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri,
}));

function settings(shortcutOverrides?: Record<string, string | null>) {
  return {
    theme: "system" as const,
    language: "en" as const,
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "legacy-modal" as const,
    terminalProfile: "auto" as const,
    ...(shortcutOverrides ? { shortcutOverrides } : {}),
  };
}

beforeEach(() => {
  tauriMocks.invoke.mockReset();
  tauriMocks.isTauri.mockReset();
  tauriMocks.isTauri.mockReturnValue(false);
  useAppStore.getState().setDesktopSettings(settings());
  useAppStore.getState().clearNotifications();
});

afterEach(() => {
  cleanup();
  useAppStore.getState().setDesktopSettings(null);
  vi.restoreAllMocks();
});

describe("ShortcutsSettings", () => {
  it("records and immediately applies a platform-logical shortcut", async () => {
    const user = userEvent.setup();
    render(<ShortcutsSettings />);
    const recorder = screen.getByRole("button", {
      name: "Change shortcut for New session",
    });

    await user.click(recorder);
    expect(recorder).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(recorder, { key: "N", ctrlKey: true, shiftKey: true });

    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.shortcutOverrides).toEqual({
        "session.new": "mod+shift+n",
      }),
    );
    expect(screen.getByText("Ctrl+Shift+N")).toBeInTheDocument();
  });

  it("keeps recording and reports conflicts or unsafe plain keys inline", async () => {
    const user = userEvent.setup();
    render(<ShortcutsSettings />);
    const recorder = screen.getByRole("button", {
      name: "Change shortcut for New session",
    });

    await user.click(recorder);
    fireEvent.keyDown(recorder, { key: ",", ctrlKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Ctrl+, is already assigned to Open Settings.",
    );
    expect(recorder).toHaveAttribute("aria-pressed", "true");

    fireEvent.keyDown(recorder, { key: "n" });
    expect(screen.getByText("Include Ctrl or Alt, or use F1-F12.")).toBeInTheDocument();
    expect(useAppStore.getState().desktopSettings?.shortcutOverrides).toBeUndefined();
  });

  it("clears, restores one default, and cancels recording with Escape", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setDesktopSettings(settings({ "session.new": "mod+shift+n" }));
    render(<ShortcutsSettings />);

    await user.click(screen.getByRole("button", { name: "Clear shortcut for New session" }));
    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.shortcutOverrides).toEqual({
        "session.new": null,
      }),
    );
    expect(screen.getByText("Unassigned")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "Restore default shortcut for New session",
      }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.shortcutOverrides).toEqual({}),
    );
    expect(screen.getByText("Ctrl+N")).toBeInTheDocument();

    const recorder = screen.getByRole("button", {
      name: "Change shortcut for New session",
    });
    await user.click(recorder);
    expect(fireEvent.keyDown(recorder, { key: "Escape" })).toBe(false);
    expect(recorder).toHaveAttribute("aria-pressed", "false");
  });

  it("restores every override after confirmation", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setDesktopSettings(
      settings({
        "session.new": "mod+shift+n",
        "chat.stop": null,
      }),
    );
    render(<ShortcutsSettings />);

    await user.click(screen.getByRole("button", { name: "Restore defaults" }));
    const dialog = screen.getByRole("dialog", {
      name: "Restore all default shortcuts?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Restore defaults" }));

    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.shortcutOverrides).toEqual({}),
    );
    expect(screen.getByText("Ctrl+N")).toBeInTheDocument();
    expect(screen.getByText("Esc")).toBeInTheDocument();
  });
});
