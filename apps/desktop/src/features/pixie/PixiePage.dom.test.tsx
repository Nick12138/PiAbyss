/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesktopSettings, PixieAgentState } from "@piabyss/protocol";
import { type MessageKey } from "../../lib/i18n";
import { tCurrent } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { usePixieViewStore } from "./pixie-store";
import { PixieNapButton } from "./PixieNapButton";

/**
 * 「打个盹」的门禁回归：它只按"她正在回复"和"完全没有状态"禁用。
 *
 * `resident === false`（宿主重启后段还没重建、或她刚睡完）**不能**禁用——
 * 那正是宿主会按时间线恢复段的状态，早期实现把按钮卡死在这里：
 * 时间线上明明还开着一段，界面却永远点不动。
 *
 * 按钮已随页头从 PixiePage 搬到应用顶部栏（AppTopBar 在 page==="pixie" 时
 * 渲染它），所以这里直接渲染组件本身。
 */
function pixieState(overrides: Partial<PixieAgentState> = {}): PixieAgentState {
  return {
    resident: true,
    sessionPath: "/sessions/pixie/seg.jsonl",
    running: false,
    error: null,
    messages: [],
    segments: [],
    askPending: false,
    modelName: null,
    dispatches: [],
    ...overrides,
  };
}

/** Mirror the component's own translate call (same locale source as useT). */
function t(key: MessageKey): string {
  return tCurrent(key);
}

function napButton(): HTMLButtonElement {
  return screen.getByTestId("pixie-nap-button") as HTMLButtonElement;
}

beforeEach(() => {
  // 无宿主：refresh / pushContext 直接短路，页面只按种子状态渲染。
  // desktopSettings 必须是稳定对象：`?? []` 每次渲染新建数组会触发无限循环。
  useAppStore.setState({
    host: null,
    desktopSettings: {
      knownWorkspaces: [],
      language: "zh",
    } as unknown as DesktopSettings,
  });
  usePixieViewStore.setState({ state: pixieState(), error: null });
});

afterEach(() => {
  cleanup();
  usePixieViewStore.setState({ state: null, error: null });
});

describe("Pixie 打个盹按钮（顶部栏）", () => {
  it("resident=false（宿主重启后段未重建 / 她刚睡完）依然可点", () => {
    usePixieViewStore.setState({ state: pixieState({ resident: false }) });

    render(<PixieNapButton />);

    expect(napButton()).not.toBeDisabled();
    expect(napButton()).toHaveAttribute("title", t("pixieNapHintAsleep"));
  });

  it("有驻留段时可点，提示是常规的换段说明", () => {
    render(<PixieNapButton />);

    expect(napButton()).not.toBeDisabled();
    expect(napButton()).toHaveAttribute("title", t("pixieNapHint"));
  });

  it("她正在回复时禁用，并说明原因", () => {
    usePixieViewStore.setState({ state: pixieState({ running: true }) });

    render(<PixieNapButton />);

    expect(napButton()).toBeDisabled();
    expect(napButton()).toHaveAttribute("title", t("pixieNapHintBusy"));
  });

  it("拿不到 pixie.state 时禁用（插件关了/不可达）", () => {
    usePixieViewStore.setState({ state: null });

    render(<PixieNapButton />);

    expect(napButton()).toBeDisabled();
  });
});
