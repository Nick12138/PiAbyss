/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeContextMenu } from "../lib/context-menu";
import { useAppStore } from "../lib/stores/app-store";
import { ImageLightbox, LightboxImage } from "./ImageLightbox";
import { MenuHost } from "./Menu";

vi.mock("../lib/clipboard-image", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  copyImageToClipboard: vi.fn(),
}));

/** jsdom 不解码图片（load/error 事件永不触发）；复制动作用快速假 Image 替代。 */
/**
 * jsdom does not decode images (load/error events never fire) and does not support canvas encoding;
 * without replacing them, the real copy chain would hang forever. buildImageCopyMenuItem closes over
 * the module-internal implementation, so patch the underlying environment here instead.
 */
function stubJsdomImagePipeline() {
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
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag === "canvas") {
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => undefined }),
        toBlob: (resolve: (blob: Blob | null) => void) =>
          resolve(new Blob(["png"], { type: "image/png" })),
      } as unknown as HTMLCanvasElement;
    }
    return document.createElementNS("http://www.w3.org/1999/xhtml", tag);
  }) as typeof document.createElement);
}

afterEach(() => {
  closeContextMenu();
  cleanup();
  vi.restoreAllMocks();
});

describe("ImageLightbox", () => {
  it("opens from the thumbnail, zooms, and closes via the close button", async () => {
    const user = userEvent.setup();
    render(<LightboxImage url="blob:image" alt="photo.png" className="w-10" />);

    const trigger = screen.getByTestId("lightbox-image-trigger");
    expect(trigger).toHaveClass("cursor-zoom-in");
    expect(screen.queryByTestId("image-lightbox")).not.toBeInTheDocument();

    await user.click(trigger);
    const dialog = screen.getByTestId("image-lightbox");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTestId("image-lightbox-scale")).toHaveTextContent("Fit");

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByTestId("image-lightbox-scale")).toHaveTextContent("125%");
    // 缩放必须作用到图片本身（transform scale），而不只是更新百分比文案。
    expect(screen.getByTestId("image-lightbox-image")).toHaveStyle({
      transform: "translate(0px, 0px) scale(1.25)",
    });

    await user.click(screen.getByRole("button", { name: "Original size" }));
    expect(screen.getByTestId("image-lightbox-scale")).toHaveTextContent("100%");

    await user.click(screen.getByTestId("image-lightbox-close"));
    expect(screen.queryByTestId("image-lightbox")).not.toBeInTheDocument();
  });

  it("closes with Escape and via backdrop click", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ImageLightbox url="blob:image" alt="photo.png" onClose={onClose} />);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();

    // 点击遮罩、图片四周留白等非图片区域都关闭；点击图片本身不关闭。
    await user.click(screen.getByTestId("image-lightbox"));
    expect(onClose).toHaveBeenCalledTimes(2);

    onClose.mockClear();
    await user.click(screen.getByTestId("image-lightbox-image"));
    expect(onClose).not.toHaveBeenCalled();

    // 点击工具栏按钮（含 SVG 图标）不应关闭预览；SVGElement 的 target 曾因 instanceof HTMLElement 判断失误而误关。
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("image-lightbox")).toBeInTheDocument();
  });

  it("zooms with keyboard shortcuts and clamps to the minimum scale", async () => {
    const user = userEvent.setup();
    render(<ImageLightbox url="blob:image" alt="photo.png" onClose={() => {}} />);

    for (let i = 0; i < 30; i += 1) await user.keyboard("-");
    expect(screen.getByTestId("image-lightbox-scale")).toHaveTextContent("10%");

    await user.keyboard("0");
    expect(screen.getByTestId("image-lightbox-scale")).toHaveTextContent("Fit");

    await user.keyboard("+");
    expect(screen.getByTestId("image-lightbox-scale")).toHaveTextContent("125%");
  });

  it("offers Copy image via right-click on the fullscreen image", async () => {
    stubJsdomImagePipeline();
    const pushNotification = vi.fn();
    useAppStore.setState({ pushNotification });
    // jsdom has no Clipboard API -> copy is bound to fail and surface the failure notification.
    const user = userEvent.setup();
    render(
      <>
        <ImageLightbox url="blob:image" alt="photo.png" onClose={() => {}} />
        <MenuHost />
      </>,
    );

    fireEvent.contextMenu(screen.getByTestId("image-lightbox-image"), {
      clientX: 12,
      clientY: 34,
    });
    await user.click(await screen.findByRole("menuitem", { name: "Copy image" }));
    await waitFor(() =>
      expect(pushNotification).toHaveBeenCalledWith("Could not copy image", "warning"),
    );
  });

  it("renders the menu above the lightbox overlay", async () => {
    stubJsdomImagePipeline();
    const pushNotification = vi.fn();
    useAppStore.setState({ pushNotification });
    render(
      <>
        <ImageLightbox url="blob:image" alt="photo.png" onClose={() => {}} />
        <MenuHost />
      </>,
    );

    fireEvent.contextMenu(screen.getByTestId("image-lightbox-image"), {
      clientX: 12,
      clientY: 34,
    });
    const lightbox = screen.getByTestId("image-lightbox");
    const menu = await screen.findByRole("menu");
    // Tailwind 的 z-* 工具类在这里是 arbitrary/命名 z-index；jsdom 不做层叠计算，
    // 所以直接断言双方的 z-index 声明（菜单 120 必须高于 lightbox 的 60）。
    const menuZ = Number.parseInt(/z-\[(\d+)\]/.exec(menu.className)?.[1] ?? "0", 10);
    const lightboxZ = Number.parseInt(/z-\[(\d+)\]/.exec(lightbox.className)?.[1] ?? "0", 10);
    expect(menuZ).toBeGreaterThan(lightboxZ);
  });

  it("does not open the image menu when right-clicking outside the image itself", async () => {
    stubJsdomImagePipeline();
    const pushNotification = vi.fn();
    useAppStore.setState({ pushNotification });
    render(
      <>
        <LightboxImage url="blob:image" alt="photo.png" className="w-10 rounded-md p-3" />
        <MenuHost />
      </>,
    );

    // 点在缩略图容器（<img> 的父元素）上不弹图片菜单。
    const wrapper = document.createElement("div");
    wrapper.dataset.testid = "wrapper";
    fireEvent.contextMenu(wrapper, { clientX: 5, clientY: 5 });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("copies the image from the lightbox toolbar button", async () => {
    stubJsdomImagePipeline();
    const pushNotification = vi.fn();
    useAppStore.setState({ pushNotification });
    const user = userEvent.setup();
    render(<ImageLightbox url="blob:image" alt="photo.png" onClose={() => {}} />);

    await user.click(screen.getByTestId("image-lightbox-copy"));
    await waitFor(() =>
      expect(pushNotification).toHaveBeenCalledWith("Could not copy image", "warning"),
    );
  });

  it("offers Copy image via right-click on a LightboxImage thumbnail", async () => {
    render(
      <>
        <LightboxImage url="blob:image" alt="photo.png" className="w-10" />
        <MenuHost />
      </>,
    );

    fireEvent.contextMenu(screen.getByTestId("lightbox-image-trigger"));
    expect(await screen.findByRole("menuitem", { name: "Copy image" })).toBeInTheDocument();
    // 缩略图的点击放大行为不受右键影响。
    expect(screen.queryByTestId("image-lightbox")).not.toBeInTheDocument();
  });
});
