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

  it("keeps the new-session button visible on the pixie page", () => {
    // 小精灵页不隐藏「新会话」：点击时它会作用于进入小精灵前的工作区
    // （NewSessionButton 分流，见 pixie-previous-workspace.ts）。会话列表
    // 改为渲染冻结快照（上一个会话的选中态保留）——但 zustand v5 在
    // renderToStaticMarkup 下只读模块加载时的初始快照，运行期 capture
    // 不可见，所以快照列表的渲染断言放在 SessionList.frozen.dom.test。
    const html = renderToStaticMarkup(
      createElement(SidebarLayout, { page: "pixie", setPage: vi.fn() }),
    );

    expect(html).toContain("New conversation");
  });

  it("hides plugin-backed entries (memo, pixie) while their plugins are not known-enabled", () => {
    // The plugin gate resolves to false in SSR (no host/catalog yet), so the
    // memo and pixie entries render only once their plugins are enabled.
    const html = renderToStaticMarkup(
      createElement(SidebarLayout, { page: "chat", setPage: vi.fn() }),
    );

    expect(html).not.toContain('data-testid="sidebar-memo-entry"');
    expect(html).not.toContain('data-testid="sidebar-pixie-entry"');
  });

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
