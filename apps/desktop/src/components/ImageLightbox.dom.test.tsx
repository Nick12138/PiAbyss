/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageLightbox, LightboxImage } from "./ImageLightbox";

afterEach(() => {
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
});
