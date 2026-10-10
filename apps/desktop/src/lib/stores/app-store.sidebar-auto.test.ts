/**
 * app-store sidebar auto-collapse bookkeeping: only an automatic collapse may
 * be automatically expanded; every manual action clears the auto flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "./app-store";

const COLLAPSED_KEY = "piabyss.sidebar.collapsed";
const AUTO_KEY = "piabyss.sidebar.autoCollapsed";

describe("app-store sidebar auto-collapse bookkeeping", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    // The node test env has no localStorage; stub it so the persisted prefs
    // round-trip through the actions under test.
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function arrange(collapsed: boolean, auto: boolean) {
    useAppStore.setState({ sidebarCollapsed: collapsed, sidebarAutoCollapsed: auto });
  }

  it("autoCollapseSidebar collapses an expanded sidebar and marks it automatic", () => {
    arrange(false, false);

    useAppStore.getState().autoCollapseSidebar();

    const state = useAppStore.getState();
    expect(state.sidebarCollapsed).toBe(true);
    expect(state.sidebarAutoCollapsed).toBe(true);
    // Default (no options) flags the commit as instant — used by every
    // non-drag trigger path (window open, tray re-show, snap, mount).
    expect(state.sidebarAutoInstant).toBe(true);
    expect(storage.get(COLLAPSED_KEY)).toBe("1");
    expect(storage.get(AUTO_KEY)).toBe("1");
  });

  it("autoCollapseSidebar clears a stale animation-skip marker", () => {
    // After an instant auto action the marker sits stale in the store; the
    // next auto-collapse with animated: true must reset it so the squeeze
    // keeps its animation.
    arrange(false, false);
    useAppStore.setState({ sidebarAutoInstant: true });

    useAppStore.getState().autoCollapseSidebar({ animated: true });

    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    expect(useAppStore.getState().sidebarAutoInstant).toBe(false);
  });

  it("autoCollapseSidebar({ animated: true }) keeps the squeeze width animation (mid-drag path)", () => {
    arrange(false, false);

    useAppStore.getState().autoCollapseSidebar({ animated: true });

    const state = useAppStore.getState();
    expect(state.sidebarCollapsed).toBe(true);
    expect(state.sidebarAutoCollapsed).toBe(true);
    // No animation-skip marker: the Sidebar watcher only passes animated:
    // true for collapses decided during a live window-edge drag.
    expect(state.sidebarAutoInstant).toBe(false);
    expect(storage.get(COLLAPSED_KEY)).toBe("1");
    expect(storage.get(AUTO_KEY)).toBe("1");
  });

  it("autoCollapseSidebar never re-labels a manual collapse as automatic", () => {
    arrange(true, false);
    storage.set(COLLAPSED_KEY, "1");
    storage.set(AUTO_KEY, "0");

    useAppStore.getState().autoCollapseSidebar();

    const state = useAppStore.getState();
    expect(state.sidebarCollapsed).toBe(true);
    expect(state.sidebarAutoCollapsed).toBe(false);
    expect(storage.get(AUTO_KEY)).toBe("0");
  });

  it("autoExpandSidebar reopens an auto-collapsed sidebar and clears the flag", () => {
    arrange(true, true);

    useAppStore.getState().autoExpandSidebar();

    const state = useAppStore.getState();
    expect(state.sidebarCollapsed).toBe(false);
    expect(state.sidebarAutoCollapsed).toBe(false);
    // Default (no options) flags the expand commit so the sidebar skips
    // the width animation — used by every non-drag trigger path (window
    // open, tray re-show, mount).
    expect(state.sidebarAutoInstant).toBe(true);
    expect(storage.get(COLLAPSED_KEY)).toBe("0");
    expect(storage.get(AUTO_KEY)).toBe("0");
  });

  it("autoExpandSidebar({ animated: true }) keeps the width animation (mid-drag path)", () => {
    arrange(true, true);

    useAppStore.getState().autoExpandSidebar({ animated: true });

    const state = useAppStore.getState();
    expect(state.sidebarCollapsed).toBe(false);
    expect(state.sidebarAutoCollapsed).toBe(false);
    // No animation-skip marker: the Sidebar watcher only passes animated:
    // true for expands decided during a live window-edge drag.
    expect(state.sidebarAutoInstant).toBe(false);
    expect(storage.get(COLLAPSED_KEY)).toBe("0");
    expect(storage.get(AUTO_KEY)).toBe("0");
  });

  it("autoExpandSidebar leaves a manually collapsed sidebar alone", () => {
    arrange(true, false);

    useAppStore.getState().autoExpandSidebar();

    const state = useAppStore.getState();
    expect(state.sidebarCollapsed).toBe(true);
    expect(state.sidebarAutoCollapsed).toBe(false);
    expect(storage.get(COLLAPSED_KEY)).toBeUndefined();
  });

  it("toggleSidebar clears the auto flag in both directions", () => {
    // Manual expand of an auto-collapsed sidebar: the user took over.
    arrange(true, true);
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    expect(useAppStore.getState().sidebarAutoCollapsed).toBe(false);
    // Manual actions keep the width animation: the animation-skip marker
    // is cleared with the auto flag.
    expect(useAppStore.getState().sidebarAutoInstant).toBe(false);
    expect(storage.get(AUTO_KEY)).toBe("0");

    // Manual collapse: also a user decision, never auto-expandable.
    arrange(false, true);
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    expect(useAppStore.getState().sidebarAutoCollapsed).toBe(false);
    expect(useAppStore.getState().sidebarAutoInstant).toBe(false);
    expect(storage.get(AUTO_KEY)).toBe("0");
  });

  it("setSidebarCollapsed clears the auto flag (session-reveal expand path)", () => {
    arrange(true, true);

    useAppStore.getState().setSidebarCollapsed(false);

    const state = useAppStore.getState();
    expect(state.sidebarCollapsed).toBe(false);
    expect(state.sidebarAutoCollapsed).toBe(false);
    expect(storage.get(AUTO_KEY)).toBe("0");
  });
});
