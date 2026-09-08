import { describe, expect, it } from "vitest";
import { formatTokenCount, formatTokenCountExact, parseTokenCount } from "./format-token-count";

describe("formatTokenCount", () => {
  it("keeps small values and compacts thousands and millions", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_000)).toBe("1k");
    expect(formatTokenCount(15_742)).toBe("15.7k");
    expect(formatTokenCount(125_000)).toBe("125k");
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
  });
});

describe("parseTokenCount", () => {
  it("accepts plain numbers, k and m suffixes case-insensitively", () => {
    expect(parseTokenCount("200000")).toBe(200_000);
    expect(parseTokenCount("127K")).toBe(127_000);
    expect(parseTokenCount("127k")).toBe(127_000);
    expect(parseTokenCount("1.05M")).toBe(1_050_000);
    expect(parseTokenCount("1m")).toBe(1_000_000);
    expect(parseTokenCount(" 64K ")).toBe(64_000);
    expect(parseTokenCount("1.05 m")).toBe(1_050_000);
    expect(parseTokenCount("0.5k")).toBe(500);
  });

  it("rejects empty, malformed and non-positive input", () => {
    expect(parseTokenCount("")).toBeNull();
    expect(parseTokenCount("   ")).toBeNull();
    expect(parseTokenCount("abc")).toBeNull();
    expect(parseTokenCount("12a")).toBeNull();
    expect(parseTokenCount("-5")).toBeNull();
    expect(parseTokenCount("0")).toBeNull();
    expect(parseTokenCount("0K")).toBeNull();
    expect(parseTokenCount("1.")).toBeNull();
  });
});

describe("formatTokenCountExact", () => {
  it("round-trips every formatted value through parseTokenCount", () => {
    for (const tokens of [
      1, 999, 1_000, 15_742, 64_000, 128_000, 131_072, 372_000, 1_000_000, 1_050_000, 1_005_000,
      999_999_999,
    ]) {
      expect(parseTokenCount(formatTokenCountExact(tokens))).toBe(tokens);
    }
  });

  it("prefers compact forms without losing precision", () => {
    expect(formatTokenCountExact(128_000)).toBe("128k");
    expect(formatTokenCountExact(372_000)).toBe("372k");
    expect(formatTokenCountExact(1_000_000)).toBe("1M");
    expect(formatTokenCountExact(1_050_000)).toBe("1.05M");
    expect(formatTokenCountExact(1_005_000)).toBe("1005k");
    expect(formatTokenCountExact(131_072)).toBe("131072");
  });
});
