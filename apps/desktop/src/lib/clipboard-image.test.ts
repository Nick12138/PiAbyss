/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildImageCopyMenuItem, copyImageToClipboard } from "./clipboard-image";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  invoke: vi.fn(),
  fromBytes: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri, invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/image", () => ({ Image: { fromBytes: mocks.fromBytes } }));

/** jsdom 没有布局，也无法真的解码图片；注入 1×1 尺寸并让 onload 立即触发。 */
function stubImageLoading() {
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    value: class {
      decoding = "";
      naturalWidth = 2;
      naturalHeight = 1;
      onload: () => void = () => {};
      onerror: () => void = () => {};
      set src(value: string) {
        if (value === "broken:image") this.onerror();
        else this.onload();
      }
    },
  });
}

/** 让 canvas.toBlob 产出一个可识别的 PNG blob。 */
function stubCanvasEncoding() {
  const drawImage = vi.fn();
  const toBlob = vi.fn((resolve: (blob: Blob | null) => void) =>
    resolve(new Blob(["png-bytes"], { type: "image/png" })),
  );
  const getContext = vi.fn(() => ({ drawImage }));
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag === "canvas") {
      return {
        width: 0,
        height: 0,
        getContext,
        toBlob,
      } as unknown as HTMLCanvasElement;
    }
    return document.createElementNS("http://www.w3.org/1999/xhtml", tag);
  }) as typeof document.createElement);
  return { drawImage, toBlob };
}

beforeEach(() => {
  stubImageLoading();
  mocks.isTauri.mockReset();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.fromBytes.mockReset().mockResolvedValue({ rid: 7, close: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("copyImageToClipboard", () => {
  it("in Tauri writes PNG bytes through the native clipboard plugin and closes the resource", async () => {
    mocks.isTauri.mockReturnValue(true);
    const { drawImage } = stubCanvasEncoding();
    const resource = { rid: 7, close: vi.fn().mockResolvedValue(undefined) };
    mocks.fromBytes.mockResolvedValue(resource);

    await expect(copyImageToClipboard("data:image/png;base64,AAA")).resolves.toBe(true);

    expect(drawImage).toHaveBeenCalledOnce();
    expect(mocks.fromBytes).toHaveBeenCalledOnce();
    const bytes = mocks.fromBytes.mock.calls[0][0] as Uint8Array;
    expect(String.fromCharCode(...bytes)).toBe("png-bytes");
    expect(mocks.invoke).toHaveBeenCalledWith("plugin:clipboard-manager|write_image", {
      image: 7,
    });
    expect(resource.close).toHaveBeenCalledOnce();
  });

  it("closes the native image resource even when the clipboard write fails", async () => {
    mocks.isTauri.mockReturnValue(true);
    stubCanvasEncoding();
    const resource = {
      rid: 3,
      close: vi.fn().mockResolvedValue(undefined),
    };
    mocks.fromBytes.mockResolvedValue(resource);
    mocks.invoke.mockRejectedValue(new Error("clipboard unavailable"));

    await expect(copyImageToClipboard("data:image/png;base64,AAA")).resolves.toBe(false);
    expect(resource.close).toHaveBeenCalledOnce();
  });

  it("in the browser writes a PNG ClipboardItem through the Web Clipboard API", async () => {
    mocks.isTauri.mockReturnValue(false);
    stubCanvasEncoding();
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });
    class FakeClipboardItem {
      constructor(public items: Record<string, Blob>) {}
    }
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    await expect(copyImageToClipboard("blob:image")).resolves.toBe(true);

    expect(write).toHaveBeenCalledOnce();
    const [items] = write.mock.calls[0] as [Record<string, Blob>[]];
    const item = items[0] as unknown as FakeClipboardItem;
    expect(Object.keys(item.items)).toEqual(["image/png"]);
  });

  it("reports failure when the image cannot be decoded", async () => {
    await expect(copyImageToClipboard("broken:image")).resolves.toBe(false);
  });

  it("reports failure when the Web Clipboard API is unavailable", async () => {
    mocks.isTauri.mockReturnValue(false);
    stubCanvasEncoding();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });

    await expect(copyImageToClipboard("blob:image")).resolves.toBe(false);
  });
});

describe("buildImageCopyMenuItem", () => {
  it("notifies success and failure through the provided channels", async () => {
    stubCanvasEncoding();
    const notifySuccess = vi.fn();
    const notifyFailure = vi.fn();

    const success = buildImageCopyMenuItem({
      url: "blob:image",
      label: "Copy image",
      labelFailed: "Could not copy image",
      notifySuccess,
      notifyFailure,
    });
    mocks.isTauri.mockReturnValue(false);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write: vi.fn().mockResolvedValue(undefined) },
    });
    vi.stubGlobal("ClipboardItem", class {});

    await success.onSelect();
    expect(success.label).toBe("Copy image");
    expect(notifySuccess).toHaveBeenCalledWith("Copy image");
    expect(notifyFailure).not.toHaveBeenCalled();

    const failure = buildImageCopyMenuItem({
      url: "broken:image",
      label: "Copy image",
      labelFailed: "Could not copy image",
      notifySuccess,
      notifyFailure,
    });
    await failure.onSelect();
    expect(notifyFailure).toHaveBeenCalledWith("Could not copy image");
  });
});
