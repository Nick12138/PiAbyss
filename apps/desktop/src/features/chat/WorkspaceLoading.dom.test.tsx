/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { WorkspaceLoading } from "./WorkspaceLoading";

const BASE_SETTINGS = {
  theme: "system" as const,
  language: "en" as const,
  autoRestartHostOnce: true,
  extensionDecisionPresentation: "auto" as const,
  terminalProfile: "auto" as const,
};

describe("WorkspaceLoading", () => {
  beforeEach(() => {
    useAppStore.getState().setDesktopSettings(BASE_SETTINGS);
  });

  afterEach(cleanup);

  it("renders the ambient layers the CSS animates", () => {
    const { container } = render(<WorkspaceLoading />);

    expect(container.querySelector(".ws-loading")).toBeInTheDocument();
    // 背景光点：固定 46 颗，位置由种子生成，不随重渲染变化
    expect(container.querySelectorAll(".ws-loading-mote")).toHaveLength(46);
    // 圆心是共用的「环绕」标记：两道轨道，各挂一颗光点
    expect(container.querySelectorAll(".pi-orbit-path")).toHaveLength(2);
    const orbs = container.querySelectorAll(".pi-orbit-orb");
    expect(orbs).toHaveLength(2);
    orbs.forEach((orb) => expect(orb.querySelectorAll("i")).toHaveLength(1));
    expect(container.querySelector(".pi-orbit-mark img")).toBeInTheDocument();
  });

  it("keeps the status text out of sight but available to screen readers", () => {
    const { container } = render(<WorkspaceLoading />);

    const status = screen.getByRole("status");
    expect(status).toHaveClass("sr-only");
    expect(status).toHaveTextContent("Workspace services are not ready.");

    // 除了那一句读屏文案，等待区里不该有任何可见文字
    const visibleText = Array.from(container.querySelectorAll("*")).filter(
      (el) => !el.closest(".sr-only") && el.children.length === 0 && el.textContent?.trim(),
    );
    expect(visibleText).toHaveLength(0);
  });

  it("surfaces a host error when the switch actually failed", () => {
    const { container } = render(<WorkspaceLoading error="Directory does not exist: /nope" />);

    const error = container.querySelector(".ws-loading-error");
    expect(error).toHaveTextContent("Directory does not exist: /nope");
  });

  it("leaves no error line when the switch is merely slow", () => {
    const { container } = render(<WorkspaceLoading error={null} />);

    expect(container.querySelector(".ws-loading-error")).not.toBeInTheDocument();
  });
});
