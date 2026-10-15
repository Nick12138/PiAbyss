/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, SessionSnapshot, WorkspaceSnapshot } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import type { ExtensionUiRequestState } from "../../lib/stores/extension-ui-state";
import { ExtensionUiModal } from "./ExtensionUiModal";
import { InlineExtensionUiRequest } from "./InlineExtensionUiRequest";

/**
 * Regression: answering a questionnaire question whose respond RPC is still in
 * flight, while a session switch demotes that request into the queue, used to
 * leave the settled request queued. The next question's close then promoted it
 * back — the questionnaire card "rewound" to an already-answered question and
 * the answer typed for the later question was lost.
 */

const QUESTIONNAIRE_SESSION = "33333333-3333-4333-8333-333333333333";
const OTHER_SESSION = "77777777-7777-4777-8777-777777777777";
const HOST_INSTANCE = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

const CONTEXT = {
  expectedHostInstanceId: HOST_INSTANCE,
  expectedWorkspaceId: WORKSPACE_ID,
  expectedWorkspaceRevision: 1,
  expectedSessionId: QUESTIONNAIRE_SESSION,
  expectedSessionRevision: 1,
};

function sessionSnapshot(sessionId: string, revision: number): SessionSnapshot {
  return {
    sessionId,
    cwd: "/workspace",
    revision,
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
    messages: [{ role: "user", content: "Existing conversation" }],
    tools: {
      revision: 1,
      workspaceId: WORKSPACE_ID,
      sessionId,
      sessionRevision: revision,
      tools: [],
      active: [],
    },
  } as SessionSnapshot;
}

function hostSnapshot(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_INSTANCE,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: QUESTIONNAIRE_SESSION,
    sessionRevision: 1,
    packageRevision: 0,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  } as HostStatusSnapshot;
}

function workspaceSnapshot(): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: 1,
    servicesReady: true,
  } as WorkspaceSnapshot;
}

function embeddedQuestionRequest(
  requestId: string,
  title: string,
  overrides: Partial<ExtensionUiRequestState> = {},
): ExtensionUiRequestState {
  return {
    requestId,
    presentation: "inline",
    kind: "select",
    title,
    context: CONTEXT,
    allowFreeform: true,
    origin: {
      invocationKind: "tool",
      extensionId: "piabyss",
      extensionDisplayName: "PiAbyss",
      sourceKind: "synthetic",
      toolName: "ask_user_question",
      toolCallId: "tool-call-embedded",
    },
    options: [
      { id: "keep", label: "Keep" },
      { id: "drop", label: "Drop" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  useAppStore.setState({
    host: hostSnapshot(),
    workspace: workspaceSnapshot(),
    session: sessionSnapshot(QUESTIONNAIRE_SESSION, 1),
    extensionUiRequest: null,
    extensionUiQueue: [],
    extensionDecisionGroups: {},
    notifications: [],
    sessionCatalog: {
      workspaceId: WORKSPACE_ID,
      entries: {},
      revision: 0,
      tree: [],
    } as unknown as never,
    sessionTerminalStates: {},
  });
  useAppStore.getState().setDesktopSettings({
    theme: "system",
    language: "en",
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "auto",
    terminalProfile: "auto",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  useAppStore.getState().setDesktopSettings(null);
});

it("does not resurrect an answered request that a session switch demoted to the queue", async () => {
  let resolveRespond: ((value: { ok: boolean; result: unknown }) => void) | undefined;
  const hostRequest = vi.spyOn(hostClient, "request").mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveRespond = resolve;
      }) as never,
  );

  // Question 1 of the questionnaire becomes the active request.
  const question1 = embeddedQuestionRequest(
    "44444444-4444-4444-8444-444444444441",
    "First question?",
    { questionIndex: 1, questionCount: 3 },
  );
  act(() => {
    useAppStore.getState().setExtensionUiRequest(question1);
  });
  const user = userEvent.setup();
  render(
    <>
      <InlineExtensionUiRequest />
      <ExtensionUiModal />
    </>,
  );

  // The user answers it; the respond RPC is still in flight…
  await user.type(screen.getByLabelText("Custom response"), "my first answer");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(hostRequest).toHaveBeenCalledOnce());

  // …when they switch to another session: the request is demoted into the queue
  // while the host is already settling it.
  act(() => {
    useAppStore.getState().applySessionSnapshot(sessionSnapshot(OTHER_SESSION, 1));
  });
  expect(useAppStore.getState().extensionUiRequest).toBeNull();
  expect(useAppStore.getState().extensionUiQueue.map((request) => request.requestId)).toEqual([
    question1.requestId,
  ]);

  // The respond RPC now succeeds host-side.
  await act(async () => {
    resolveRespond?.({ ok: true, result: null });
    await Promise.resolve();
  });

  // The settled request must not linger in the queue: the next close of the
  // same session's requests would otherwise promote it back on screen.
  expect(
    useAppStore
      .getState()
      .extensionUiQueue.some((request) => request.requestId === question1.requestId),
  ).toBe(false);

  // Question 2 arrives and is answered; closing it must not rewind to Q1.
  const question2 = embeddedQuestionRequest(
    "44444444-4444-4444-8444-444444444442",
    "Second question?",
    {
      questionIndex: 2,
      questionCount: 3,
      kind: "input",
      multiSelect: true,
      options: [
        { id: "Alpha", label: "Alpha" },
        { id: "Beta", label: "Beta" },
      ],
    },
  );
  act(() => {
    useAppStore.getState().setExtensionUiRequest(question2);
  });
  act(() => {
    useAppStore.getState().applySessionSnapshot(sessionSnapshot(QUESTIONNAIRE_SESSION, 1));
  });
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(hostRequest).toHaveBeenCalledTimes(2));
  await act(async () => {
    resolveRespond?.({ ok: true, result: null });
    await Promise.resolve();
  });

  const state = useAppStore.getState();
  expect(state.extensionUiRequest?.requestId).not.toBe(question1.requestId);
  expect(state.extensionUiQueue.some((request) => request.requestId === question1.requestId)).toBe(
    false,
  );
});
