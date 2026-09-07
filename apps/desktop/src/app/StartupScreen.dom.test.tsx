/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../lib/stores/app-store";
import { StartupScreen, resolveStartupStage, useInitialStartupScreen } from "./StartupScreen";

beforeEach(() => {
  useAppStore.getState().setDesktopSettings({
    theme: "dark",
    restoreLastSession: true,
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "auto",
    terminalProfile: "auto",
    language: "zh",
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("startup stage", () => {
  it("tracks settings, Host, workspace, session, and recovery readiness", () => {
    const base = {
      settingsReady: true,
      hostReady: true,
      workspaceReady: true,
      sessionReady: true,
      connecting: true,
      rehydrating: false,
      desynchronized: false,
    };
    expect(resolveStartupStage({ ...base, settingsReady: false })).toBe("preparing");
    expect(resolveStartupStage({ ...base, hostReady: false })).toBe("starting-host");
    expect(resolveStartupStage({ ...base, workspaceReady: false })).toBe("restoring-workspace");
    expect(resolveStartupStage({ ...base, rehydrating: true })).toBe("restoring-session");
    expect(resolveStartupStage({ ...base, desynchronized: true })).toBe("reconnecting");
    expect(resolveStartupStage({ ...base, connecting: false })).toBe("ready");
  });

  it("announces localized progress and exposes the exit state", () => {
    render(<StartupScreen stage="starting-host" exiting />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("正在启动 Pi Host");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-busy", "false");
    expect(status).toHaveAttribute("data-startup-exiting", "true");
  });
});

describe("initial startup latch", () => {
  it("completes once and does not return during a later reconnect", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00Z"));
    const { result, rerender } = renderHook(
      ({ settled }) => useInitialStartupScreen(settled, { minimumMs: 100, exitMs: 50 }),
      { initialProps: { settled: false } },
    );
    expect(result.current).toBe("active");

    act(() => vi.advanceTimersByTime(25));
    rerender({ settled: true });
    act(() => vi.advanceTimersByTime(74));
    expect(result.current).toBe("active");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("exiting");
    act(() => vi.advanceTimersByTime(50));
    expect(result.current).toBe("complete");

    rerender({ settled: false });
    rerender({ settled: true });
    act(() => vi.runAllTimers());
    expect(result.current).toBe("complete");
  });
});

describe("pre-React startup contract", () => {
  it("keeps a transparent first paint and tiny bootstrap theme hook", () => {
    const html = readFileSync(join(process.cwd(), "index.html"), "utf8");
    const css = readFileSync(join(process.cwd(), "src/styles/index.css"), "utf8");
    expect(html).toContain("/src/bootstrap-theme.ts");
    expect(html).toContain("background: transparent");
    expect(html).not.toContain("piabyss-bootstrap");
    expect(css).toContain("html.light .startup-screen");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
