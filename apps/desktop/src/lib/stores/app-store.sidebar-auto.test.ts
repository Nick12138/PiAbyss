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
    expect(storage.get(AUTO_KEY)).toBe("0");

    // Manual collapse: also a user decision, never auto-expandable.
    arrange(false, true);
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    expect(useAppStore.getState().sidebarAutoCollapsed).toBe(false);
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
