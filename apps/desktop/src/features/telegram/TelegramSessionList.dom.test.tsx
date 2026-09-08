/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramSessionSummary } from "@piabyss/protocol";
import {
  TelegramSessionList,
  telegramSessionTime,
  telegramSessionTitle,
} from "./TelegramSessionList";
import { useTelegramViewStore } from "./telegram-view-store";

const sessions: TelegramSessionSummary[] = [
  {
    sessionPath: "C:/agent/sessions/--P--/b.jsonl",
    name: "新会话",
    cwd: "C:/work/b",
    updatedAt: 1787029396000, // 2026-08-18
    telegramMessageCount: 5,
    preview: "读一下需求文档",
  },
  {
    sessionPath: "C:/agent/sessions/--P--/a.jsonl",
    cwd: "C:/work/a",
    updatedAt: 1787024800000,
    telegramMessageCount: 1,
  },
];

describe("telegramSessionTitle", () => {
  it("prefers name, then cwd basename, then file name", () => {
    expect(telegramSessionTitle(sessions[0]!)).toBe("新会话");
    expect(telegramSessionTitle(sessions[1]!)).toBe("a");
    expect(telegramSessionTime(sessions[0]!.updatedAt)).toMatch(/^8\/18 \d{2}:\d{2}$/);
  });
});

describe("TelegramSessionList", () => {
  let refreshTelegramSessions: ReturnType<typeof vi.fn>;
  let openSession: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    refreshTelegramSessions = vi.fn().mockResolvedValue(undefined);
    openSession = vi.fn().mockImplementation(async (path: string) => {
      useTelegramViewStore.setState({ openSessionPath: path });
    });
    useTelegramViewStore.setState({
      sessions,
      loaded: true,
      loading: false,
      error: null,
      refreshTelegramSessions,
      openTelegramSession: openSession,
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders one row per session with title, count and preview", () => {
    render(<TelegramSessionList />);
    expect(screen.getByText("新会话")).toBeInTheDocument();
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("读一下需求文档")).toBeInTheDocument();
  });

  it("opens a session on click and highlights it", async () => {
    const user = userEvent.setup();
    render(<TelegramSessionList />);
    await user.click(screen.getByRole("button", { name: /新会话/ }));
    expect(openSession).toHaveBeenCalledWith("C:/agent/sessions/--P--/b.jsonl");
    expect(screen.getByRole("button", { name: /新会话/ })).toHaveAttribute("aria-current", "true");
  });

  it("shows the empty state when there are no sessions", () => {
    useTelegramViewStore.setState({ sessions: [], loaded: true, refreshTelegramSessions });
    render(<TelegramSessionList />);
    expect(screen.getByText("No telegram sessions yet.")).toBeInTheDocument();
  });

  it("surfaces an error with a retry action", () => {
    useTelegramViewStore.setState({
      sessions: [],
      loaded: false,
      error: "boom",
      refreshTelegramSessions,
    });
    render(<TelegramSessionList />);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });
});
