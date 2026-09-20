/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, SessionSnapshot, WorkspaceSnapshot } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { buildInjectedReferenceEnvelope } from "./injected-references";
import { Composer } from "./Composer";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
/** New-conversation draft key for the fixture workspace (see draftKeyForTarget). */
const DRAFT_KEY = "new:/workspace";

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    sdkVersion: "test",
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

function session(): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    cwd: "/workspace",
    revision: 3,
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
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sessionRevision: 3,
      tools: [],
      active: [],
    },
  };
}

const memoPayload = buildInjectedReferenceEnvelope({
  kind: "memo",
  title: "修复登录按钮",
  body: [
    '<piabyss-memo id="note-1" type="memo" status="open">',
    "# 修复登录按钮",
    "",
    "点击没反应。",
    "</piabyss-memo>",
    "",
    "请处理上面引用的备忘录记录。",
  ].join("\n"),
});

describe("Composer injected references", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
    useAppStore.setState({
      draftTexts: {},
      draftReferences: {
        [DRAFT_KEY]: [
          { id: "memo:note-1", kind: "memo", label: "修复登录按钮", payload: memoPayload },
        ],
      },
      draftTargets: {},
      draftEditVersions: {},
      draftHydratedWorkspace: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders the reference as an @ chip instead of the raw prompt", () => {
    render(<Composer />);
    expect(screen.getByText("@Memo · 修复登录按钮")).toBeVisible();
    expect(screen.queryByText(/piabyss-memo id/)).toBeNull();
    expect(screen.queryByText(/请处理上面引用的备忘录记录/)).toBeNull();
  });

  it("sends the expanded payload with the user's text and clears the chip", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "agent.prompt") return { ok: true, result: { accepted: true } } as never;
      return { ok: true, result: null } as never;
    });
    const user = userEvent.setup();
    render(<Composer />);
    await user.type(screen.getByRole("textbox"), "先看登录页");

    const send = screen.getByRole("button", { name: "Send" });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);

    const prompt = request.mock.calls.find(([method]) => method === "agent.prompt");
    expect(prompt?.[2]).toEqual({
      text: `${memoPayload}\n\n先看登录页`,
    });
    await waitFor(() => expect(screen.queryByText("@Memo · 修复登录按钮")).toBeNull());
    expect(useAppStore.getState().draftReferences[DRAFT_KEY]).toBeUndefined();
  });

  it("can send a reference on its own", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "agent.prompt") return { ok: true, result: { accepted: true } } as never;
      return { ok: true, result: null } as never;
    });
    const user = userEvent.setup();
    render(<Composer />);

    const send = screen.getByRole("button", { name: "Send" });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    expect(request.mock.calls.find(([method]) => method === "agent.prompt")?.[2]).toEqual({
      text: memoPayload,
    });
  });

  it("lets the user drop the reference before sending", async () => {
    const user = userEvent.setup();
    render(<Composer />);

    await user.click(screen.getByRole("button", { name: "Remove reference “修复登录按钮”" }));
    expect(screen.queryByText("@Memo · 修复登录按钮")).toBeNull();
    expect(useAppStore.getState().draftReferences[DRAFT_KEY]).toBeUndefined();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});
