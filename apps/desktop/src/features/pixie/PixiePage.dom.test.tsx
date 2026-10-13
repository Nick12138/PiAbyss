/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesktopSettings, SessionSnapshot } from "@piabyss/protocol";
import { type MessageKey } from "../../lib/i18n";
import { tCurrent } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { usePixieViewStore } from "./pixie-store";
import { PixieNapButton } from "./PixieNapButton";

/**
 * 「打个盹」的门禁回归（v5）：打盹 = pixie.newSegment 切新会话，门禁只看
 * 标准会话通道的忙/闲（app-store.session.isIdle）与宿主是否就绪。会话不在
 * pixie 页也没关系——按钮只在 page==="pixie" 时渲染在顶部栏。
 */
function sessionSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: "33333333-3333-4333-8333-333333333333",
    cwd: "/workspace/pixie",
    revision: 1,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    thinkingLevel: "off",
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    steeringMode: "all",
    followUpMode: "all",
    pending: { revision: 1, steering: [], followUp: [] },
    messages: [],
    tools: {
      revision: 1,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      sessionRevision: 1,
      tools: [],
      active: [],
    },
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
  useAppStore.setState({
    host: null,
    session: null,
    page: "pixie",
    desktopSettings: {
      knownWorkspaces: [],
      language: "zh",
    } as unknown as DesktopSettings,
  });
  usePixieViewStore.setState({ current: null, dispatches: [], error: null });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ host: null, session: null, page: "chat" });
  usePixieViewStore.setState({ current: null, dispatches: [], error: null });
});

describe("Pixie 打个盹按钮（顶部栏，v5 标准通道）", () => {
  it("无宿主时禁用（host not ready）", () => {
    render(<PixieNapButton />);
    expect(napButton()).toBeDisabled();
  });

  it("宿主就绪 + 会话空闲时可点，提示是常规的换段说明", () => {
    useAppStore.setState({
      host: { hostInstanceId: "h1" } as never,
      session: sessionSnapshot(),
    });
    render(<PixieNapButton />);
    expect(napButton()).not.toBeDisabled();
    expect(napButton()).toHaveAttribute("title", t("pixieNapHint"));
  });

  it("会话正在生成时禁用，并说明原因", () => {
    useAppStore.setState({
      host: { hostInstanceId: "h1" } as never,
      session: sessionSnapshot({ isIdle: false, isStreaming: true }),
    });
    render(<PixieNapButton />);
    expect(napButton()).toBeDisabled();
    expect(napButton()).toHaveAttribute("title", t("pixieNapHintBusy"));
  });

  it("没有活动会话但宿主就绪时可点（newSegment 本身幂等）", () => {
    useAppStore.setState({ host: { hostInstanceId: "h1" } as never, session: null });
    render(<PixieNapButton />);
    expect(napButton()).not.toBeDisabled();
  });
});
