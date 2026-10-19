/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostStatusSnapshot, SessionSnapshot, WorkspaceSnapshot } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { Transcript } from "./Transcript";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

const RECAP = `<pixie-segments>
最近 1 段（新→旧，序号即 pixie_recall 的 segment 参数，0 = 上一段）：
0. 😀 Qoder反代项目推荐 · 10-19 12:47 · 65 条

上一段（😀 Qoder反代项目推荐）的收尾：
[1] 10-19 14:02 小精灵: 改好了，没走浏览器。
</pixie-segments>`;

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 1,
    packageRevision: 1,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: 1,
    servicesReady: true,
  };
}

function pixieSession(): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: "/workspace",
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
    pending: { revision: 0, steering: [], followUp: [] },
    messages: [
      {
        role: "system",
        content: "",
        sections: { preamble: "You are pi", tools: "old tools" },
      },
      {
        role: "system",
        content: "",
        sections: { tools: "new tools" },
      },
      {
        role: "user",
        content:
          "[pixie|ui]\n<pixie-context>\n本段开始时间：2026-10-19 22:09\n</pixie-context>\n嗨",
      },
      { role: "custom", customType: "pixie-segments", display: true, content: RECAP },
      { role: "assistant", content: "嗨～晚上好！" },
    ],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 1,
      tools: [],
      active: [],
    },
  };
}

describe("Transcript preamble fold", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(pixieSession());
  });

  afterEach(() => {
    cleanup();
  });

  it("folds the three segment-opening blocks into one collapsed card", () => {
    render(<Transcript />);

    expect(screen.getByText("Segment opening · previous “😀 Qoder反代项目推荐”")).toBeVisible();
    // 用户的 `@小精灵上下文` chip、独立的回顾分隔线、置顶的系统提示词行都不再各自出现。
    expect(screen.queryByText("@Pixie context")).not.toBeInTheDocument();
    expect(screen.queryByText("Previous segment recap")).not.toBeInTheDocument();
    expect(screen.queryByText("System prompt")).not.toBeInTheDocument();
    // 用户自己的话还在。
    expect(screen.getByText("嗨")).toBeVisible();
  });

  it("expands to the run rules, the recap list and the merged system prompt", async () => {
    const user = userEvent.setup();
    render(<Transcript />);

    await user.click(screen.getByRole("button", { name: /Segment opening · previous/ }));

    const rules = screen.getByRole("button", { name: /Run rules/ });
    const recap = screen.getByRole("button", { name: /Previous segment recap/ });
    const system = screen.getByRole("button", { name: /System prompt/ });

    await user.click(recap);
    const previous = screen.getByText("😀 Qoder反代项目推荐");
    expect(previous).toBeVisible();
    expect(previous.closest("[data-pixie-recap-entry]")).toHaveTextContent("10-19 12:47 · 65 条");
    expect(screen.getByText(/改好了，没走浏览器。/)).toBeVisible();

    await user.click(rules);
    expect(screen.getByText(/本段开始时间/)).toBeVisible();

    await user.click(system);
    // 两次 system 落盘是小节增量：合并后只剩一份"当前生效"的提示词。
    const pres = document.querySelectorAll("[data-transcript-preamble] pre");
    const raw = pres[pres.length - 1]?.textContent ?? "";
    expect(raw).toContain('"tools": "new tools"');
    expect(raw).toContain('"preamble": "You are pi"');
  });
});
