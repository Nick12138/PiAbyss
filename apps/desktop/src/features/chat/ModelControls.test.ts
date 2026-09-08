import { describe, expect, it, vi } from "vitest";
import type { ModelSummary } from "@piabyss/protocol";
import {
  canRequestModelList,
  clampModelMenuWidth,
  currentModelLabel,
  includeCurrentModel,
  modelMenuMaxWidth,
  modelMenuPlacement,
  modelOptionLabel,
  requestModelListWithRetry,
  resolveThinkingLevels,
  thinkingLevelLabel,
  thinkingLevelsForModel,
} from "./ModelControls";

const current: ModelSummary = {
  provider: "muapi",
  modelId: "grok-4.5",
  name: "Grok 4.5",
};

describe("includeCurrentModel", () => {
  it("shows the selected model before model.list completes", () => {
    expect(includeCurrentModel([], current)).toEqual([current]);
  });

  it("does not duplicate a selected model returned by model.list", () => {
    expect(includeCurrentModel([current], current)).toEqual([current]);
  });

  it("does not reinsert a model from a disabled Provider", () => {
    expect(includeCurrentModel([], current, ["other-provider"])).toEqual([]);
  });

  it("keeps the current model when its Provider is one of several enabled", () => {
    expect(includeCurrentModel([], current, ["other-provider", "muapi"])).toEqual([current]);
  });

  it("uses the selected model's own thinking levels", () => {
    const models: ModelSummary[] = [
      { ...current, thinkingLevels: ["low", "medium", "high"] },
      {
        provider: "muapi",
        modelId: "grok-composer-2.5-fast",
        name: "Grok Composer",
        thinkingLevels: ["off"],
      },
    ];
    expect(thinkingLevelsForModel(models, current, ["off"])).toEqual(["low", "medium", "high"]);
    expect(thinkingLevelsForModel(models, models[1], ["low"])).toEqual(["off"]);
  });
});

describe("resolveThinkingLevels", () => {
  it("prefers the session model's own non-empty levels", () => {
    const models: ModelSummary[] = [{ ...current, thinkingLevels: ["off", "high"] }];
    expect(resolveThinkingLevels({ ...current, thinkingLevels: ["low"] }, models)).toEqual(["low"]);
  });

  it("falls back to the catalog entry when the session model omits levels", () => {
    const models: ModelSummary[] = [{ ...current, thinkingLevels: ["off", "high"] }];
    expect(resolveThinkingLevels(current, models)).toEqual(["off", "high"]);
    expect(resolveThinkingLevels({ ...current, thinkingLevels: [] }, models)).toEqual([
      "off",
      "high",
    ]);
  });

  it("returns no levels when neither the session nor the catalog carries them", () => {
    expect(resolveThinkingLevels(current, [])).toEqual([]);
    expect(resolveThinkingLevels(undefined, [{ ...current, thinkingLevels: ["off"] }])).toEqual([]);
  });
});

describe("modelOptionLabel", () => {
  it("prefixes the model name with the Provider display name", () => {
    expect(modelOptionLabel(current)).toBe("muapi/Grok 4.5");
    expect(modelOptionLabel({ ...current, providerName: "天机阁" })).toBe("天机阁/Grok 4.5");
  });

  it("falls back to the Provider ID when no display name is present", () => {
    expect(modelOptionLabel({ ...current, providerName: undefined })).toBe("muapi/Grok 4.5");
  });
});

describe("currentModelLabel", () => {
  it("prefers the Provider display name from the model catalog", () => {
    const snapshotModel = { ...current, providerName: undefined };
    const catalog = [{ ...current, providerName: "天机阁" }];
    expect(currentModelLabel(snapshotModel, catalog, "")).toBe("天机阁/Grok 4.5");
  });

  it("falls back to the snapshot summary when the model is not in the catalog", () => {
    expect(currentModelLabel(current, [], "")).toBe("muapi/Grok 4.5");
  });

  it("returns the fallback when there is no current model", () => {
    expect(currentModelLabel(undefined, [current], "No model")).toBe("No model");
  });
});

describe("model menu resize geometry", () => {
  it("keeps the current minimum while allowing a wider user-selected width", () => {
    expect(clampModelMenuWidth(80, 100, 1_000)).toBe(120);
    expect(clampModelMenuWidth(420, 100, 1_000)).toBe(420);
    expect(clampModelMenuWidth(900, 100, 1_000)).toBe(640);
  });

  it("caps the menu width at the viewport limit", () => {
    expect(modelMenuMaxWidth(100, 700)).toBe(588);
    expect(clampModelMenuWidth(600, 100, 700)).toBe(588);
  });

  it("uses the conversation boundary instead of the window boundary", () => {
    expect(
      modelMenuPlacement({
        menuLeft: 500,
        menuRight: 620,
        boundaryLeft: 240,
        boundaryRight: 800,
        menuWidth: 400,
      }),
    ).toEqual({ alignRight: true, availableWidth: 368 });
  });
});

describe("thinkingLevelLabel", () => {
  it("keeps model thinking levels in English", () => {
    expect(["off", "minimal", "low", "medium", "high", "xhigh"].map(thinkingLevelLabel)).toEqual([
      "Off",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high",
    ]);
    expect(thinkingLevelLabel("provider-specific")).toBe("provider-specific");
  });
});

describe("canRequestModelList", () => {
  const ready = {
    hasHost: true,
    hasWorkspace: true,
    hasSession: true,
    connecting: false,
    rehydrating: false,
    desynchronized: false,
  };

  it("waits until recovery has a synchronized Host generation", () => {
    expect(canRequestModelList(ready)).toBe(true);
    expect(canRequestModelList({ ...ready, connecting: true })).toBe(false);
    expect(canRequestModelList({ ...ready, rehydrating: true })).toBe(false);
    expect(canRequestModelList({ ...ready, desynchronized: true })).toBe(false);
    expect(canRequestModelList({ ...ready, hasSession: false })).toBe(false);
  });
});

describe("requestModelListWithRetry", () => {
  it("retries transient failures until the model list succeeds", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
      })
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: "STALE_REVISION", retryable: true },
      })
      .mockResolvedValueOnce({ ok: true as const, result: { models: [current] } });
    const wait = vi.fn(async () => {});

    const result = await requestModelListWithRetry(request, wait);

    expect(result).toEqual({ ok: true, result: { models: [current] } });
    expect(request).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[80], [160]]);
  });

  it("does not retry a non-retryable failure", async () => {
    const response = {
      ok: false as const,
      error: { code: "INTERNAL_ERROR", retryable: false },
    };
    const request = vi.fn(async () => response);
    const wait = vi.fn(async () => {});

    await expect(requestModelListWithRetry(request, wait)).resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("stops after five retryable failures", async () => {
    const response = {
      ok: false as const,
      error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
    };
    const request = vi.fn(async () => response);
    const wait = vi.fn(async () => {});

    await expect(requestModelListWithRetry(request, wait)).resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(5);
    expect(wait.mock.calls).toEqual([[80], [160], [240], [320]]);
  });

  it("cancels retries when the request generation changes", async () => {
    let active = true;
    const request = vi.fn(async () => ({
      ok: false as const,
      error: { code: "SERVICE_GRAPH_BUSY", retryable: true },
    }));
    const wait = vi.fn(async () => {
      active = false;
    });

    await expect(requestModelListWithRetry(request, wait, () => active)).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
