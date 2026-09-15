import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openSystemUrl: vi.fn(),
}));

vi.mock("../../lib/open-system-url", () => ({
  openSystemUrl: mocks.openSystemUrl,
}));

import { openChatLink } from "./chat-link";

beforeEach(() => {
  mocks.openSystemUrl.mockReset().mockResolvedValue(undefined);
});

describe("chat link routing", () => {
  it("opens a safe link in the system browser", () => {
    expect(openChatLink("https://example.com/path", { button: 0 })).toBe(true);
    expect(mocks.openSystemUrl).toHaveBeenCalledWith("https://example.com/path");
  });

  it.each([
    ["meta", { metaKey: true }],
    ["control", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["middle click", { button: 1 }],
  ])("keeps using the system browser for %s activation", (_label, activation) => {
    expect(openChatLink("https://example.com/system", activation)).toBe(true);
    expect(mocks.openSystemUrl).toHaveBeenCalledWith("https://example.com/system");
  });

  it("rejects unsafe URLs without opening anything", () => {
    expect(openChatLink("file:///tmp/private")).toBe(false);
    expect(openChatLink("javascript:alert(1)")).toBe(false);
    expect(mocks.openSystemUrl).not.toHaveBeenCalled();
  });
});
