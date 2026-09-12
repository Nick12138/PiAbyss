/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  ModelSummary,
  PackageMutationResult,
  PackageRecord,
  PackageSnapshot,
  PluginLibraryCatalog,
  ResourceRecord,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { PluginLibraryPage } from "./PluginLibraryPage";

const { shellOpen } = vi.hoisted(() => ({ shellOpen: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shellOpen }));

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri,
}));

const REPO_SOURCE = "git:github.com/Nick12138/my-pi-plugins";
const VISION_MODELS: ModelSummary[] = [
  {
    provider: "openai",
    providerName: "OpenAI",
    modelId: "gpt-4o-mini",
    name: "GPT-4o mini",
    input: ["text", "image"],
  },
  {
    provider: "anthropic",
    providerName: "Anthropic",
    modelId: "claude-sonnet-45",
    name: "Claude Sonnet 4.5",
    input: ["text", "image"],
  },
  {
    provider: "openai",
    providerName: "OpenAI",
    modelId: "gpt-text",
    name: "GPT Text",
    input: ["text"],
  },
];

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
    registryUrl: "https://raw.githubusercontent.com/Nick12138/my-pi-plugins/main/plugins.json",
    repoSource: REPO_SOURCE,
    fetchedAt: Date.now(),
    warnings: [],
    plugins: [
      {
        id: "pi-browser",
        name: "浏览器",
        description: "BetterWright browser.",
        icon: "🌐",
        version: "1.10.0",
        install: { type: "npm", source: "npm:betterwright" },
      },
      {
        id: "pi-web",
        name: "联网搜索",
        description: "Tavily + Exa.",
        icon: "🔍",
        version: "0.1.0",
        install: { type: "repo", path: "packages/pi-web" },
        config: [
          {
            key: "tavilyApiKey",
            type: "text",
            label: "Tavily API Key",
            env: "TAVILY_API_KEY",
            secret: true,
          },
        ],
      },
    ],
  };
}

function catalogWithVision(includeUnknownSource = false): PluginLibraryCatalog {
  const visionPlugin: PluginLibraryCatalog["plugins"][number] = {
    id: "pi-vision",
    name: "pi-vision",
    description: "Vision model support.",
    icon: "👁️",
    version: "0.1.0",
    install: { type: "repo", path: "packages/pi-vision" },
    config: [
      {
        key: "visionModel",
        type: "select",
        label: "Default vision model",
        env: "PI_VISION_MODEL",
        default: "",
        optionsSource: "pi:vision-models",
      },
      {
        key: "fallbackModels",
        type: "select",
        label: "Fallback models",
        env: "PI_VISION_FALLBACK_MODELS",
        optionsSource: "pi:vision-models-fallback",
      },
    ],
  };
  const unknownPlugin: PluginLibraryCatalog["plugins"][number] = {
    id: "pi-unknown-options",
    name: "Unknown options source",
    description: "Unknown options source fallback.",
    icon: "?",
    version: "0.1.0",
    install: { type: "repo", path: "packages/pi-unknown-options" },
    config: [
      {
        key: "customValue",
        type: "select",
        label: "Custom value",
        env: "PI_UNKNOWN_VALUE",
        optionsSource: "pi:everything",
      },
    ],
  };
  return {
    ...catalog(),
    plugins: [...catalog().plugins, visionPlugin, ...(includeUnknownSource ? [unknownPlugin] : [])],
  };
}

function catalogWithSubagent(): PluginLibraryCatalog {
  const subagentPlugin: PluginLibraryCatalog["plugins"][number] = {
    id: "pi-subagent",
    name: "pi-subagent",
    description: "Subagent runtime.",
    icon: "🤖",
    version: "0.1.0",
    install: { type: "repo", path: "packages/pi-subagent" },
    config: [
      {
        key: "defaultModel",
        type: "select",
        label: "Default model",
        env: "SUBAGENT_DEFAULT_MODEL",
        default: "",
        optionsSource: "pi:models",
      },
      {
        key: "fallbackModels",
        type: "select",
        label: "Fallback models",
        env: "SUBAGENT_FALLBACK_MODELS",
        optionsSource: "pi:models-fallback",
      },
    ],
  };
  return {
    ...catalog(),
    plugins: [...catalog().plugins, subagentPlugin],
  };
}

function packageRecord(overrides: Partial<PackageRecord> = {}): PackageRecord {
  return {
    id: "pkg-browser",
    identity: "npm:betterwright",
    source: "npm:betterwright",
    kind: "npm",
    scope: "user",
    filtered: false,
    installed: true,
    displayName: "betterwright",
    versionOrRef: "1.10.0",
    effective: true,
    resourceCounts: null,
    resourceCountsState: "resolvedEffective",
    ...overrides,
  };
}

function resource(overrides: Partial<ResourceRecord> = {}): ResourceRecord {
  return {
    id: "res-1",
    type: "extension",
    name: "ext",
    path: "C:/agent/npm/node_modules/betterwright/dist/src/pi-extension.js",
    scope: "user",
    origin: "package",
    source: "betterwright",
    packageId: "pkg-browser",
    enabled: true,
    preferences: {},
    control: { kind: "preference", scopes: ["user"] },
    diagnostics: [],
    ...overrides,
  };
}

function emptySnapshot(): PackageSnapshot {
  return {
    revision: 1,
    workspaceId: "w1",
    scope: "all",
    configured: [],
    resources: [],
    updateCheck: { supported: false },
    diagnostics: [],
  };
}

function snapshotWithBrowser(enabled: boolean): PackageSnapshot {
  return {
    ...emptySnapshot(),
    configured: [packageRecord()],
    resources: [resource({ enabled })],
  };
}

function snapshotWithRepo(webEnabled: boolean): PackageSnapshot {
  const repoPkg = packageRecord({
    id: "pkg-repo",
    identity: "git:github.com/Nick12138/my-pi-plugins",
    source: REPO_SOURCE,
    kind: "git",
    displayName: "my-pi-plugins",
  });
  return {
    ...emptySnapshot(),
    configured: [repoPkg],
    resources: [
      resource({
        id: "res-web",
        packageId: "pkg-repo",
        path: "C:/agent/git/github.com/Nick12138/my-pi-plugins/packages/pi-web/extensions/pi-web.ts",
        enabled: webEnabled,
      }),
      resource({
        id: "res-ocr",
        packageId: "pkg-repo",
        path: "C:/agent/git/github.com/Nick12138/my-pi-plugins/packages/pi-ocr/extensions/pi-ocr.ts",
        enabled: false,
      }),
    ],
  };
}

function snapshotWithVision(): PackageSnapshot {
  const repoPkg = packageRecord({
    id: "pkg-repo",
    identity: REPO_SOURCE,
    source: REPO_SOURCE,
    kind: "git",
    displayName: "my-pi-plugins",
  });
  return {
    ...emptySnapshot(),
    configured: [repoPkg],
    resources: [
      resource({
        id: "res-vision",
        packageId: "pkg-repo",
        path: "C:/agent/git/github.com/Nick12138/my-pi-plugins/packages/pi-vision/extensions/pi-vision.ts",
        enabled: true,
      }),
      resource({
        id: "res-unknown-options",
        packageId: "pkg-repo",
        path: "C:/agent/git/github.com/Nick12138/my-pi-plugins/packages/pi-unknown-options/extensions/index.ts",
        enabled: true,
      }),
    ],
  };
}

function snapshotWithSubagent(): PackageSnapshot {
  const repoPkg = packageRecord({
    id: "pkg-repo",
    identity: REPO_SOURCE,
    source: REPO_SOURCE,
    kind: "git",
    displayName: "my-pi-plugins",
  });
  return {
    ...emptySnapshot(),
    configured: [repoPkg],
    resources: [
      resource({
        id: "res-subagent",
        packageId: "pkg-repo",
        path: "C:/agent/git/github.com/Nick12138/my-pi-plugins/packages/pi-subagent/extensions/pi-subagent.ts",
        enabled: true,
      }),
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

describe("PluginLibraryPage DOM workflows", () => {
  let request: MockInstance<typeof hostClient.request>;
  let currentSnapshot: PackageSnapshot;
  let currentCatalog: PluginLibraryCatalog;
  let visionModels: readonly ModelSummary[] | null;
  let visionModelsShouldFail: boolean;

  beforeEach(() => {
    currentSnapshot = emptySnapshot();
    currentCatalog = catalog();
    visionModels = VISION_MODELS;
    visionModelsShouldFail = false;
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applyPackageSnapshot(null);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    tauriMocks.invoke.mockReset();
    tauriMocks.isTauri.mockReset();
    tauriMocks.isTauri.mockReturnValue(true);
    // Desktop settings start loaded so persistDesktopSettings does not no-op.
    useAppStore.getState().setDesktopSettings({
      theme: "system",
      autoRestartHostOnce: true,
      extensionDecisionPresentation: "legacy-modal",
      terminalProfile: "auto",
    } as never);
    tauriMocks.invoke.mockImplementation(async (command: string, payload: unknown) => {
      if (command === "desktop_settings_patch") {
        const current = (useAppStore.getState().desktopSettings ?? {}) as Record<string, unknown>;
        const next = {
          ...current,
          ...((payload as { patch: Record<string, unknown> }).patch ?? {}),
        };
        useAppStore.getState().setDesktopSettings(next as never);
        return next;
      }
      throw new Error(`Unexpected invoke ${command}`);
    });
    request = vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method === "pluginLibrary.catalog") return envelope(method, currentCatalog);
      if (method === "piSettings.get") {
        if (visionModelsShouldFail) throw new Error("piSettings unavailable");
        return envelope(method, { models: visionModels });
      }
      if (method === "package.list") return envelope(method, currentSnapshot);
      if (
        method === "package.install" ||
        method === "resource.setPreferences" ||
        method === "pluginLibrary.apply"
      ) {
        return envelope(method, mutationResult(currentSnapshot));
      }
      if (method === "pluginLibrary.setEnv") return envelope(method, { applied: 1 });
      throw new Error(`Unexpected method ${method}`);
    });
  });

  afterEach(() => {
    request.mockRestore();
    cleanup();
  });

  it("renders registry cards; the switch carries the enabled state", async () => {
    currentSnapshot = snapshotWithRepo(true);
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    render(<PluginLibraryPage />);

    // Installed + configurable: gear button plus an ON switch in the header.
    const webCard = (await screen.findByText("联网搜索")).closest("article")!;
    expect(within(webCard).getByRole("button", { name: "Configure" })).toBeInTheDocument();
    expect(within(webCard).getByRole("switch")).toHaveAttribute("aria-checked", "true");
    // No separate status badge; the switch is the state.
    expect(webCard.querySelector("[data-plugin-status]")).toBeNull();
    // No form rendered until the dialog opens.
    expect(screen.queryByRole("dialog")).toBeNull();

    // Not-installed npm plugin without a config schema: Install button, no switch, no gear.
    const browserCard = screen.getByText("浏览器").closest("article")!;
    expect(within(browserCard).queryByRole("switch")).toBeNull();
    expect(within(browserCard).queryByRole("button", { name: "Configure" })).toBeNull();
    expect(within(browserCard).getByRole("button", { name: "Install…" })).toBeInTheDocument();

    // Flipping the snapshot: the browser plugin appears with a switch, the web
    // plugin drops back to Install-only.
    currentSnapshot = snapshotWithBrowser(true);
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    await waitFor(() =>
      expect(within(browserCard).getByRole("switch")).toHaveAttribute("aria-checked", "true"),
    );
    expect(within(webCard).queryByRole("button", { name: "Configure" })).not.toBeInTheDocument();
    expect(within(webCard).queryByRole("switch")).toBeNull();
    expect(within(webCard).getByRole("button", { name: "Install…" })).toBeInTheDocument();
  });

  it("flips the switch immediately, applies in the background, and reverts on failure", async () => {
    currentSnapshot = snapshotWithBrowser(true);
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const card = (await screen.findByText("浏览器")).closest("article")!;
    const toggle = within(card).getByRole("switch");

    // Optimistic: flips before the request resolves.
    let resolveRequest: ((value: unknown) => void) | undefined;
    request.mockImplementationOnce(
      () =>
        new Promise<never>((resolve) => {
          resolveRequest = resolve as (value: unknown) => void;
        }),
    );
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");

    // Success: snapshot lands, no toast, switch stays off.
    const toastsBeforeSuccess = useAppStore.getState().notifications.length;
    currentSnapshot = snapshotWithBrowser(false);
    currentSnapshot.revision = 2;
    resolveRequest!(envelope("resource.setPreferences", mutationResult(currentSnapshot)));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "resource.setPreferences",
        expect.objectContaining({ expectedWorkspaceId: "w1" }),
        {
          updates: [{ resourceId: "res-1", targetScope: "user", preference: "disabled" }],
        },
        expect.any(Number),
      ),
    );
    await waitFor(() => expect(useAppStore.getState().packages?.revision).toBe(2));
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(useAppStore.getState().notifications.length).toBe(toastsBeforeSuccess);

    // Failure: error toast and the switch reverts.
    await waitFor(() => expect(within(card).getByRole("switch")).not.toBeDisabled());
    request.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await user.click(within(card).getByRole("switch"));
    // The optimistic flip may already be gone by the time the click resolves —
    // the failed request rejects in the same microtask burst. What matters is
    // the end state: reverted switch + error toast, no success toast.
    await waitFor(() =>
      expect(within(card).getByRole("switch")).toHaveAttribute("aria-checked", "false"),
    );
    await waitFor(() =>
      expect(
        useAppStore
          .getState()
          .notifications.some((notification) => notification.message.includes("boom")),
      ).toBe(true),
    );
  });

  it("opens the shared config dialog from the gear button", async () => {
    currentSnapshot = snapshotWithRepo(true);
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const webCard = (await screen.findByText("联网搜索")).closest("article")!;
    await user.click(within(webCard).getByRole("button", { name: "Configure" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("联网搜索");
    expect(within(dialog).getByLabelText(/Tavily API Key/)).toBeInTheDocument();
    expect(dialog.querySelector('input[type="password"]')).not.toBeNull();

    // Cancel closes without persisting.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("installs an npm plugin via package.install after review", async () => {
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const card = (await screen.findByText("浏览器")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Install…" }));
    await user.click(await screen.findByRole("button", { name: "Install plugin" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "package.install",
        expect.objectContaining({ expectedWorkspaceId: "w1" }),
        { source: "npm:betterwright", scope: "user" },
        expect.any(Number),
      ),
    );
  });

  it("toggles an installed npm plugin via resource.setPreferences", async () => {
    currentSnapshot = snapshotWithBrowser(true);
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const card = (await screen.findByText("浏览器")).closest("article")!;
    await user.click(within(card).getByRole("switch"));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "resource.setPreferences",
        expect.objectContaining({ expectedWorkspaceId: "w1" }),
        {
          updates: [{ resourceId: "res-1", targetScope: "user", preference: "disabled" }],
        },
        expect.any(Number),
      ),
    );
  });

  it("installs repo plugins through pluginLibrary.apply and toggles them via resource preferences", async () => {
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const card = (await screen.findByText("联网搜索")).closest("article")!;
    // Initially nothing in the repo is installed: the card offers Install only.
    expect(within(card).getByRole("button", { name: "Install…" })).toBeInTheDocument();
    expect(within(card).queryByRole("switch")).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Install…" }));
    await user.click(screen.getByRole("button", { name: "Install plugin" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pluginLibrary.apply",
        expect.objectContaining({ expectedWorkspaceId: "w1" }),
        {
          source: REPO_SOURCE,
          pattern: "packages/pi-web/extensions/**",
          enabled: true,
        },
        expect.any(Number),
      ),
    );

    // After the library snapshot includes the plugin, disabling reuses the
    // same resource-preference path as the Package Management page.
    currentSnapshot = snapshotWithRepo(true);
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    await waitFor(() => expect(within(card).getByRole("switch")).toBeInTheDocument());
    await user.click(within(card).getByRole("switch"));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "resource.setPreferences",
        expect.objectContaining({ expectedWorkspaceId: "w1" }),
        {
          updates: [{ resourceId: "res-web", targetScope: "user", preference: "disabled" }],
        },
        expect.any(Number),
      ),
    );

    currentSnapshot = snapshotWithRepo(false);
    currentSnapshot.revision = 3;
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    await waitFor(() =>
      expect(within(card).getByRole("switch")).toHaveAttribute("aria-checked", "false"),
    );
    await user.click(within(card).getByRole("switch"));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "resource.setPreferences",
        expect.objectContaining({ expectedWorkspaceId: "w1" }),
        {
          updates: [{ resourceId: "res-web", targetScope: "user", preference: "enabled" }],
        },
        expect.any(Number),
      ),
    );
  });

  it("persists plugin config via the dialog and applies env vars live", async () => {
    currentSnapshot = snapshotWithRepo(true);
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const card = (await screen.findByText("联网搜索")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Configure" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText(/Tavily API Key/);
    await user.type(input, "tvly-test-key");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith(
        "desktop_settings_patch",
        expect.objectContaining({
          patch: expect.objectContaining({
            pluginEnv: { "pi-web": { TAVILY_API_KEY: "tvly-test-key" } },
          }),
        }),
      ),
    );
    // Live application into the running Host — no restart required.
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pluginLibrary.setEnv",
        expect.objectContaining({ expectedHostInstanceId: "h1" }),
        { vars: { TAVILY_API_KEY: "tvly-test-key" } },
        expect.any(Number),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows only human-readable vision model options and injects the selected model id", async () => {
    currentCatalog = catalogWithVision();
    currentSnapshot = snapshotWithVision();
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const card = (await screen.findAllByText("pi-vision"))[0]!.closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Configure" }));
    const dialog = await screen.findByRole("dialog");
    const trigger = within(dialog).getByRole("button", { name: "Default vision model" });
    await waitFor(() => expect(trigger).not.toBeDisabled());
    await user.click(trigger);

    const listbox = await screen.findByRole("listbox", { name: "Default vision model" });
    expect(listbox).toHaveClass("fixed", "overflow-y-auto");
    expect(listbox.style.maxHeight).toBeTruthy();
    expect(within(listbox).getByRole("option", { name: /Automatic/ })).toBeInTheDocument();
    expect(
      within(listbox).getByRole("option", { name: "OpenAI · GPT-4o mini" }),
    ).toBeInTheDocument();
    expect(
      within(listbox).getByRole("option", { name: "Anthropic · Claude Sonnet 4.5" }),
    ).toBeInTheDocument();
    expect(listbox).not.toHaveTextContent("GPT Text");
    expect(listbox).not.toHaveTextContent("openai/gpt-4o-mini");

    await user.click(within(listbox).getByRole("option", { name: "OpenAI · GPT-4o mini" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith(
        "desktop_settings_patch",
        expect.objectContaining({
          patch: { pluginEnv: { "pi-vision": { PI_VISION_MODEL: "openai/gpt-4o-mini" } } },
        }),
      ),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pluginLibrary.setEnv",
        expect.objectContaining({ expectedHostInstanceId: "h1" }),
        { vars: { PI_VISION_MODEL: "openai/gpt-4o-mini", PI_VISION_FALLBACK_MODELS: null } },
        expect.any(Number),
      ),
    );
  });

  it("uses null for the live env value when automatic vision model selection is chosen", async () => {
    currentCatalog = catalogWithVision();
    currentSnapshot = snapshotWithVision();
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const card = (await screen.findAllByText("pi-vision"))[0]!.closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Configure" }));
    const dialog = await screen.findByRole("dialog");
    const trigger = within(dialog).getByRole("button", { name: "Default vision model" });
    await waitFor(() => expect(trigger).not.toBeDisabled());
    await user.click(trigger);
    const listbox = await screen.findByRole("listbox", { name: "Default vision model" });
    await user.click(within(listbox).getByRole("option", { name: /Automatic/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tauriMocks.invoke).toHaveBeenCalledWith(
        "desktop_settings_patch",
        expect.objectContaining({ patch: { pluginEnv: {} } }),
      ),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pluginLibrary.setEnv",
        expect.objectContaining({ expectedHostInstanceId: "h1" }),
        { vars: { PI_VISION_MODEL: null, PI_VISION_FALLBACK_MODELS: null } },
        expect.any(Number),
      ),
    );
  });

  it("falls back to text input when no vision models are available", async () => {
    currentCatalog = catalogWithVision();
    currentSnapshot = snapshotWithVision();
    visionModels = [];
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const card = (await screen.findAllByText("pi-vision"))[0]!.closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Configure" }));
    const dialog = await screen.findByRole("dialog");
    const input = await within(dialog).findByRole("textbox", { name: /Default vision model/ });
    expect(input).toHaveAttribute("type", "text");
    expect(dialog).toHaveTextContent(
      "No usable vision model detected. You can enter provider/modelId manually",
    );
    await user.type(input, "anthropic/claude-sonnet-45");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pluginLibrary.setEnv",
        expect.objectContaining({ expectedHostInstanceId: "h1" }),
        {
          vars: { PI_VISION_MODEL: "anthropic/claude-sonnet-45", PI_VISION_FALLBACK_MODELS: null },
        },
        expect.any(Number),
      ),
    );
  });

  it("adds and removes ordered fallback vision model rows", async () => {
    currentCatalog = catalogWithVision();
    currentSnapshot = snapshotWithVision();
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const card = (await screen.findAllByText("pi-vision"))[0]!.closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Configure" }));
    const dialog = await screen.findByRole("dialog");
    const add = within(dialog).getByRole("button", { name: "Add fallback model" });
    expect(within(dialog).getAllByRole("button", { name: "Remove fallback model" })).toHaveLength(
      1,
    );
    await user.click(add);
    expect(within(dialog).getAllByRole("button", { name: "Remove fallback model" })).toHaveLength(
      2,
    );
    await user.click(within(dialog).getAllByRole("button", { name: "Remove fallback model" })[0]!);
    expect(within(dialog).getAllByRole("button", { name: "Remove fallback model" })).toHaveLength(
      1,
    );
    await user.click(within(dialog).getByRole("button", { name: "Add fallback model" }));
    expect(within(dialog).getAllByRole("button", { name: "Remove fallback model" })).toHaveLength(
      2,
    );

    const fallbackSelects = within(dialog).getAllByRole("button", { name: /Fallback models/ });
    await user.click(fallbackSelects[0]!);
    const listbox = await screen.findByRole("listbox", { name: "Fallback models 1" });
    await user.click(within(listbox).getByRole("option", { name: "OpenAI · GPT-4o mini" }));
    const secondSelect = within(dialog).getByRole("button", { name: "Fallback models 2" });
    await user.click(secondSelect);
    const secondListbox = await screen.findByRole("listbox", { name: "Fallback models 2" });
    await user.click(
      within(secondListbox).getByRole("option", { name: "Anthropic · Claude Sonnet 4.5" }),
    );

    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pluginLibrary.setEnv",
        expect.objectContaining({ expectedHostInstanceId: "h1" }),
        {
          vars: {
            PI_VISION_MODEL: null,
            PI_VISION_FALLBACK_MODELS: "openai/gpt-4o-mini,anthropic/claude-sonnet-45",
          },
        },
        expect.any(Number),
      ),
    );
  });

  it("falls back to text input for an unknown options source", async () => {
    currentCatalog = catalogWithVision(true);
    currentSnapshot = snapshotWithVision();
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const card = (await screen.findByText("Unknown options source")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Configure" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("textbox", { name: /Custom value/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("listbox", { name: /Custom value/ })).toBeNull();
  });

  it("renders subagent model config from the full model list (text-only included)", async () => {
    currentCatalog = catalogWithSubagent();
    currentSnapshot = snapshotWithSubagent();
    useAppStore.getState().applyPackageSnapshot(currentSnapshot);
    const user = userEvent.setup();
    render(<PluginLibraryPage />);

    const card = (await screen.findAllByText("pi-subagent"))[0]!.closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Configure" }));
    const dialog = await screen.findByRole("dialog");

    // pi:models single-select lists every configured model, text-only too.
    const defaultTrigger = within(dialog).getByRole("button", { name: "Default model" });
    await waitFor(() => expect(defaultTrigger).not.toBeDisabled());
    await user.click(defaultTrigger);
    const defaultListbox = await screen.findByRole("listbox", { name: "Default model" });
    expect(
      within(defaultListbox).getByRole("option", { name: "OpenAI · GPT-4o mini" }),
    ).toBeInTheDocument();
    expect(
      within(defaultListbox).getByRole("option", { name: "OpenAI · GPT Text" }),
    ).toBeInTheDocument();
    // Pick the text-only model to prove the full list is used.
    await user.click(within(defaultListbox).getByRole("option", { name: "OpenAI · GPT Text" }));

    // pi:models-fallback rows use the same full list.
    await user.click(within(dialog).getByRole("button", { name: "Fallback models 1" }));
    const fallbackListbox = await screen.findByRole("listbox", { name: "Fallback models 1" });
    expect(
      within(fallbackListbox).getByRole("option", { name: "OpenAI · GPT Text" }),
    ).toBeInTheDocument();
    expect(
      within(fallbackListbox).getByRole("option", { name: "Anthropic · Claude Sonnet 4.5" }),
    ).toBeInTheDocument();
    await user.click(
      within(fallbackListbox).getByRole("option", { name: "Anthropic · Claude Sonnet 4.5" }),
    );

    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "pluginLibrary.setEnv",
        expect.objectContaining({ expectedHostInstanceId: "h1" }),
        {
          vars: {
            SUBAGENT_DEFAULT_MODEL: "openai/gpt-text",
            SUBAGENT_FALLBACK_MODELS: "anthropic/claude-sonnet-45",
          },
        },
        expect.any(Number),
      ),
    );
  });
});
