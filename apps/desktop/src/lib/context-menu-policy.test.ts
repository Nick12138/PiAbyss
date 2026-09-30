/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { resolveImageMenuTarget, shouldKeepNativeContextMenu } from "./context-menu-policy";

describe("native context-menu exceptions", () => {
  it("preserves drag-region and development Shift menus only", () => {
    const dragRegion = document.createElement("div");
    dragRegion.dataset.tauriDragRegion = "";
    const child = document.createElement("span");
    dragRegion.append(child);
    expect(shouldKeepNativeContextMenu({ target: child, shiftKey: false }, false)).toBe(true);
    expect(shouldKeepNativeContextMenu({ target: document.body, shiftKey: true }, true)).toBe(true);
    expect(shouldKeepNativeContextMenu({ target: document.body, shiftKey: true }, false)).toBe(
      false,
    );
    expect(shouldKeepNativeContextMenu({ target: document.body, shiftKey: false }, true)).toBe(
      false,
    );
  });
});

describe("image context-menu target", () => {
  it("resolves only a direct <img> hit, never an ancestor container", () => {
    const wrapper = document.createElement("div");
    const image = document.createElement("img");
    image.src = "blob:photo";
    wrapper.append(image);
    document.body.append(wrapper);

    expect(resolveImageMenuTarget(image)).toBe("blob:photo");
    // 点在容器（非图片本体）上不应解析出图片，图片菜单不会打开。
    expect(resolveImageMenuTarget(wrapper)).toBeNull();
    expect(resolveImageMenuTarget(document.body)).toBeNull();
    expect(resolveImageMenuTarget(null)).toBeNull();
  });
});
