import { describe, expect, it } from "vitest";
import { hexToHsv, hsvToHex } from "./hsv";

describe("hsvToHex", () => {
  it("converts HSV primaries exactly", () => {
    expect(hsvToHex({ h: 0, s: 1, v: 1 })).toBe("#ff0000");
    expect(hsvToHex({ h: 120, s: 1, v: 1 })).toBe("#00ff00");
    expect(hsvToHex({ h: 240, s: 1, v: 1 })).toBe("#0000ff");
  });

  it("mixes hue between primaries", () => {
    expect(hsvToHex({ h: 60, s: 1, v: 1 })).toBe("#ffff00");
    expect(hsvToHex({ h: 30, s: 1, v: 1 })).toBe("#ff8000");
  });

  it("desaturates toward gray and scales by value", () => {
    expect(hsvToHex({ h: 0, s: 0, v: 1 })).toBe("#ffffff");
    expect(hsvToHex({ h: 0, s: 0, v: 0.5 })).toBe("#808080");
    expect(hsvToHex({ h: 20, s: 0.75, v: 0.5 })).toBe("#804020");
  });

  it("normalizes hue outside 0-360", () => {
    expect(hsvToHex({ h: -300, s: 1, v: 1 })).toBe("#ffff00"); // -300° ≡ 60°
    expect(hsvToHex({ h: 390, s: 1, v: 1 })).toBe("#ff8000"); // 390° ≡ 30°
    expect(hsvToHex({ h: 720, s: 1, v: 1 })).toBe("#ff0000");
  });
});

describe("hexToHsv", () => {
  it("roundtrips canonical hex colors through HSV", () => {
    for (const hex of [
      "#ff0000",
      "#00ff00",
      "#0000ff",
      "#804020",
      "#8b5cf6",
      "#df6b35",
      "#123456",
      "#000000",
      "#ffffff",
      "#0ea5e9",
    ]) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  it("extracts hue, saturation, and value", () => {
    expect(hexToHsv("#804020")).toEqual({ h: 20, s: 0.75, v: 128 / 255 });
  });

  it("keeps hue 0 for grays", () => {
    expect(hexToHsv("#000000")).toEqual({ h: 0, s: 0, v: 0 });
    expect(hexToHsv("#ffffff")).toEqual({ h: 0, s: 0, v: 1 });
  });
});
