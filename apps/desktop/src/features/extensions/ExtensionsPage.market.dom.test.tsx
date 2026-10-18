/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  PackageCatalog,
  PackageMutationResult,
  PackageRecord,
  PackageSnapshot,
  PluginLibraryCatalog,
  ResourceRecord,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { resetPluginLibraryUpdatesCache } from "../plugin-library/plugin-updates";
import { ExtensionsPage } from "./ExtensionsPage";

const { shellOpen } = vi.hoisted(() => ({ shellOpen: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shellOpen }));

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri,
}));

function host(overrides: Partial<HostStatusSnapshot> = {}): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: "h1",
    workspaceId: "w1",
    workspaceRevision: 1,
    sessionId: "s1",
    sessionRevision: 1,
    packageRevision: 1,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "C:/agent",
    phase: "ready",
    capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
    ...overrides,
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: "w1",
    revision: 1,
    cwd: "C:/workspace",
    canonicalCwd: "C:/workspace",
    servicesReady: true,
  };
}

function catalog(): PluginLibraryCatalog {
  return {
    specVersion: 1,
    registryUrl: "https://example.test/plugins.json",
    repoSource: "git:github.com/example/my-pi-plugins",
    fetchedAt: Date.now(),
    warnings: [],
    plugins: [
      {
        id: "pi-browser",
        name: "Browser",
        description: "Browser automation.",
        icon: "🌐",
        version: "1.0.0",
        install: { type: "npm", source: "npm:betterwright" },
      },
    ],
  };
}

function packageRecord(overrides: Partial<PackageRecord> = {}): PackageRecord {
  return {
    id: "package:user:tools",
    identity: "npm:tools",
    source: "npm:tools",
    kind: "npm",
    scope: "user",
    filtered: false,
    installed: true,
    installedPath: "C:/agent/npm/tools",
    displayName: "Tools",
    versionOrRef: "1.0.0",
    effective: true,
    resourceCounts: {
      extensions: 1,
      skills: 1,
      prompts: 0,
      themes: 0,
      enabled: 2,
      disabled: 0,
    },
    resourceCountsState: "resolvedEffective",
    ...overrides,
  };
}

function resource(overrides: Partial<ResourceRecord> = {}): ResourceRecord {
  return {
    id: "resource:extension:tools",
    type: "extension",
    name: "index.ts",
    path: "C:/agent/npm/tools/src/index.ts",
    relativePath: "src/index.ts",
    scope: "user",
    origin: "package",
    source: "npm:tools",
    packageId: "package:user:tools",
    enabled: true,
    preferences: { user: "enabled", project: "inherit" },
    control: { kind: "preference", scopes: ["user", "project"] },
    diagnostics: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<PackageSnapshot> = {}): PackageSnapshot {
  const owner = resource();
  return {
    revision: 1,
    workspaceId: "w1",
    scope: "all",
    configured: [packageRecord()],
    resources: [
      owner,
      resource({
        id: "resource:skill:review",
        type: "skill",
        name: "Review skill",
        path: "C:/agent/npm/tools/skills/review/SKILL.md",
        relativePath: "skills/review/SKILL.md",
        manualOnly: true,
      }),
      resource({
        id: "resource:runtime:dynamic",
        type: "skill",
        name: "Dynamic review",
        path: "runtime://review/SKILL.md",
        origin: "extension",
        scope: "temporary",
        packageId: undefined,
        control: { kind: "owner-extension", ownerResourceId: owner.id },
      }),
    ],
    updateCheck: { supported: true },
    diagnostics: [],
    ...overrides,
  };
}

function marketCatalog(): PackageCatalog {
  return {
    generatedAt: Date.now(),
    fromCache: false,
    page: 1,
    pageSize: 12,
    total: 2,
    lastPage: 1,
    items: [
      {
        name: "pi-sql-kit",
        description: "Read-only SQL skills.",
        author: "pi.dev",
        types: ["skill"],
        downloadsPerMonth: 8100,
        searchText: "pi-sql-kit read-only sql skills",
        installSource: "npm:pi-sql-kit",
        pageUrl: "https://pi.dev/packages/pi-sql-kit",
      },
      {
        name: "pi-browser-tools",
        description: "Headless browser control.",
        author: "pi.dev",
        types: ["extension"],
        downloadsPerMonth: 12400,
        searchText: "pi-browser-tools headless browser control",
        installSource: "npm:pi-browser-tools",
        pageUrl: "https://pi.dev/packages/pi-browser-tools",
      },
    ],
  };
}

function envelope<M extends string, R>(method: M, result: R): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: `${method}-test`,
    method,
    hostInstanceId: "h1",
    workspaceId: "w1",
    workspaceRevision: 1,
    sessionId: "s1",
    sessionRevision: 1,
    packageRevision: 1,
    ok: true,
    result,
  } as HostResponseEnvelope;
}

function mutationResult(current: PackageSnapshot): PackageMutationResult {
  return {
    operationId: "op-1",
    status: "committed",
    packageSnapshot: current,
    warnings: [],
    reconcileRequired: false,
  };
}

describe("ExtensionsPage package workflows", () => {
  let request: MockInstance<typeof hostClient.request>;
  let currentSnapshot: PackageSnapshot;
  let currentCatalog: PluginLibraryCatalog;
  let currentMarket: PackageCatalog;
  let updateCheckResult: {
    supported: boolean;
    updates: Array<{ packageId: string; source: string; current?: string; available?: string }>;
  };

  beforeEach(() => {
    currentSnapshot = snapshot();
    currentCatalog = catalog();
    currentMarket = marketCatalog();
    updateCheckResult = { supported: true, updates: [] };
    resetPluginLibraryUpdatesCache();
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applyPackageSnapshot(null);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    useAppStore.getState().setPackageProgress(null);
    useAppStore.getState().setPackageRetry(null);
    useAppStore.getState().setDesktopSettings({
      theme: "system",
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "legacy-modal",
      terminalProfile: "auto",
      knownWorkspaces: ["C:/workspace", "C:/other-project"],
    } as never);
    shellOpen.mockReset();
    tauriMocks.invoke.mockReset();
    tauriMocks.isTauri.mockReturnValue(true);
    request = vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method === "pluginLibrary.catalog") return envelope(method, currentCatalog);
      if (method === "package.list") return envelope(method, currentSnapshot);
      if (method === "package.catalog") return envelope(method, currentMarket);
      if (method === "package.checkUpdates") return envelope(method, updateCheckResult);
      if (
        method === "package.install" ||
        method === "package.remove" ||
        method === "package.update" ||
        method === "package.updateAll" ||
        method === "package.reloadResources" ||
        method === "resource.setPreference" ||
        method === "resource.setPreferences"
      ) {
        return envelope(method, mutationResult(currentSnapshot));
      }
      throw new Error(`Unexpected method ${method}`);
    });
  });

  afterEach(() => {
    request.mockRestore();
    cleanup();
  });

  it("lists installed packages next to registry plugins in one grid", async () => {
    render(<ExtensionsPage />);

    expect(await screen.findByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("Browser")).toBeInTheDocument();
    // The registry plugin is not installed, so it offers the install action.
    const browserCard = screen.getByText("Browser").closest("article")!;
    expect(within(browserCard).getByRole("button", { name: "Install…" })).toBeInTheDocument();
  });

  it("opens the detail drawer and controls a package's resources at the user layer", async () => {
    const user = userEvent.setup();
    render(<ExtensionsPage />);

    await user.click(await screen.findByText("Tools"));
    const drawer = await screen.findByRole("dialog", { name: "Tools" });

    expect(within(drawer).getByText("Package details")).toBeInTheDocument();
    expect(within(drawer).getAllByText("npm:tools").length).toBeGreaterThan(0);
    expect(within(drawer).getByText("C:/agent/npm/tools")).toBeInTheDocument();
    expect(within(drawer).getByText("3 enabled / 0 disabled")).toBeInTheDocument();
    expect(within(drawer).getByText("Dynamic review")).toBeInTheDocument();
    expect(within(drawer).getByText("Managed by extension")).toBeInTheDocument();

    // Global scope: no "inherit" — the user layer is the base every workspace
    // inherits from.
    const controls = within(drawer).getByRole("group", { name: "Tools package" });
    expect(
      within(controls).queryByRole("button", { name: "inherit all resources in Tools package" }),
    ).toBeNull();
    expect(
      within(controls).getByRole("button", { name: "enabled all resources in Tools package" }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(
      within(controls).getByRole("button", { name: "disabled all resources in Tools package" }),
    );
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "resource.setPreferences",
        expect.anything(),
        {
          updates: [
            { resourceId: "resource:extension:tools", targetScope: "user", preference: "disabled" },
            { resourceId: "resource:skill:review", targetScope: "user", preference: "disabled" },
          ],
        },
        615_000,
      );
    });
  });

  it("closes the drawer with Escape or the mask and returns focus to the card", async () => {
    const user = userEvent.setup();
    render(<ExtensionsPage />);

    const card = (await screen.findByText("Tools")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Tools" }));
    expect(await screen.findByRole("dialog", { name: "Tools" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(within(card).getByRole("button", { name: "Tools" }));
    expect(await screen.findByRole("dialog", { name: "Tools" })).toBeInTheDocument();
    await user.click(document.querySelector<HTMLElement>("[data-extensions-drawer-mask]")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("floats the drawer over the grid without joining the page layout", async () => {
    const user = userEvent.setup();
    const { container } = render(<ExtensionsPage />);

    await user.click(await screen.findByText("Tools"));
    const drawer = await screen.findByRole("dialog", { name: "Tools" });
    // Portalled to <body> and fixed-positioned: the panel cannot reflow (or
    // squeeze) the settings flex tree, and it is pinned to the page shell's
    // rect so the app top bar stays uncovered.
    expect(drawer.parentElement).toBe(document.body);
    expect(container.contains(drawer)).toBe(false);
    expect(drawer.className).toContain("fixed");
    expect(drawer).toHaveStyle({ top: "0px", height: "0px" });
    // Slides in on the next frame; the closed state is the off-canvas transform.
    await waitFor(() => expect(drawer).toHaveAttribute("data-state", "open"));
    expect(drawer.className).toContain("translate-x-0");
  });

  it("removes a package through the danger confirmation", async () => {
    const user = userEvent.setup();
    render(<ExtensionsPage />);

    await user.click(await screen.findByText("Tools"));
    const drawer = await screen.findByRole("dialog", { name: "Tools" });
    await user.click(within(drawer).getByRole("button", { name: "Remove" }));

    const dialog = await screen.findByRole("dialog", { name: "Remove package" });
    expect(within(dialog).getByText(/removes the package and its resources/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Remove package" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "package.remove",
        expect.anything(),
        { packageId: "package:user:tools" },
        expect.any(Number),
      ),
    );
  });

  it("lists non-plugin packages in the update popup and updates them", async () => {
    updateCheckResult = {
      supported: true,
      updates: [
        {
          packageId: "package:user:tools",
          source: "npm:tools",
          current: "1.0.0",
          available: "1.2.0",
        },
      ],
    };
    const user = userEvent.setup();
    render(<ExtensionsPage />);

    await screen.findByText("Tools");
    await user.click(await screen.findByRole("button", { name: "Updates available" }));
    const menu = document.querySelector<HTMLElement>("[data-plugin-updates-menu]")!;
    expect(menu).toHaveTextContent("Tools");
    expect(menu).toHaveTextContent("v1.0.0 → v1.2.0");

    await user.click(menu.querySelector<HTMLElement>("[data-plugin-update-one]")!);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "package.update",
        expect.anything(),
        { packageId: "package:user:tools" },
        expect.any(Number),
      ),
    );
  });

  it("installs a package from the market with the executable-code warning", async () => {
    const user = userEvent.setup();
    render(<ExtensionsPage />);

    await user.click(await screen.findByRole("button", { name: "Market" }));
    // The market is a global install entry: no management-scope row.
    expect(screen.queryByRole("button", { name: "Global" })).toBeNull();
    expect(screen.getByRole("button", { name: "pi.dev catalog" })).toBeInTheDocument();

    const card = (await screen.findByText("pi-sql-kit")).closest("article")!;
    const install = within(card).getByRole("button", { name: "Install…" });
    expect(install).toHaveAttribute("title", expect.stringContaining("run local code"));
    await user.click(install);

    const dialog = await screen.findByRole("dialog", { name: "Review package install" });
    expect(within(dialog).getByText(/npm:pi-sql-kit/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Install package" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "package.install",
        expect.anything(),
        { source: "npm:pi-sql-kit", scope: "user" },
        expect.any(Number),
      ),
    );
  });

  it("installs a package from the source field in the library toolbar", async () => {
    currentCatalog = { ...catalog(), plugins: [] };
    const user = userEvent.setup();
    render(<ExtensionsPage />);

    await user.type(await screen.findByLabelText("Package source"), "npm:local-tools");
    await user.click(screen.getByRole("button", { name: "Install…" }));
    const dialog = await screen.findByRole("dialog", { name: "Review package install" });
    await user.click(within(dialog).getByRole("button", { name: "Install package" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "package.install",
        expect.anything(),
        { source: "npm:local-tools", scope: "user" },
        expect.any(Number),
      ),
    );
  });

  it("blocks other mutations until the session resources reload", async () => {
    currentSnapshot = snapshot({ resourceReloadRequired: true });
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<ExtensionsPage />);

    expect(
      await screen.findByText("Session resources changed and must reload before the next prompt."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload resources" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "package.reloadResources",
        expect.anything(),
        null,
        expect.any(Number),
      ),
    );
  });

  it("offers a state reload when the last operation only partially applied", async () => {
    currentSnapshot = snapshot({
      mutation: { operationId: "op-9", status: "partialFailure", reconcileRequired: true },
    });
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<ExtensionsPage />);

    expect(
      await screen.findByText(
        "The previous operation partially changed package state. Reload the authoritative state or retry it.",
      ),
    ).toBeInTheDocument();

    const callsBefore = request.mock.calls.filter(([method]) => method === "package.list").length;
    await user.click(screen.getByRole("button", { name: "Reload state" }));
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "package.list").length,
      ).toBeGreaterThan(callsBefore),
    );
  });

  it("shows package progress and lets the strip be dismissed", async () => {
    useAppStore.getState().setPackageProgress({
      type: "progress",
      operationId: "op-progress",
      source: "npm:tools",
      message: "Installing npm:tools",
      lastEventAt: Date.now(),
    } as never);
    const user = userEvent.setup();
    render(<ExtensionsPage />);

    expect(await screen.findByText("Installing npm:tools")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss package progress" }));
    await waitFor(() => expect(screen.queryByText("Installing npm:tools")).toBeNull());
  });
});
