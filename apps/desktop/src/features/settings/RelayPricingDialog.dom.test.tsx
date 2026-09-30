/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HostStatusSnapshot,
  ProviderSnapshot,
  RelayPricingResult,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { RelayPricingDialog } from "./RelayPricingDialog";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: null,
    sessionRevision: 0,
    packageRevision: 1,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: { packageUpdateCheck: false, extensionUi: true, sessionExport: true },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function provider(id: string, name: string): ProviderSnapshot {
  return {
    id,
    enabled: true,
    name,
    baseUrl: `https://${id}.example.com/v1`,
    api: "openai-completions",
    authHeader: true,
    headers: {},
    models: [],
    auth: { configured: true, source: "stored" },
  };
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
          // 1:1 站：余额不显示 ≈。
          stationId: "one",
          providerId: "one",
          baseUrl: "https://one.example.com/v1",
          balance: {
            stationId: "one",
            hardLimitUsd: 10,
            totalUsageUsd: 0,
            remainingUsd: 5,
            unlimited: false,
            fetchedAt: "now",
            ok: true,
          },
          rows: [
            {
              stationId: "one",
              modelId: "model-a",
              modelName: "model-a",
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
              modelId: "model-b",
              modelName: "model-b",
              group: "default",
              groupRatio: 1,
              inputPer1M: 3,
              outputPer1M: 6,
              cachePer1M: null,
              callPrice: 0.5,
              endpoints: [],
              keyAvailable: true,
            },
          ],
        },
        {
          ...stationBase,
          // 1:5 站（1 CNY = 5 余额单位）：价格与余额都显示 ≈¥。
          stationId: "five",
          providerId: "five",
          baseUrl: "https://five.example.com/v1",
          balance: {
            stationId: "five",
            hardLimitUsd: 50,
            totalUsageUsd: 0,
            remainingUsd: 10,
            unlimited: false,
            fetchedAt: "now",
            ok: true,
          },
          rows: [
            {
              stationId: "five",
              modelId: "model-a",
              modelName: "model-a",
              group: "default",
              groupRatio: 1,
              inputPer1M: 1,
              outputPer1M: 2,
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

describe("RelayPricingDialog", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderDialog(): void {
    useAppStore.setState({ host: host() });
    vi.spyOn(hostClient, "request").mockResolvedValue({
      protocolVersion: 1 as const,
      id: "test-req",
      method: "provider.pricing.get" as const,
      ok: true as const,
      result: pricingResult(),
      hostInstanceId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRevision: 1,
      sessionId: null,
      sessionRevision: 0,
      packageRevision: 1,
    });
    render(<RelayPricingDialog providers={[provider("one", "一站"), provider("five", "五站")]} onClose={() => {}} />);
  }

  it("hides the ≈ CNY conversion for 1:1 stations and shows it for 1:x", async () => {
    renderDialog();
    // 1:1 站余额：只有 $5.00，无 ≈。
    await screen.findByText("$5.00");
    expect(screen.queryByText("≈¥5.00")).not.toBeInTheDocument();
    // 1:5 站余额：$10.00 ≈¥2.00。
    await screen.findByText("$10.00");
    await screen.findByText("≈¥2.00");
    // 1:5 站的明细价格也带 ≈：input $1 → ≈¥0.20。
    const approxCells = await screen.findAllByText("≈¥0.20");
    expect(approxCells.length).toBeGreaterThan(0);
  });

  it("sorts by the clicked price column with converted values, exclusive and toggleable", async () => {
    renderDialog();
    await screen.findByText("$5.00");
    // 价格列头含排序按钮（首个价格列 = 输入列；表头共 8 列，价格列从第 4 个 th 开始）。
    const priceHeaders = screen.getAllByRole("columnheader").filter((th) =>
      th.querySelector("button"),
    );
    expect(priceHeaders).toHaveLength(4);
    const bodyRows = () =>
      screen.getAllByRole("row").slice(1).filter((row) => row.textContent?.includes("model-"));
    const priceButton = (index: number) =>
      screen
        .getAllByRole("columnheader")
        .filter((th) => th.querySelector("button"))[index]!
        .querySelector("button")!;
    const stationOf = (text: string | null | undefined) =>
      text?.includes("一站") && text?.includes("五站")
        ? "both"
        : text?.includes("五站")
          ? "five"
          : "one";
    // 第一次点击输入列：升序（折算人民币：五站a ¥0.2 < 一站a ¥1 < 一站b ¥3）。
    fireEvent.click(priceButton(0));
    let texts = bodyRows().map((row) => row.textContent);
    expect(stationOf(texts[0])).toBe("five");
    expect(texts[0]).toContain("model-a");
    // 按钮进入 active（aria-label 变化）。
    expect(priceButton(0)).toHaveAttribute("aria-label", "Ascending");
    // 第二次点击：降序，首行变为一站 model-b（¥3）。
    fireEvent.click(priceButton(0));
    texts = bodyRows().map((row) => row.textContent);
    expect(texts[0]).toContain("model-b");
    // 第三次点击：取消排序，回到默认（model 字典序）。
    fireEvent.click(priceButton(0));
    texts = bodyRows().map((row) => row.textContent);
    expect(texts[0]).toContain("model-a");
    expect(stationOf(texts[0])).toBe("one");
    // 排序互斥：点「/ 次」列后，有次价的（model-b）排最前，两个 null 行排最后。
    fireEvent.click(priceButton(3));
    texts = bodyRows().map((row) => row.textContent);
    expect(texts[0]).toContain("model-b");
    expect(stationOf(texts[texts.length - 1])).toBe("five");
    expect(texts[texts.length - 1]).toContain("model-a");
  });
});
