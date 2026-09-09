/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { SettingsPage } from "./SettingsPage";
import { hostClient } from "../../lib/bridge/host-client";

const CONNECTED_HOST = {
  protocolVersion: 1 as const,
  hostInstanceId: "11111111-1111-4111-8111-111111111111",
  workspaceId: null,
  workspaceRevision: 0,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 0,
  sdkVersion: "0.82.1",
  nodeVersion: "v24.18.0",
  agentDir: "/agent",
  phase: "waitingForWorkspace" as const,
  capabilities: {
    packageUpdateCheck: false,
    extensionUi: true as const,
    sessionExport: true,
  },
  modelConfigHealth: {
    state: "ok" as const,
    source: "ModelRegistry.getError" as const,
  },
  extensionDecisionPresentation: "legacy-modal" as const,
};

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri,
}));

beforeEach(() => {
  tauriMocks.invoke.mockReset();
  tauriMocks.invoke.mockRejectedValue(new Error("Tauri unavailable"));
  tauriMocks.isTauri.mockReset();
  tauriMocks.isTauri.mockReturnValue(false);
  useAppStore.getState().setHost(null);
  useAppStore.getState().setProvidersDirty(false);
  useAppStore.getState().clearNotifications();
  useAppStore.getState().setDesktopSettings({
    theme: "system",
    language: "en",
    restoreLastSession: true,
    autoStartOnBoot: false,
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "legacy-modal",
    terminalProfile: "auto",
  });
});

afterEach(() => {
  cleanup();
  useAppStore.getState().setProvidersDirty(false);
  useAppStore.getState().setDesktopSettings(null);
  document.documentElement.removeAttribute("data-interface-density");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-family");
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.style.removeProperty("--conversation-font-size");
  document.documentElement.style.removeProperty("--code-font-size");
  vi.restoreAllMocks();
});

describe("SettingsPage navigation guard", () => {
  it("does not render a dock toggle inside the Settings page (moved to AppTopBar)", () => {
    useAppStore.setState({ dockOpen: false });
    const { container } = render(<SettingsPage initialSection="general" />);

    expect(container.querySelector("[data-settings-dock-toggle]")).toBeNull();
    expect(container.querySelector("[data-dock-toolbar-toggle]")).toBeNull();
  });

  it("renders nav in the aside and content side-by-side under the shell", () => {
    const { container } = render(<SettingsPage initialSection="general" />);

    const shell = container.querySelector("[data-settings-shell]");
    const sidebar = container.querySelector("[data-settings-sidebar]");
    const content = container.querySelector("[data-settings-content]");

    expect(sidebar?.parentElement?.parentElement).toBe(shell);
    expect(content?.parentElement?.parentElement).toBe(shell);
    // Standalone render (no AppTopBar host) still shows an inline section header.
    expect(container.querySelector("[data-settings-section-header]")).not.toBeNull();
  });

  it("places Shortcuts last in the settings sidebar", () => {
    render(<SettingsPage initialSection="general" />);

    const navigation = screen.getByRole("navigation");
    expect(
      within(navigation)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      "General",
      "Appearance",
      "Providers",
      "Skills",
      "Plugin Library",
      "Packages",
      "Usage",
      "Host",
      "Shortcuts",
    ]);
  });

  it("persists the steer behavior for messages sent while the agent is running", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="general" />);

    const behavior = screen.getByRole("button", { name: "Send while running" });
    expect(behavior).toHaveTextContent("Send after it finishes");

    await user.click(behavior);
    await user.click(screen.getByRole("option", { name: "Send immediately" }));
    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.busySendBehavior).toBe("steer"),
    );
    expect(behavior).toHaveTextContent("Send immediately");
  });

  it("persists the system notification toggle from General", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="general" />);

    const toggle = screen.getByRole("switch", { name: "System notifications" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await user.click(toggle);
    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.systemNotificationsEnabled).toBe(false),
    );
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("keeps startup controls in General and moves interface controls to Appearance", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="general" />);

    expect(screen.getByText("Startup")).toBeInTheDocument();
    expect(screen.getByText("Restore last session")).toBeInTheDocument();
    expect(screen.getByText("Launch at startup")).toBeInTheDocument();
    expect(screen.queryByText("Auto-restart Pi Host")).not.toBeInTheDocument();
    expect(screen.queryByText("Shared Host process")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Theme/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Language/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("spinbutton", { name: "Conversation width" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Appearance" }));

    expect(
      screen.getByRole("heading", {
        name: "Theme, density, language, and conversation typography",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Appearance" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Appearance" })).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(screen.getByRole("button", { name: "General" })).toHaveAttribute(
      "data-state",
      "inactive",
    );
    expect(screen.getByRole("group", { name: "Theme style" })).toBeInTheDocument();
    expect(screen.getByLabelText("Color mode")).toBeInTheDocument();
    expect(screen.getByLabelText(/Language/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Interface density" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Conversation font size" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Code font size" })).toBeInTheDocument();
    expect(screen.queryByText("Restore last session")).not.toBeInTheDocument();
  });

  it("persists density and typography controls and applies them immediately", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="appearance" />);

    const density = screen.getByRole("group", { name: "Interface density" });
    await user.click(within(density).getByRole("button", { name: "Compact" }));
    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.interfaceDensity).toBe("compact"),
    );
    expect(document.documentElement.dataset.interfaceDensity).toBe("compact");

    await user.click(screen.getByRole("button", { name: "Increase Conversation font size" }));
    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.conversationFontSize).toBe(16),
    );
    expect(document.documentElement.style.getPropertyValue("--conversation-font-size")).toBe(
      "16px",
    );

    await user.click(screen.getByRole("button", { name: "Increase Code font size" }));
    await waitFor(() => expect(useAppStore.getState().desktopSettings?.codeFontSize).toBe(13));
    expect(document.documentElement.style.getPropertyValue("--code-font-size")).toBe("13px");
    expect(screen.getByText("Readable conversation text with inline code.")).toBeInTheDocument();
    expect(screen.getByText("16px")).toBeInTheDocument();
    expect(screen.getByText("13px")).toBeInTheDocument();
  });

  it("persists the conversation min and max width from Appearance settings", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="appearance" />);

    const maxWidth = screen.getByRole("spinbutton", { name: "Conversation max width" });
    const minWidth = screen.getByRole("spinbutton", { name: "Conversation min width" });
    expect(maxWidth).toHaveValue(600);
    expect(minWidth).toHaveValue(350);

    await user.clear(maxWidth);
    await user.type(maxWidth, "1200");
    await user.tab();
    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.conversationMaxWidth).toBe(1200),
    );

    await user.clear(minWidth);
    await user.type(minWidth, "640");
    await user.tab();
    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.conversationMinWidth).toBe(640),
    );
  });

  it("persists the theme family separately from the color mode", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="appearance" />);
    const themeStyle = screen.getByRole("group", { name: "Theme style" });
    const piabyss = within(themeStyle).getByRole("button", { name: "PiAbyss" });
    const vercel = within(themeStyle).getByRole("button", { name: "Vercel" });
    const apple = within(themeStyle).getByRole("button", { name: "Apple" });

    expect(piabyss).toHaveAttribute("aria-pressed", "true");
    expect(piabyss).toHaveAttribute("data-state", "active");
    expect(vercel).toHaveAttribute("aria-pressed", "false");
    expect(vercel).toHaveAttribute("data-state", "inactive");
    expect(apple).toHaveAttribute("aria-pressed", "false");
    expect(apple).toHaveAttribute("data-state", "inactive");

    await user.click(vercel);
    await waitFor(() => expect(useAppStore.getState().desktopSettings?.themeFamily).toBe("vercel"));
    expect(document.documentElement.dataset.themeFamily).toBe("vercel");
    expect(vercel).toHaveAttribute("aria-pressed", "true");
    expect(vercel).toHaveAttribute("data-state", "active");
    expect(piabyss).toHaveAttribute("data-state", "inactive");

    await user.click(apple);
    await waitFor(() => expect(useAppStore.getState().desktopSettings?.themeFamily).toBe("apple"));
    expect(document.documentElement.dataset.themeFamily).toBe("apple");
    expect(apple).toHaveAttribute("aria-pressed", "true");
    expect(apple).toHaveAttribute("data-state", "active");
    expect(vercel).toHaveAttribute("data-state", "inactive");

    await user.click(screen.getByLabelText("Color mode"));
    await user.click(await screen.findByRole("option", { name: "Light" }));
    await waitFor(() => expect(useAppStore.getState().desktopSettings?.theme).toBe("light"));
    expect(useAppStore.getState().desktopSettings?.themeFamily).toBe("apple");
    expect(document.documentElement).toHaveClass("light");
    expect(document.documentElement.dataset.themeFamily).toBe("apple");
  });

  it("switches sections directly when the Providers form is clean", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="providers" />);

    expect(screen.getByText("No Providers configured yet.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "General" }));
    expect(
      screen.getByRole("heading", { name: "Startup behavior and Pi Host configuration" }),
    ).toBeInTheDocument();
  });

  it("offers the Host section with process controls and runtime info", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="general" />);

    expect(screen.getByText("System notifications")).toBeInTheDocument();
    expect(screen.queryByText("Auto-restart Pi Host")).not.toBeInTheDocument();
    expect(screen.queryByText("Capabilities")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Host" }));
    expect(
      screen.getByRole("heading", { name: "Pi Host runtime, capabilities, and app info" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Auto-restart Pi Host")).toBeInTheDocument();
    expect(screen.getByText("Shared Host process")).toBeInTheDocument();
    expect(screen.getByText("Capabilities")).toBeInTheDocument();
    expect(screen.getByText("Host not connected.")).toBeInTheDocument();
  });

  it("offers a persistent Shortcuts section generated from the command registry", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="general" />);

    await user.click(screen.getByRole("button", { name: "Shortcuts" }));

    expect(
      screen.getByRole("heading", {
        name: "Customize commands active while PiAbyss is focused",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("New session")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+N")).toBeInTheDocument();
    expect(screen.getByText("Show keyboard shortcuts")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+/")).toBeInTheDocument();

    const resetAll = screen.getByRole("button", { name: "Restore defaults" });
    expect(resetAll.parentElement).toHaveAttribute("data-settings-header-actions");
    expect(resetAll.closest("header")).toHaveAttribute("data-settings-section-header");
  });

  it("asks before leaving Providers with unsaved changes and keeps the section on cancel", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="providers" />);
    useAppStore.getState().setProvidersDirty(true);

    await user.click(screen.getByRole("button", { name: "General" }));
    expect(
      screen.getByRole("heading", { name: "Discard unsaved Provider changes?" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("No Providers configured yet.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "General" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(
      screen.getByRole("heading", { name: "Startup behavior and Pi Host configuration" }),
    ).toBeInTheDocument();
  });

  it("switches the interface to Chinese from the Appearance language select", async () => {
    const user = userEvent.setup();
    render(<SettingsPage initialSection="appearance" />);

    expect(
      screen.getByRole("heading", {
        name: "Theme, density, language, and conversation typography",
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText(/Language/));
    await user.click(await screen.findByRole("option", { name: "中文" }));

    expect(screen.getByRole("button", { name: "通用" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "外观" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "主机" })).toBeInTheDocument();
    expect(screen.getByText("界面")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "General" })).not.toBeInTheDocument();
  });

  it("synchronizes automatic presentation and offers one-click legacy rollback", async () => {
    const user = userEvent.setup();
    useAppStore.getState().setHost(CONNECTED_HOST);
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      result: { extensionDecisionPresentation: "auto" },
    } as never);
    render(<SettingsPage initialSection="general" />);

    const group = screen.getByRole("group", {
      name: "Extension prompt presentation",
    });
    const legacy = within(group).getByRole("radio", { name: /^Legacy modal/ });
    const automatic = within(group).getByRole("radio", { name: /^Automatic/ });
    expect(legacy).toBeChecked();

    await user.click(automatic);
    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.extensionDecisionPresentation).toBe("auto"),
    );
    const extensionRequests = () =>
      request.mock.calls.filter(([method]) => method === "extensionUi.configure");
    expect(extensionRequests()[0]).toEqual([
      "extensionUi.configure",
      { expectedHostInstanceId: CONNECTED_HOST.hostInstanceId },
      { extensionDecisionPresentation: "auto" },
    ]);
    expect(automatic).toBeChecked();

    await user.click(legacy);
    await waitFor(() =>
      expect(useAppStore.getState().desktopSettings?.extensionDecisionPresentation).toBe(
        "legacy-modal",
      ),
    );
    expect(extensionRequests()[1]).toEqual([
      "extensionUi.configure",
      { expectedHostInstanceId: CONNECTED_HOST.hostInstanceId },
      { extensionDecisionPresentation: "legacy-modal" },
    ]);
    expect(legacy).toBeChecked();
  });

  it("keeps the previous setting and reports a rejected desktop patch", async () => {
    const user = userEvent.setup();
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === "shell_terminal_profiles") {
        return {
          profiles: [],
          automaticProfile: { id: "auto", label: "Automatic", path: "/bin/sh" },
        };
      }
      throw new Error("disk full");
    });
    render(<SettingsPage initialSection="appearance" />);

    await user.click(screen.getByLabelText("Color mode"));
    await user.click(await screen.findByRole("option", { name: "Light" }));

    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith("desktop_settings_patch", {
        patch: { theme: "light" },
      }),
    );
    expect(useAppStore.getState().desktopSettings?.theme).toBe("system");
    expect(
      useAppStore
        .getState()
        .notifications.some((notification) => notification.message.includes("disk full")),
    ).toBe(true);
  });

  it("guards closing while dirty and forwards close once confirmed via the overlay owner", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SettingsPage initialSection="providers" onClose={onClose} />);
    useAppStore.getState().setProvidersDirty(true);

    // Dirty: Escape opens the discard confirmation instead of closing directly.
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("heading", { name: "Discard unsaved Provider changes?" }),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
