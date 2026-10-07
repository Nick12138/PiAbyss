import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelTaskbarAttention, requestTaskbarAttention } from "./taskbar-attention";

const windowApi = vi.hoisted(() => ({
  requestUserAttention: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowApi,
  UserAttentionType: { Critical: 1, Informational: 2 },
}));

const windowsInvoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown) => undefined));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...actual,
    // The stock isTauri() returns false in test environments (no Tauri IPC),
    // which would skip the Windows branch of taskbar-attention entirely.
    isTauri: vi.fn(() => true),
    invoke: (...args: unknown[]) =>
      // The Windows branch of taskbar-attention invokes the custom Rust
      // command; route that through its own mock and keep everything else
      // on the shared invoke mock.
      args[0] === "taskbar_flash"
        ? windowsInvoke(args[0] as string, args[1])
        : actual.invoke(args[0] as Parameters<typeof actual.invoke>[0], args[1] as never),
  };
});

describe("taskbar-attention", () => {
  beforeEach(() => {
    windowApi.requestUserAttention.mockClear();
    windowsInvoke.mockClear();
  });

  it("uses the custom FlashWindowEx command on Windows", async () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    try {
      await requestTaskbarAttention();
      expect(windowsInvoke).toHaveBeenCalledWith("taskbar_flash", {
        options: { stop: false },
      });
      expect(windowApi.requestUserAttention).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancels the flash through the custom command on Windows", async () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    try {
      await cancelTaskbarAttention();
      expect(windowsInvoke).toHaveBeenCalledWith("taskbar_flash", {
        options: { stop: true },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requests critical attention via the window API elsewhere", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    try {
      await requestTaskbarAttention();
      expect(windowApi.requestUserAttention).toHaveBeenCalledWith(1);
      expect(windowsInvoke).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancels the attention request with null elsewhere", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    try {
      await cancelTaskbarAttention();
      expect(windowApi.requestUserAttention).toHaveBeenCalledWith(null);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("swallows failures from the window API", async () => {
    windowApi.requestUserAttention.mockRejectedValueOnce(new Error("window gone"));
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      await expect(requestTaskbarAttention()).resolves.toBeUndefined();
    } finally {
      debug.mockRestore();
    }
  });
});
