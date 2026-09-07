import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarLayout } from "./Sidebar";
import type { NavPage } from "../lib/stores/app-store";

describe("Sidebar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each<NavPage>(["chat", "packages", "settings"])(
    "keeps the conversation workspace mounted on the %s page",
    (page) => {
      const html = renderToStaticMarkup(createElement(SidebarLayout, { page, setPage: vi.fn() }));

      expect(html).toContain("New conversation");
      expect(html).toContain("Workspaces");
      expect(html).toContain("Recent conversations");
      expect(html).toContain("Settings");
      expect(html).not.toContain(">Chat<");
      expect(html).not.toContain(">Packages<");
    },
  );

  it("renders the aside as a zero-width strip when the sidebar is collapsed", async () => {
    // sidebarCollapsed lives in app-store (zustand v5 serves SSR from the
    // store's initial snapshot captured at module load, so setState can't
    // reach a renderToStaticMarkup render). Stub the persisted pref and
    // re-import the module so the store's create() initializer sees the
    // collapsed pref.
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "piabyss.sidebar.collapsed" ? "1" : null),
      setItem: vi.fn(),
    });
    vi.resetModules();
    const { SidebarLayout: FreshSidebarLayout } = await import("./Sidebar");

    const html = renderToStaticMarkup(
      createElement(FreshSidebarLayout, { page: "chat", setPage: vi.fn() }),
    );

    // The collapse toggle moved into the app-level AppTopBar, so a collapsed
    // sidebar is now simply a zero-width aside with its body hidden — no more
    // fixed top-left toggle slot.
    expect(html).toContain("width:0");
    expect(html).toContain('data-sidebar-collapsed="true"');
    expect(html).not.toContain("New conversation");
    expect(html).not.toContain("Recent conversations");
    expect(html).not.toContain("data-sidebar-collapsed-toggle-slot");
  });

  it("renders the workspace nav when expanded", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "piabyss.sidebar.width.v1" ? "300" : null),
      setItem: vi.fn(),
    });

    const html = renderToStaticMarkup(
      createElement(SidebarLayout, { page: "chat", setPage: vi.fn() }),
    );

    expect(html).toContain("New conversation");
    expect(html).toContain("Recent conversations");
    expect(html).not.toContain('data-sidebar-collapsed="true"');
  });
});
