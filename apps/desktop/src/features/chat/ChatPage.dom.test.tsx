/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { SessionSnapshot } from "@piabyss/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import {
  DEFAULT_CONVERSATION_MAX_WIDTH,
  DEFAULT_CONVERSATION_MIN_WIDTH,
} from "./conversation-layout";
import { ChatPage } from "./ChatPage";

const BASE_SETTINGS = {
  theme: "system" as const,
  language: "en" as const,
  autoRestartHostOnce: true,
  extensionDecisionPresentation: "auto" as const,
  terminalProfile: "auto" as const,
};

function session(messages: SessionSnapshot["messages"] = []): SessionSnapshot {
  return {
    sessionId: "33333333-3333-4333-8333-333333333333",
    cwd: "/workspace",
    revision: 1,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 1, steering: [], followUp: [] },
    messages,
    tools: {
      revision: 1,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      sessionRevision: 1,
      tools: [],
      active: [],
    },
  };
}

describe("ChatPage conversation width", () => {
  beforeEach(() => {
    useAppStore.getState().setWorkspace({
      id: "22222222-2222-4222-8222-222222222222",
      cwd: "/workspace",
      canonicalCwd: "/workspace",
      revision: 1,
      servicesReady: true,
    });
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().setDesktopSettings(BASE_SETTINGS);
  });

  afterEach(() => {
    cleanup();
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().setDesktopSettings(null);
  });

  it("publishes the configured conversation min and max width bounds", () => {
    useAppStore.getState().setDesktopSettings({
      ...BASE_SETTINGS,
      conversationMinWidth: 640,
      conversationMaxWidth: 1200,
    });
    const { container } = render(<ChatPage />);
    const page = container.querySelector<HTMLElement>("[data-chat-page]")!;
    expect(page.style.getPropertyValue("--conversation-min-width")).toBe("640px");
    expect(page.style.getPropertyValue("--conversation-max-width")).toBe("1200px");
    expect(page.querySelector("[data-chat-header-fade]")).toHaveAttribute("aria-hidden", "true");
  });

  it("falls back to default bounds when none are configured", () => {
    const { container } = render(<ChatPage />);
    const page = container.querySelector<HTMLElement>("[data-chat-page]")!;
    expect(page.style.getPropertyValue("--conversation-min-width")).toBe(
      `${DEFAULT_CONVERSATION_MIN_WIDTH}px`,
    );
    expect(page.style.getPropertyValue("--conversation-max-width")).toBe(
      `${DEFAULT_CONVERSATION_MAX_WIDTH}px`,
    );
  });

  it("hides the default session heading while a new conversation is empty", () => {
    useAppStore.getState().applySessionSnapshot(session());

    const { container } = render(<ChatPage />);

    expect(screen.queryByRole("heading", { name: "New conversation" })).toBeNull();
    expect(container.querySelector("[data-chat-status]")).toBeNull();
    // The chat header / dock toggle moved into the app-level AppTopBar, so the
    // ChatPage itself no longer hosts them.
    expect(container.querySelector("[data-chat-header]")).toBeNull();
    expect(container.querySelector("[data-dock-toolbar-toggle]")).toBeNull();
  });

  it("shows the default session heading once the conversation has data", () => {
    useAppStore
      .getState()
      .applySessionSnapshot(session([{ role: "user", content: "Hello", timestamp: 1 }]));

    render(<ChatPage />);

    // Session name/status moved to the app-level AppTopBar; ChatPage now only
    // hosts the transcript. The status pill is not rendered inside ChatPage.
    expect(screen.queryByRole("heading", { name: "New conversation" })).toBeNull();
  });

  it("shows the transcript (not the welcome screen) for a session pinned via tree navigation", () => {
    useAppStore.getState().applySessionSnapshot(session());
    useAppStore.getState().setSessionTreeNavigated(true);

    const { container } = render(<ChatPage />);

    expect(screen.queryByText("Start in", { exact: false })).toBeNull();
    expect(container.querySelector("[data-transcript-content]")).not.toBeNull();
  });

  it("renders the stats row directly after the composer footer", () => {
    // The composer trims its bottom padding through the CSS rule
    // `[data-composer-footer="docked"]:has(+ [data-composer-stats])`, so the
    // pills row has to be the footer's very next element sibling.
    useAppStore.getState().applySessionSnapshot(
      session([
        { role: "user", content: "Hello", timestamp: 1 },
        {
          role: "assistant",
          content: "Hi there",
          usage: {
            input: 100,
            output: 40,
            cacheRead: 700,
            cacheWrite: 0,
            totalTokens: 840,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      ]),
    );

    const { container } = render(<ChatPage />);

    const footer = container.querySelector<HTMLElement>('[data-composer-footer="docked"]');
    expect(footer).not.toBeNull();
    expect(footer!.nextElementSibling).toBe(container.querySelector("[data-composer-stats]"));
  });

  it("leaves the composer as the last child when no stats row renders", () => {
    useAppStore
      .getState()
      .applySessionSnapshot(session([{ role: "user", content: "Hello", timestamp: 1 }]));

    const { container } = render(<ChatPage />);

    const footer = container.querySelector<HTMLElement>('[data-composer-footer="docked"]');
    expect(footer).not.toBeNull();
    expect(container.querySelector("[data-composer-stats]")).toBeNull();
    expect(footer!.nextElementSibling).toBeNull();
  });
});
