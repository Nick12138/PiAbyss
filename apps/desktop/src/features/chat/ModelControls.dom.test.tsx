/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  ModelSummary,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { ModelControls } from "./ModelControls";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const MODEL: ModelSummary = {
  provider: "muapi",
  modelId: "grok-4.5",
  name: "Grok 4.5",
  thinkingLevels: ["off", "high"],
};
const LONG_NAME_MODEL: ModelSummary = {
  provider: "muapi",
  modelId: "grok-4.5-long-preview",
  name: "Grok 4.5 Long Running Preview",
  thinkingLevels: ["off", "high"],
};

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: 1,
    servicesReady: true,
  };
}

function session(model: ModelSummary = MODEL): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: "/workspace",
    revision: 3,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    model,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 1, steering: [], followUp: [] },
    contextUsage: { tokens: 0, contextWindow: 100_000 },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 3,
      tools: [],
      active: [],
    },
  };
}

function envelope(method: string, result: unknown): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: "test-request",
    method,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    ok: true,
    result,
  } as HostResponseEnvelope;
}

describe("ModelControls thinking-depth footer", () => {
  beforeEach(() => {
    setupModelMenuStore();
    // The thinking-depth entry stays available while a run is active.
    useAppStore.getState().applySessionSnapshot({ ...session(), isIdle: false });
  });

  afterEach(() => {
    teardownModelMenuStore();
  });

  it("opens the nested level submenu from the pinned footer and applies a level", async () => {
    const requestSpy = vi
      .spyOn(hostClient, "request")
      .mockImplementation(async (method: string) => {
        if (method === "model.list") {
          return envelope(method, {
            models: [MODEL],
            current: MODEL,
            thinkingLevels: ["off", "high"],
            enabledProviders: ["muapi"],
          }) as never;
        }
        if (method === "model.setThinkingLevel") {
          return envelope(method, { ...session(), thinkingLevel: "high", revision: 4 }) as never;
        }
        throw new Error(`Unexpected method ${method}`);
      });
    // The model catalog is only fetched once the Host connection settles.
    useAppStore.getState().setConnecting(false);

    const user = userEvent.setup();
    render(<ModelControls />);

    await user.click(await screen.findByRole("button", { name: "Grok 4.5" }));
    await screen.findByRole("menu", { name: "Models" });

    // The pinned footer shows the current level and opens the submenu.
    const footer = screen.getByRole("button", { name: /Thinking depth/ });
    expect(footer).toHaveTextContent("Off");
    expect(footer).not.toBeDisabled();
    await user.click(footer);

    const submenu = await screen.findByRole("menu", {
      name: "Thinking level for muapi/Grok 4.5",
    });
    expect(within(submenu).getByRole("menuitemradio", { name: "Off" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await user.click(within(submenu).getByRole("menuitemradio", { name: "High" }));
    await waitFor(() =>
      expect(requestSpy).toHaveBeenCalledWith("model.setThinkingLevel", expect.anything(), {
        level: "high",
      }),
    );

    // The submenu closes while the model menu stays open, and the pinned
    // footer reflects the newly applied level.
    await waitFor(() =>
      expect(
        screen.queryByRole("menu", { name: "Thinking level for muapi/Grok 4.5" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("menu", { name: "Models" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Thinking depth/ })).toHaveTextContent("High");
  });

  it("disables the pinned footer when the model has no thinking levels", async () => {
    vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method !== "model.list") throw new Error(`Unexpected method ${method}`);
      return envelope(method, {
        models: [{ ...MODEL, thinkingLevels: [] }],
        current: { ...MODEL, thinkingLevels: [] },
        thinkingLevels: [],
        enabledProviders: ["muapi"],
      }) as never;
    });
    // The session model itself carries no levels and the catalog agrees —
    // only then is the pinned footer disabled.
    useAppStore.getState().applySessionSnapshot({ ...session({ ...MODEL, thinkingLevels: [] }) });
    useAppStore.getState().setConnecting(false);

    const user = userEvent.setup();
    render(<ModelControls />);

    await user.click(await screen.findByRole("button", { name: "Grok 4.5" }));
    await screen.findByRole("menu", { name: "Models" });

    const footer = screen.getByRole("button", { name: /Thinking depth/ });
    expect(footer).toBeDisabled();
    expect(footer).toHaveTextContent("—");
    useAppStore.getState().setConnecting(true);
  });

  // F5 regression: the rehydrated session model carries no providerName, so
  // ModelControls syncs it with model.list's `current`. That summary used to
  // omit thinkingLevels, which wiped the levels and greyed out the footer.
  it("keeps the session's thinking levels when model.list reports a level-less current", async () => {
    vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method !== "model.list") throw new Error(`Unexpected method ${method}`);
      return envelope(method, {
        models: [MODEL],
        // Legacy host shape: providerName but no thinkingLevels.
        current: {
          provider: MODEL.provider,
          providerName: "Muapi",
          modelId: MODEL.modelId,
          name: MODEL.name,
        },
        thinkingLevels: ["off", "high"],
        enabledProviders: ["muapi"],
      }) as never;
    });
    useAppStore.getState().setConnecting(false);

    const user = userEvent.setup();
    render(<ModelControls />);

    await user.click(await screen.findByRole("button", { name: "Grok 4.5" }));
    await screen.findByRole("menu", { name: "Models" });

    const footer = screen.getByRole("button", { name: /Thinking depth/ });
    expect(footer).not.toBeDisabled();
    expect(footer).toHaveTextContent("Off");
    useAppStore.getState().setConnecting(true);
  });

  it("resolves the pinned footer's levels from the catalog when the session model has none", async () => {
    vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method !== "model.list") throw new Error(`Unexpected method ${method}`);
      return envelope(method, {
        models: [MODEL],
        current: {
          provider: MODEL.provider,
          providerName: "Muapi",
          modelId: MODEL.modelId,
          name: MODEL.name,
        },
        thinkingLevels: ["off", "high"],
        enabledProviders: ["muapi"],
      }) as never;
    });
    // Session model without levels and without providerName: the catalog
    // entry for the same model must backfill the footer's levels.
    useAppStore.getState().applySessionSnapshot({ ...session({ ...MODEL, thinkingLevels: [] }) });
    useAppStore.getState().setConnecting(false);

    const user = userEvent.setup();
    render(<ModelControls />);

    await user.click(await screen.findByRole("button", { name: "Grok 4.5" }));
    await screen.findByRole("menu", { name: "Models" });

    const footer = screen.getByRole("button", { name: /Thinking depth/ });
    expect(footer).not.toBeDisabled();
    expect(footer).toHaveTextContent("Off");
    useAppStore.getState().setConnecting(true);
  });
});

const initialInnerWidth = window.innerWidth;

function setupModelMenuStore() {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_000 });
  useAppStore.getState().setDesktopSettings({
    theme: "system",
    language: "en",
    restoreLastSession: true,
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "legacy-modal",
    terminalProfile: "auto",
  });
  useAppStore.getState().setHost(host());
  useAppStore.getState().setWorkspace(workspace());
  useAppStore.getState().applySessionSnapshot(session());
}

function teardownModelMenuStore() {
  vi.restoreAllMocks();
  cleanup();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: initialInnerWidth,
  });
  useAppStore.getState().setDesktopSettings(null);
  useAppStore.getState().setHost(null);
  useAppStore.getState().setWorkspace(null);
  useAppStore.getState().applySessionSnapshot(null);
}

function domRect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("ModelControls model menu width", () => {
  beforeEach(() => {
    setupModelMenuStore();
  });

  afterEach(() => {
    teardownModelMenuStore();
  });

  it("opens the model menu with no manual drag handle", async () => {
    vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method !== "model.list") throw new Error(`Unexpected method ${method}`);
      return envelope(method, {
        models: [MODEL],
        current: MODEL,
        thinkingLevels: ["off", "high"],
        enabledProviders: ["muapi"],
      }) as never;
    });
    const user = userEvent.setup();
    render(<ModelControls />);

    await user.click(screen.getByRole("button", { name: "Grok 4.5" }));
    await screen.findByRole("menu", { name: "Models" });

    // The floated width tracks the model names automatically — no drag handle.
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("shows only the model name on the button and keeps the Provider in the tooltip", async () => {
    const snapshotModel = { ...MODEL, providerName: undefined };
    const catalogModel = { ...MODEL, providerName: "天机阁" };
    vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method !== "model.list") throw new Error(`Unexpected method ${method}`);
      return envelope(method, {
        models: [catalogModel],
        current: catalogModel,
        thinkingLevels: ["off", "high"],
        enabledProviders: ["muapi"],
      }) as never;
    });
    // The model catalog is only fetched once the Host connection settles.
    useAppStore.getState().setConnecting(false);
    useAppStore.getState().applySessionSnapshot(session(snapshotModel));

    render(<ModelControls />);

    const button = await screen.findByRole("button", { name: "Grok 4.5" });
    expect(button).toHaveAttribute("title", "天机阁/Grok 4.5");
    useAppStore.getState().setConnecting(true);
  });

  it("groups model options under provider section headers", async () => {
    const secondModel: ModelSummary = {
      provider: "grotto",
      providerName: "天机阁",
      modelId: "glm-5.2",
      name: "GLM 5.2",
      thinkingLevels: [],
    };
    vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method !== "model.list") throw new Error(`Unexpected method ${method}`);
      return envelope(method, {
        models: [{ ...MODEL, providerName: "云端学习" }, secondModel],
        current: MODEL,
        thinkingLevels: ["off", "high"],
        enabledProviders: ["muapi", "grotto"],
      }) as never;
    });
    // The model catalog is only fetched once the Host connection settles.
    useAppStore.getState().setConnecting(false);
    const user = userEvent.setup();
    render(<ModelControls />);

    await user.click(screen.getByRole("button", { name: "Grok 4.5" }));
    const menu = await screen.findByRole("menu", { name: "Models" });

    // Provider names appear as section headers; rows show plain model names.
    await within(menu).findByText("云端学习");
    expect(within(menu).getByText("天机阁")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Grok 4.5" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "GLM 5.2" })).toBeInTheDocument();
    expect(screen.queryByText(/muapi\/Grok/)).not.toBeInTheDocument();
    useAppStore.getState().setConnecting(true);
  });

  it("floats the width to fit the widest model name in the list", async () => {
    // jsdom reports scrollWidth = 0 for the hidden measure span, so synthesise
    // measured widths so the auto-width effect has something to clamp. The
    // width is recomputed during the render triggered by model.list.
    const measuredWidth = 400;
    vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method !== "model.list") throw new Error(`Unexpected method ${method}`);
      return envelope(method, {
        models: [MODEL, LONG_NAME_MODEL],
        current: MODEL,
        thinkingLevels: ["off", "high"],
        enabledProviders: ["muapi"],
      }) as never;
    });
    const scrollWidthSpy = vi
      .spyOn(Element.prototype, "scrollWidth", "get")
      .mockImplementation(function (this: Element) {
        // Only the hidden measure span carries the menu labels; let other
        // elements fall through to jsdom's default (steers clear of the panel's
        // own scrollWidth) so layout maths still work.
        return measuredWidth;
      });

    const user = userEvent.setup();
    render(<ModelControls />);

    await user.click(screen.getByRole("button", { name: "Grok 4.5" }));
    const menu = await screen.findByRole("menu", { name: "Models" });
    const menuShell = menu.parentElement?.parentElement;

    // measured content (400) + row controls (96) fits within the default max,
    // so the floated shell matches the measured content width.
    await waitFor(() => expect(menuShell).toHaveStyle({ width: "496px" }));

    scrollWidthSpy.mockRestore();
  });

  it("keeps the minimum width when model names are short", async () => {
    const measuredWidth = 10;
    vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method !== "model.list") throw new Error(`Unexpected method ${method}`);
      return envelope(method, {
        models: [MODEL],
        current: MODEL,
        thinkingLevels: ["off", "high"],
        enabledProviders: ["muapi"],
      }) as never;
    });
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(function (this: Element) {
      return measuredWidth;
    });

    const user = userEvent.setup();
    render(<ModelControls />);

    await user.click(screen.getByRole("button", { name: "Grok 4.5" }));
    const menu = await screen.findByRole("menu", { name: "Models" });
    const menuShell = menu.parentElement?.parentElement;

    // Short names never drop below the minimum width.
    await waitFor(() => expect(menuShell).toHaveStyle({ width: "120px" }));
  });
});

describe("ModelControls selected-model centering", () => {
  beforeEach(() => {
    setupModelMenuStore();
  });

  afterEach(() => {
    teardownModelMenuStore();
  });

  it("centers the selected model in the menu viewport when it opens", async () => {
    const models: ModelSummary[] = Array.from({ length: 30 }, (_, index) => ({
      provider: "muapi",
      modelId: `model-${index}`,
      name: `Model ${index}`,
      thinkingLevels: [],
    }));
    const current = models[24];
    vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
      if (method !== "model.list") throw new Error(`Unexpected method ${method}`);
      return envelope(method, {
        models,
        current,
        thinkingLevels: [],
        enabledProviders: ["muapi"],
      }) as never;
    });
    // The model catalog is only fetched once the Host connection settles.
    useAppStore.getState().setConnecting(false);

    // jsdom has no layout, so pin the menu viewport to 320px tall and place
    // the selected row 960px below the panel's top edge.
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(320);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      if (this.getAttribute("role") === "menu") return domRect(100, 320);
      if (this.getAttribute("aria-checked") === "true") return domRect(1060, 32);
      return domRect(0, 0);
    });

    render(<ModelControls />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Model 24" }));
    const menu = await screen.findByRole("menu", { name: "Models" });

    // (1060 - 100) - 320 / 2 + 32 / 2 = 816 → the selection lands mid-viewport.
    await waitFor(() => expect(menu.scrollTop).toBe(816));
  });
});
