import { describe, expect, it } from "vitest";
import {
  extractDeepSeekBalance,
  extractOpenRouterBalance,
  extractUsageShapeBalance,
  RELAY_BALANCE_PRESETS,
} from "./relay-balance-presets.js";

describe("relay balance presets", () => {
  it("extracts DeepSeek balance with native CNY currency (real response shape)", () => {
    // 实测响应：total_balance 是字符串，CNY 主账户。币种原样保留，不折算。
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
    expect(result!.remaining).toBeCloseTo(6.18, 6);
    expect(result!.currency).toBe("CNY");
  });

  it("accepts USD accounts and numeric values", () => {
    const payload = {
      balance_infos: [
        { currency: "CNY", total_balance: "100.00" },
        { currency: "USD", total_balance: 13.5 },
      ],
    };
    const result = extractDeepSeekBalance(payload);
    expect(result?.remaining).toBeCloseTo(13.5, 6);
    expect(result?.currency).toBe("USD");
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
    expect(result?.remaining).toBeCloseTo(7.5, 6);
    expect(result?.used).toBeCloseTo(2.5, 6);
    expect(result?.currency).toBe("USD");
    // 缺 usage 视为 0；total_credits 缺失/非数字返回 null。
    expect(extractOpenRouterBalance({ data: { total_credits: 5 } })?.remaining).toBe(5);
    expect(extractOpenRouterBalance({ data: {} })).toBeNull();
    expect(extractOpenRouterBalance(null)).toBeNull();
    // 字符串数字也兼容。
    expect(extractOpenRouterBalance({ data: { total_credits: "9.9" } })?.remaining).toBeCloseTo(
      9.9,
      6,
    );
  });

  it("extracts NingYi-style /v1/usage shape balance with unit currency", () => {
    // NingYi 实测：顶层 balance/remaining 已是美元，unit: "USD"。
    const payload = {
      balance: 7.17589596,
      remaining: 7.17589596,
      unit: "USD",
      usage: { total_cost: 0.018 },
    };
    const result = extractUsageShapeBalance(payload);
    expect(result?.remaining).toBeCloseTo(7.17589596, 6);
    expect(result?.used).toBeCloseTo(0.018, 6);
    expect(result?.currency).toBe("USD");
    // CNY 站也按 unit 保留。
    expect(extractUsageShapeBalance({ balance: 50, unit: "CNY" })?.currency).toBe("CNY");
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
