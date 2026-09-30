/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  ModelSummary,
  ProviderSnapshot,
  RelayPricingResult,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { relayRowToPrice, relayPriceCandidates } from "./model-menu-relay";
import { ModelControls } from "./ModelControls";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

const MODEL: ModelSummary = {
  provider: "one",
  providerName: "一站",
  modelId: "model-a",
  name: "Model A",
  thinkingLevels: [],
};

/** 无价格数据、站点未配置 key 的模型（provider "five"）。 */
const UNPRICED_MODEL: ModelSummary = {
  provider: "five",
  providerName: "五站",
  modelId: "model-z",
  name: "Model Z",
  thinkingLevels: [],
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

function provider(id: string, name: string, configured = true): ProviderSnapshot {
  return {
    id,
    enabled: true,
    name,
    baseUrl: `https://${id}.example.com/v1`,
    api: "openai-completions",
    authHeader: true,
    headers: {},
    models: [],
    auth: { configured, source: configured ? "stored" : undefined },
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

const stationBase = {
  providerId: null,
  baseUrl: "",
  groups: [],
  rows: [],
  keyModels: [],
  balance: null,
  fetchedAt: "now",
};

function pricingResult(): RelayPricingResult {
  return {
    table: {
      schemaVersion: 1,
      stations: [
        {
          ...stationBase,
          // 当前模型 provider 对应的站：同一模型两个分组（default 更便宜）。
          stationId: "one",
          providerId: "one",
          baseUrl: "https://one.example.com/v1",
          rows: [
            {
              stationId: "one",
              modelId: "model-a",
              modelName: "Model A",
              group: "default",
              groupRatio: 1,
              inputPer1M: 1,
              outputPer1M: 2,
              cachePer1M: 0.1,
              callPrice: null,
              endpoints: [],
              keyAvailable: true,
            },
            {
              stationId: "one",
              modelId: "model-a",
              modelName: "Model A",
              group: "sixfold",
              groupRatio: 1.5,
              inputPer1M: 2,
              outputPer1M: 8,
              cachePer1M: null,
              callPrice: null,
              endpoints: [],
              keyAvailable: true,
            },
          ],
        },
        {
          ...stationBase,
          // 别的站也有 model-a，但 provider 不同：不应混入当前 provider 的价格。
          stationId: "five",
          providerId: "five",
          baseUrl: "https://five.example.com/v1",
          rows: [
            {
              stationId: "five",
              modelId: "model-a",
              modelName: "Model A",
              group: "default",
              groupRatio: 1,
              inputPer1M: 0.5,
              outputPer1M: 1,
              cachePer1M: null,
              callPrice: null,
              endpoints: [],
              keyAvailable: true,
            },
          ],
        },
      ],
    },
    rechargeRatios: {
      one: { cny: 1, balance: 1 },
      five: { cny: 1, balance: 5 },
    },
    cached: true,
  };
}

function setupStore(model: ModelSummary = MODEL) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_000 });
  useAppStore.getState().setDesktopSettings({
    theme: "system",
    language: "en",
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "legacy-modal",
    terminalProfile: "auto",
  });
  useAppStore.getState().setHost(host());
  useAppStore.getState().setWorkspace(workspace());
  useAppStore.getState().applySessionSnapshot(session(model));
  useAppStore.getState().setConnecting(false);
}

function teardownStore() {
  vi.restoreAllMocks();
  cleanup();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1_000,
  });
  useAppStore.getState().setDesktopSettings(null);
  useAppStore.getState().setHost(null);
  useAppStore.getState().setWorkspace(null);
  useAppStore.getState().applySessionSnapshot(null);
}

/** 五站未配置 key：其下模型不显示测试按钮（与价格总表测试资格一致）。 */
function mockRequests(currentModel: ModelSummary = MODEL) {
  return vi.spyOn(hostClient, "request").mockImplementation(async (method: string) => {
    if (method === "model.list") {
      return envelope(method, {
        models: [MODEL, UNPRICED_MODEL],
        current: currentModel,
        thinkingLevels: [],
        enabledProviders: ["one", "five"],
      }) as never;
    }
    if (method === "provider.pricing.get") {
      return envelope(method, pricingResult()) as never;
    }
    if (method === "provider.list") {
      return envelope(method, {
        providers: [provider("one", "一站"), provider("five", "五站", false)],
      }) as never;
    }
    if (method === "provider.checkConnection") {
      return envelope(method, {
        providerId: "one",
        api: "openai-completions",
        ok: true,
        latencyMs: 123,
        category: "ok",
        message: "OK",
      }) as never;
    }
    throw new Error(`Unexpected method ${method}`);
  });
}

describe("model-menu-relay pure helpers", () => {
  it("formats prices with the recharge-ratio ≈ conversion", () => {
    const row = pricingResult().table.stations[1].rows[0];
    // 1:5 充值比例（1 CNY = 5 余额单位）：$0.5 ≈ ¥0.10，与设置弹窗同规则。
    const price = relayRowToPrice(row, "五站", { cny: 1, balance: 5 });
    expect(price.input).toBe("$0.5 ≈¥0.10");
    expect(price.cache).toBe("—");
  });

  it("sorts candidates by cheapest input+output and filters by station", () => {
    const pricing = pricingResult();
    const candidates = relayPriceCandidates(pricing, "one", "model-a", new Map([["one", "一站"]]));
    expect(candidates.map((candidate) => candidate.group)).toEqual(["default", "sixfold"]);
    // 别的站（five）也有 model-a，但不属于当前 provider，不混入。
    expect(candidates.every((candidate) => candidate.stationId === "one")).toBe(true);
  });
});

describe("ModelControls relay pricing preview and test", () => {
  beforeEach(() => {
    setupStore();
    mockRequests();
  });

  afterEach(() => {
    teardownStore();
  });

  it("fetches pricing data lazily only after the menu opens", async () => {
    const requestSpy = mockRequests();
    const user = userEvent.setup();
    render(<ModelControls />);

    // 菜单未打开：只拉模型目录，不发 pricing/list 请求。
    await waitFor(() =>
      expect(requestSpy).toHaveBeenCalledWith("model.list", expect.anything(), null),
    );
    expect(requestSpy.mock.calls.some(([method]) => method === "provider.pricing.get")).toBe(false);

    await user.click(screen.getByRole("button", { name: /Model A/ }));
    await screen.findByRole("menu", { name: "Models" });

    await waitFor(() =>
      expect(requestSpy.mock.calls.some(([method]) => method === "provider.pricing.get")).toBe(
        true,
      ),
    );
    expect(requestSpy.mock.calls.some(([method]) => method === "provider.list")).toBe(true);
  });

  it("shows a side price card for the hovered model row", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<ModelControls />);

    await user.click(await screen.findByRole("button", { name: /Model A/ }));
    await screen.findByRole("menu", { name: "Models" });

    // 悬停前无浮窗。
    expect(screen.queryByRole("tooltip", { name: /Model A/ })).toBeNull();

    // 悬停模型行：侧边浮窗显示该模型的分组价格（jsdom 无布局，矩形为 0，
    // 定位坐标不重要，只验证内容与显示/隐藏逻辑）。
    const row = screen.getByRole("menuitemradio", { name: "Model A" }).parentElement!;
    fireEvent.mouseEnter(row);
    const card = await screen.findByRole("tooltip", { name: /Model A/ });
    // 该站两个分组都列出，最便宜的 default 分组在前。
    await within(card).findByText("sixfold");
    expect(within(card).getByText("×1.5")).toBeInTheDocument();
    expect(within(card).getAllByText("$1").length).toBeGreaterThan(0);
    // 别站同模型更便宜的 $0.5 不混入。
    expect(within(card).queryByText("$0.5")).not.toBeInTheDocument();

    // 移出后浮窗消失。
    fireEvent.mouseLeave(row);
    await waitFor(() =>
      expect(screen.queryByRole("tooltip", { name: /Model A/ })).not.toBeInTheDocument(),
    );
  });

  it("shows an empty-pricing hint in the hover card when the model has no pricing rows", async () => {
    useAppStore.getState().applySessionSnapshot(session(UNPRICED_MODEL));
    mockRequests(UNPRICED_MODEL);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<ModelControls />);

    await user.click(await screen.findByRole("button", { name: /Model Z/ }));
    await screen.findByRole("menu", { name: "Models" });

    const row = screen.getByRole("menuitemradio", { name: "Model Z" }).parentElement!;
    fireEvent.mouseEnter(row);
    const card = await screen.findByRole("tooltip", { name: /Model Z/ });
    expect(card).toHaveTextContent(/No pricing data yet/);
  });

  it("runs the model test over provider.checkConnection (station channel, not the session)", async () => {
    const user = userEvent.setup();
    render(<ModelControls />);

    await user.click(await screen.findByRole("button", { name: /Model A/ }));
    await screen.findByRole("menu", { name: "Models" });

    // 未配置 key 的站点（五站）不显示测试按钮。
    const unpricedRow = screen.getByRole("menuitemradio", { name: "Model Z" }).parentElement!;
    await waitFor(() => expect(unpricedRow).toHaveTextContent("Model Z"));
    expect(within(unpricedRow).queryByRole("button", { name: /Test/ })).toBeNull();

    // 已配置 key 的站点（一站）显示测试按钮，点击后走 provider.checkConnection
    // —— 测试通道是站点自己的 key/baseUrl，与 model.setCurrent（会话通道）无关。
    const row = screen.getByRole("menuitemradio", { name: "Model A" }).parentElement!;
    const testButton = await within(row).findByRole("button", { name: "Test Model A" });
    await user.click(testButton);

    await waitFor(() =>
      expect(hostClient.request).toHaveBeenCalledWith(
        "provider.checkConnection",
        expect.anything(),
        { providerId: "one", modelId: "model-a" },
        25_000,
      ),
    );
    expect(hostClient.request).not.toHaveBeenCalledWith(
      "model.setCurrent",
      expect.anything(),
      expect.anything(),
    );

    // 测试结果反映在按钮 title 上（延迟 + 消息）。
    await waitFor(() => expect(testButton).toHaveAttribute("title", "123 ms · OK"));
  });

  it("keeps the test result when the menu reopens in the same session view", async () => {
    const user = userEvent.setup();
    render(<ModelControls />);

    await user.click(await screen.findByRole("button", { name: /Model A/ }));
    await screen.findByRole("menu", { name: "Models" });
    const testButton = await screen.findByRole("button", { name: "Test Model A" });
    await user.click(testButton);
    await waitFor(() =>
      expect(hostClient.request).toHaveBeenCalledWith(
        "provider.checkConnection",
        expect.anything(),
        { providerId: "one", modelId: "model-a" },
        25_000,
      ),
    );

    // 关闭再打开菜单：结果仍保留（组件未卸载）。
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Models" })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /Model A/ }));
    const reopened = await screen.findByRole("button", { name: "Test Model A" });
    expect(reopened).toHaveAttribute("title", "123 ms · OK");
  });
});
