import { describe, expect, it } from "vitest";
import {
  extractDeepSeekBalance,
  extractOpenRouterBalance,
  extractUsageShapeBalance,
  RELAY_BALANCE_PRESETS,
} from "./relay-balance-presets.js";

describe("relay balance presets", () => {
  it("extracts DeepSeek balance from string total_balance (real response shape)", () => {
    // 实测响应：total_balance 是字符串，CNY 主账户。
    const payload = {
      is_available: true,
      balance_infos: [
        {
          currency: "CNY",
          total_balance: "6.18",
          granted_balance: "0.00",
          topped_up_balance: "6.18",
        },
      ],
    };
    const result = extractDeepSeekBalance(payload);
    expect(result).not.toBeNull();
    // 6.18 CNY / 7.2 ≈ 0.858333 USD
    expect(result!.remainingUsd).toBeCloseTo(6.18 / 7.2, 6);
  });

  it("prefers USD entry and accepts numeric values", () => {
    const payload = {
      balance_infos: [
        { currency: "CNY", total_balance: "100.00" },
        { currency: "USD", total_balance: 13.5 },
      ],
    };
    expect(extractDeepSeekBalance(payload)?.remainingUsd).toBeCloseTo(13.5, 6);
  });

  it("rejects malformed DeepSeek payloads", () => {
    expect(extractDeepSeekBalance(null)).toBeNull();
    expect(extractDeepSeekBalance({})).toBeNull();
    expect(extractDeepSeekBalance({ balance_infos: [{ currency: "CNY" }] })).toBeNull();
    expect(extractDeepSeekBalance({ balance_infos: "x" })).toBeNull();
  });

  it("extracts OpenRouter remaining as credits minus usage", () => {
    const payload = { data: { total_credits: 10, total_usage: 2.5 } };
    const result = extractOpenRouterBalance(payload);
    expect(result?.remainingUsd).toBeCloseTo(7.5, 6);
    expect(result?.totalUsageUsd).toBeCloseTo(2.5, 6);
    // 缺 usage 视为 0；total_credits 缺失/非数字返回 null。
    expect(extractOpenRouterBalance({ data: { total_credits: 5 } })?.remainingUsd).toBe(5);
    expect(extractOpenRouterBalance({ data: {} })).toBeNull();
    expect(extractOpenRouterBalance(null)).toBeNull();
    // 字符串数字也兼容。
    expect(extractOpenRouterBalance({ data: { total_credits: "9.9" } })?.remainingUsd).toBeCloseTo(
      9.9,
      6,
    );
  });

  it("extracts NingYi-style /v1/usage shape balance", () => {
    // NingYi 实测：顶层 balance/remaining 已是美元。
    const payload = {
      balance: 7.17589596,
      remaining: 7.17589596,
      unit: "USD",
      usage: { total_cost: 0.018 },
    };
    const result = extractUsageShapeBalance(payload);
    expect(result?.remainingUsd).toBeCloseTo(7.17589596, 6);
    expect(result?.totalUsageUsd).toBeCloseTo(0.018, 6);
    // balance 缺失或非数字 → null（回退）。
    expect(extractUsageShapeBalance({ remaining: 1 })).toBeNull();
    expect(extractUsageShapeBalance({ balance: "7" })).toBeNull();
    expect(extractUsageShapeBalance(null)).toBeNull();
  });

  it("registers preset domains and paths", () => {
    const deepseek = RELAY_BALANCE_PRESETS.find((entry) => entry.domain === "deepseek.com");
    expect(deepseek?.path).toBe("/user/balance");
    const openrouter = RELAY_BALANCE_PRESETS.find((entry) => entry.domain === "openrouter.ai");
    expect(openrouter?.path).toBe("/api/v1/credits");
  });
});
