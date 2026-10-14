/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStatusSnapshot, SessionSnapshot, WorkspaceSnapshot } from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import type { ExtensionUiRequestState } from "../../lib/stores/extension-ui-state";
import { AssistantOrderedContent, ExtensionMessageRow } from "./Transcript";
import { Composer } from "./Composer";
import { ExtensionUiModal } from "./ExtensionUiModal";
import { InlineExtensionUiRequest } from "./InlineExtensionUiRequest";
import type { TranscriptRow } from "./transcript-model";

const CONTEXT = {
  expectedHostInstanceId: "11111111-1111-4111-8111-111111111111",
  expectedWorkspaceId: "22222222-2222-4222-8222-222222222222",
  expectedWorkspaceRevision: 1,
  expectedSessionId: "33333333-3333-4333-8333-333333333333",
  expectedSessionRevision: 1,
};

function hostSnapshot(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: CONTEXT.expectedHostInstanceId,
    workspaceId: CONTEXT.expectedWorkspaceId,
    workspaceRevision: CONTEXT.expectedWorkspaceRevision,
    sessionId: CONTEXT.expectedSessionId,
    sessionRevision: CONTEXT.expectedSessionRevision,
    packageRevision: 0,
    sdkVersion: "0.82.1",
    nodeVersion: process.version,
    agentDir: "/agent",
    phase: "ready",
    capabilities: {
      packageUpdateCheck: true,
      extensionUi: true,
      sessionExport: true,
    },
    modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
  };
}

function workspaceSnapshot(): WorkspaceSnapshot {
  return {
    id: CONTEXT.expectedWorkspaceId,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: CONTEXT.expectedWorkspaceRevision,
    servicesReady: true,
  };
}

function sessionSnapshot(): SessionSnapshot {
  return {
    sessionId: CONTEXT.expectedSessionId,
    cwd: "/workspace",
    revision: CONTEXT.expectedSessionRevision,
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
      workspaceId: CONTEXT.expectedWorkspaceId,
      sessionId: CONTEXT.expectedSessionId,
      sessionRevision: CONTEXT.expectedSessionRevision,
      tools: [],
      active: [],
    },
  };
}

let requestSequence = 0;

function setLanguage(language: "en" | "zh") {
  useAppStore.getState().setDesktopSettings({
    theme: "system",
    language,
    autoRestartHostOnce: true,
    extensionDecisionPresentation: "legacy-modal",
    terminalProfile: "auto",
  });
}

function extensionRequest(
  overrides: Partial<ExtensionUiRequestState> = {},
): ExtensionUiRequestState {
  requestSequence += 1;
  return {
    requestId: `44444444-4444-4444-8444-${String(requestSequence).padStart(12, "0")}`,
    kind: "confirm",
    title: "Choose how to continue",
    context: CONTEXT,
    ...overrides,
  };
}

/** The built-in questionnaire the desktop always embeds, even when a Host says modal. */
function embeddedQuestionRequest(
  overrides: Partial<ExtensionUiRequestState> = {},
): ExtensionUiRequestState {
  return extensionRequest({
    presentation: "modal",
    origin: {
      invocationKind: "tool",
      extensionId: "piabyss",
      extensionDisplayName: "PiAbyss",
      sourceKind: "synthetic",
      toolName: "ask_user_question",
      toolCallId: "tool-call-embedded",
    },
    ...overrides,
  });
}

function renderRequestSurfaces() {
  return render(
    <>
      <InlineExtensionUiRequest />
      <ExtensionUiModal />
    </>,
  );
}

describe("Extension presentation surfaces", () => {
  beforeEach(() => {
    requestSequence = 0;
    setLanguage("en");
    useAppStore.setState({
      host: null,
      workspace: null,
      session: null,
      draftTexts: {},
      draftTargets: {},
      draftEditVersions: {},
      draftHydratedWorkspace: null,
      extensionUiRequest: null,
      extensionUiQueue: [],
      extensionDecisionGroups: {},
      notifications: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
    useAppStore.getState().setDesktopSettings(null);
  });

  it("opens raw agent protocol from the Agent coordination title row", async () => {
    const user = userEvent.setup();
    const rawProtocol = "Reply with: internal_tool({ action: 'respond' })";
    const row: TranscriptRow = {
      key: "custom:1",
      role: "custom",
      blocks: [{ kind: "text", text: rawProtocol }],
      copyText: rawProtocol,
      customType: "subagent_supervisor_request",
      details: { id: "request-1" },
      extensionPresentation: {
        version: 1,
        extensionId: "pi-subagents",
        sourceLabel: "Subagents",
        audience: "agent",
        kind: "activity",
        correlationId: "request-1",
      },
    };

    render(<ExtensionMessageRow row={row} />);

    const disclosure = screen.getByRole("button", { name: /Agent coordination/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Technical details")).not.toBeInTheDocument();
    expect(screen.queryByText(rawProtocol)).not.toBeInTheDocument();
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(rawProtocol)).toBeVisible();
  });

  it("collects Extension activity inside the execution checklist", async () => {
    const user = userEvent.setup();
    const row: TranscriptRow = {
      key: "custom:trace",
      role: "custom",
      blocks: [{ kind: "text", text: "Internal extension payload" }],
      copyText: "Internal extension payload",
      customType: "subagent_supervisor_request",
      extensionPresentation: {
        version: 1,
        extensionId: "pi-subagents",
        sourceLabel: "Subagents",
        audience: "agent",
        kind: "activity",
        correlationId: "trace-request",
      },
    };

    render(
      <AssistantOrderedContent
        blocks={[
          { kind: "tool", tool: { id: "read-1", name: "read", status: "done" } },
          { kind: "extension", row },
        ]}
        mode="static"
        showCaret={false}
        turnActive={false}
      />,
    );

    const trace = screen.getByRole("button", { name: "2 actions completed" });
    expect(screen.queryByRole("button", { name: /Agent coordination/ })).not.toBeInTheDocument();
    await user.click(trace);
    expect(screen.getByRole("button", { name: /Agent coordination/ })).toBeVisible();
  });

  it("localizes the nested checklist and keeps agent diagnostics behind the second disclosure", async () => {
    setLanguage("zh");
    const user = userEvent.setup();
    const rawProtocol = "Reply with the internal result";
    const agentRow: TranscriptRow = {
      key: "custom:agent-failure",
      role: "custom",
      blocks: [{ kind: "text", text: rawProtocol }],
      copyText: rawProtocol,
      customType: "subagent_supervisor_request",
      details: { id: "request-failed" },
      extensionPresentation: {
        version: 1,
        extensionId: "pi-subagents",
        sourceLabel: "Subagents",
        audience: "agent",
        kind: "activity",
        correlationId: "request-failed",
        status: "failed",
      },
    };
    const fallbackRow: TranscriptRow = {
      key: "custom:unknown-extension",
      role: "custom",
      blocks: [{ kind: "text", text: "Unknown extension payload" }],
      copyText: "Unknown extension payload",
      customType: "unknown-extension",
    };

    render(
      <AssistantOrderedContent
        blocks={[
          { kind: "extension", row: agentRow },
          { kind: "extension", row: fallbackRow },
        ]}
        mode="static"
        showCaret={false}
        turnActive={false}
      />,
    );

    const trace = screen.getByRole("button", { name: "🎉 完成 2 个，💥 搞砸 1 个" });
    expect(screen.queryByRole("button", { name: /Agent 协作/ })).not.toBeInTheDocument();
    trace.focus();
    await user.keyboard("{Enter}");

    const agentDisclosure = screen.getByRole("button", { name: /Agent 协作/ });
    expect(screen.getByRole("button", { name: "扩展消息" })).toBeVisible();
    expect(screen.queryByText("Subagents")).not.toBeInTheDocument();
    expect(screen.queryByText(rawProtocol)).not.toBeInTheDocument();

    await user.click(agentDisclosure);

    expect(agentDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("原始消息")).toBeVisible();
    expect(screen.getByText("元数据")).toBeVisible();
    expect(screen.getByText(rawProtocol)).toBeVisible();
  });

  it("renders exactly one surface and keeps legacy requests modal", async () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(extensionRequest({ presentation: "inline" }));
    });
    renderRequestSurfaces();

    expect(screen.getByRole("region", { name: "Choose how to continue" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      useAppStore.setState({
        extensionUiRequest: extensionRequest({ title: "Legacy modal request" }),
        extensionUiQueue: [],
      });
    });

    expect(await screen.findByRole("dialog", { name: "Legacy modal request" })).toBeVisible();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("embeds the built-in ask_user_question request even when an older Host labels it modal", () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "modal",
          origin: {
            invocationKind: "tool",
            extensionId: "piabyss",
            extensionDisplayName: "PiAbyss",
            sourceKind: "synthetic",
            toolName: "ask_user_question",
            toolCallId: "tool-call-1",
          },
        }),
      );
    });
    renderRequestSurfaces();

    expect(screen.getByRole("region", { name: "Choose how to continue" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("prefers Host-trusted Extension origin over an untrusted source hint", () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          sourceLabel: "Untrusted label",
          origin: {
            invocationKind: "tool",
            extensionId: "ext_0123456789abcdef01234567",
            extensionDisplayName: "Trusted review",
            sourceKind: "package",
            toolName: "review_changes",
            toolCallId: "tool-call-1",
          },
        }),
      );
    });
    renderRequestSurfaces();

    expect(screen.getByText("Trusted review")).toHaveAttribute(
      "title",
      "Trusted review · review_changes",
    );
    expect(screen.queryByText("Untrusted label")).not.toBeInTheDocument();
  });

  it("shows a local failure and lets the same action retry", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockResolvedValueOnce({
        ok: false,
        error: { message: "Host temporarily unavailable" },
      } as never)
      .mockResolvedValueOnce({ ok: true, result: null } as never);
    act(() => {
      useAppStore.getState().setExtensionUiRequest(extensionRequest({ presentation: "inline" }));
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Host temporarily unavailable");
    expect(useAppStore.getState().extensionUiRequest).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.queryByRole("region")).not.toBeInTheDocument());
    expect(hostRequest).toHaveBeenCalledTimes(2);
    expect(hostRequest).toHaveBeenLastCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "resolved", value: true }),
    );
  });

  it("disables duplicate actions while a response is in flight", async () => {
    let resolveResponse: ((value: unknown) => void) | undefined;
    const hostRequest = vi.spyOn(hostClient, "request").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }) as never,
    );
    act(() => {
      useAppStore.getState().setExtensionUiRequest(extensionRequest({ presentation: "inline" }));
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(hostRequest).toHaveBeenCalledOnce();

    await act(async () => {
      resolveResponse?.({ ok: true, result: null });
      await Promise.resolve();
    });
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("keeps select progress on the option that is being submitted", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockImplementation(() => new Promise(() => {}) as never);
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          options: [
            {
              id: "apply",
              label: "Apply the recommendation",
              description: "Use shared semantics.",
            },
            { id: "later", label: "Decide later" },
          ],
          allowFreeform: true,
        }),
      );
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    const option = screen.getByRole("button", {
      name: "Apply the recommendation. Use shared semantics.",
    });
    // First click only selects — a stray click must not commit an answer.
    await user.click(option);
    expect(option).toHaveAttribute("data-option-selected", "true");
    expect(hostRequest).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(option).toBeDisabled();
    expect(option).toHaveTextContent("Submitting…");
    expect(screen.getByRole("status")).toHaveTextContent("Submitting…");
    // One action button only: it carries the in-flight state for every source.
    expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
  });

  it("filters a virtualized large option list and submits the original option ID", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue({ ok: true, result: null } as never);
    const options = Array.from({ length: 150 }, (_, index) => ({
      id: `value-${index}`,
      label: `Option ${index}`,
      description: `Description ${index}`,
    }));
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          options,
        }),
      );
    });
    const user = userEvent.setup();
    const view = renderRequestSurfaces();

    expect(view.container.querySelector('[data-extension-option-list="virtualized"]')).toBeTruthy();
    const search = screen.getByRole("searchbox", { name: "Search options" });
    await user.type(search, "Option 149");
    expect(screen.getByRole("button", { name: "Option 149. Description 149" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Option 14. Description 14" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Option 149. Description 149" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(hostRequest).toHaveBeenCalledOnce());
    expect(hostRequest).toHaveBeenCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "resolved", value: "value-149" }),
    );
  });

  it("shows a recoverable empty state when no option matches", async () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          options: Array.from({ length: 12 }, (_, index) => ({
            id: `value-${index}`,
            label: `Option ${index}`,
          })),
        }),
      );
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    await user.type(screen.getByRole("searchbox", { name: "Search options" }), "missing");
    expect(screen.getByRole("status")).toHaveTextContent(
      "No matching options. Try another search.",
    );
    await user.click(screen.getByRole("button", { name: "Clear option search" }));
    expect(screen.getByRole("button", { name: "Option 0" })).toBeVisible();
  });

  it("absorbs the extension's freeform sentinel row into the card's own input", () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          allowFreeform: true,
          options: [
            { id: "keep", label: "Keep" },
            { id: "Type something.", label: "Type something." },
          ],
        }),
      );
    });
    renderRequestSurfaces();

    expect(screen.getByRole("button", { name: "Keep" })).toBeVisible();
    // One free-text entry point only: the row is not offered as a choice.
    expect(screen.queryByRole("button", { name: "Type something." })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Or answer this question in your own words…")).toBeVisible();
  });

  it("keeps the sentinel row when the host has no freeform input of its own", () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          options: [
            { id: "keep", label: "Keep" },
            { id: "Type something.", label: "Type something." },
          ],
        }),
      );
    });
    renderRequestSurfaces();

    expect(screen.getByRole("button", { name: "Type something." })).toBeVisible();
    expect(
      screen.queryByPlaceholderText("Or answer this question in your own words…"),
    ).not.toBeInTheDocument();
  });

  it("renders the extension's rewind row as a footer action", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue({ ok: true, result: null } as never);
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          options: [
            { id: "keep", label: "Keep" },
            { id: "↩ 修改上一题", label: "↩ 修改上一题" },
          ],
        }),
      );
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    // The rewind row is an action, not an answer — it never joins the options.
    expect(screen.queryByRole("button", { name: "↩ 修改上一题" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change previous answer" }));
    await waitFor(() => expect(hostRequest).toHaveBeenCalledOnce());
    expect(hostRequest).toHaveBeenCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "resolved", value: "↩ 修改上一题" }),
    );
  });

  it("shows the questionnaire ordinal, the header chip and the rewound preselect", () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          questionIndex: 2,
          questionCount: 3,
          questionHeader: "Layout",
          defaultValue: "keep",
          options: [
            { id: "keep", label: "Keep" },
            { id: "drop", label: "Drop" },
          ],
        }),
      );
    });
    renderRequestSurfaces();

    expect(screen.getByText("Question 2 of 3")).toBeVisible();
    expect(screen.getByText("Layout")).toBeVisible();
    // A rewind pre-selects the option rather than seeding the free-text box.
    expect(screen.getByRole("button", { name: "Keep" })).toHaveAttribute(
      "data-option-selected",
      "true",
    );
  });

  it("drops the extension's bracketed header from the title now that a chip exists", () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          title: "[Layout] Which shape?",
          questionHeader: "Layout",
          options: [{ id: "keep", label: "Keep" }],
        }),
      );
    });
    renderRequestSurfaces();

    expect(screen.getByRole("region", { name: "Which shape?" })).toBeVisible();
    expect(screen.getByText("Layout")).toBeVisible();
    expect(screen.queryByText("[Layout] Which shape?")).not.toBeInTheDocument();
  });

  it("renders a multi-select question as checkboxes and returns the chosen positions", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue({ ok: true, result: null } as never);
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "input",
          multiSelect: true,
          questionIndex: 3,
          questionCount: 3,
          title: "Which directions?",
          message: "1. Alpha — first\n2. Beta — second\n3. Gamma — third",
          allowFreeform: true,
          options: [
            { id: "Alpha", label: "Alpha", description: "first" },
            { id: "Beta", label: "Beta", description: "second" },
            { id: "Gamma", label: "Gamma", description: "third" },
          ],
        }),
      );
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    expect(screen.getByText("Multi-select")).toBeVisible();
    // The numbered list the extension sends for option-less hosts is replaced
    // by the checkbox list, so showing both would just duplicate it.
    expect(screen.queryByText(/1\. Alpha — first/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Alpha. first" }));
    await user.click(screen.getByRole("button", { name: "Gamma. third" }));
    // Last question of the questionnaire: the action commits the whole thing.
    await user.click(screen.getByRole("button", { name: "Confirm and send" }));
    await waitFor(() => expect(hostRequest).toHaveBeenCalledOnce());
    expect(hostRequest).toHaveBeenCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "resolved", value: "1,3" }),
    );
  });

  it("commits a typed answer through the single action button", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue({ ok: true, result: null } as never);
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          questionIndex: 1,
          questionCount: 2,
          allowFreeform: true,
          options: [{ id: "keep", label: "Keep" }],
        }),
      );
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    // The free-text box has no send button of its own; the action row commits it.
    expect(screen.queryByRole("button", { name: "Send response" })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Custom response"), "my own answer");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(hostRequest).toHaveBeenCalledOnce());
    expect(hostRequest).toHaveBeenCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "resolved", value: "my own answer" }),
    );
  });

  it("keeps a typed answer and a picked option mutually exclusive", async () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          allowFreeform: true,
          options: [
            { id: "keep", label: "Keep" },
            { id: "drop", label: "Drop" },
          ],
        }),
      );
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    await user.type(screen.getByLabelText("Custom response"), "typed");
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByRole("button", { name: "Keep" })).toHaveAttribute("aria-pressed", "true");
    // Picking a choice clears the typed answer, so only one can ever be sent.
    expect(screen.getByLabelText("Custom response")).toHaveValue("");

    await user.type(screen.getByLabelText("Custom response"), "typed again");
    expect(screen.getByRole("button", { name: "Keep" })).toHaveAttribute("aria-pressed", "false");
  });

  it("labels the last question's action as the final send", () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          questionIndex: 2,
          questionCount: 2,
          options: [{ id: "keep", label: "Keep" }],
        }),
      );
    });
    renderRequestSurfaces();

    expect(screen.getByRole("button", { name: "Confirm and send" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });

  it("offers the rewind action on questions that carry no rewind row", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue({ ok: true, result: null } as never);
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "input",
          multiSelect: true,
          questionIndex: 3,
          questionCount: 3,
          title: "Which directions?",
          options: [{ id: "Alpha", label: "Alpha" }],
        }),
      );
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    await user.click(screen.getByRole("button", { name: "Change previous answer" }));
    await waitFor(() => expect(hostRequest).toHaveBeenCalledOnce());
    expect(hostRequest).toHaveBeenCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "resolved", value: "↩ 修改上一题" }),
    );
  });

  it("keeps the rewind action off the first question", () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          questionIndex: 1,
          questionCount: 3,
          options: [{ id: "keep", label: "Keep" }],
        }),
      );
    });
    renderRequestSurfaces();

    expect(
      screen.queryByRole("button", { name: "Change previous answer" }),
    ).not.toBeInTheDocument();
  });

  it("omits the source row on the built-in questionnaire card", () => {
    act(() => {
      useAppStore
        .getState()
        .setExtensionUiRequest(
          embeddedQuestionRequest({ groupKey: "tool:ask-source", title: "Pick a mode" }),
        );
    });
    renderRequestSurfaces();

    expect(screen.getByRole("region", { name: "Pick a mode" })).toBeVisible();
    // The questionnaire always comes from the same plugin — repeating its name
    // on every question is noise, so the row is suppressed for this origin only.
    expect(screen.queryByText("PiAbyss")).not.toBeInTheDocument();
    expect(screen.queryByText("From")).not.toBeInTheDocument();
  });

  it("submits a labeled input from the keyboard", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue({ ok: true, result: null } as never);
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "input",
          title: "Provide a branch name",
        }),
      );
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    const input = screen.getByRole("textbox", { name: "Your response" });
    await user.type(input, "release-candidate{Enter}");

    await waitFor(() => expect(hostRequest).toHaveBeenCalledOnce());
    expect(hostRequest).toHaveBeenCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "resolved", value: "release-candidate" }),
    );
  });

  it("traps modal focus and lets Escape cancel", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({ ok: true, result: null } as never);
    act(() => {
      useAppStore.getState().setExtensionUiRequest(extensionRequest());
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(hostClient.request).toHaveBeenCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "cancelled" }),
    );
  });

  it("keeps focus in a submitting Modal and restores its opener after success", async () => {
    let resolveResponse: ((value: unknown) => void) | undefined;
    vi.spyOn(hostClient, "request").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }) as never,
    );
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Open decision</button>
        <ExtensionUiModal />
      </>,
    );
    const opener = screen.getByRole("button", { name: "Open decision" });
    opener.focus();
    act(() => {
      useAppStore.getState().setExtensionUiRequest(extensionRequest());
    });

    const confirm = await screen.findByRole("button", { name: "Confirm" });
    await user.click(confirm);

    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await user.tab();
    expect(dialog).toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog).toHaveFocus();

    await act(async () => {
      resolveResponse?.({ ok: true, result: null });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("expires the current request once and advances to the next live request", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const first = extensionRequest({
      presentation: "inline",
      title: "Expiring request",
      expiresAt: now + 100,
    });
    const next = extensionRequest({ title: "Next modal request" });
    act(() => {
      useAppStore.getState().setExtensionUiRequest(first);
      useAppStore.getState().setExtensionUiRequest(next);
    });
    renderRequestSurfaces();

    expect(screen.getByRole("region", { name: "Expiring request" })).toBeVisible();
    await act(async () => {
      vi.advanceTimersByTime(101);
      await Promise.resolve();
    });

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Next modal request" })).toBeVisible();
    expect(
      useAppStore
        .getState()
        .notifications.filter((item) => item.message === "Extension request expired"),
    ).toHaveLength(1);
  });

  it("keeps a built-in questionnaire group embedded while it waits for the next question", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({ ok: true, result: null } as never);
    useAppStore.setState({
      session: {
        sessionId: CONTEXT.expectedSessionId,
        revision: CONTEXT.expectedSessionRevision,
      } as never,
    });
    const groupKey = "tool:ask-user-question";
    const request = extensionRequest({
      groupKey,
      presentation: "modal",
      origin: {
        invocationKind: "tool",
        extensionId: "piabyss",
        extensionDisplayName: "PiAbyss",
        sourceKind: "synthetic",
        toolName: "ask_user_question",
        toolCallId: "tool-call-2",
      },
    });
    act(() => useAppStore.getState().setExtensionUiRequest(request));
    const user = userEvent.setup();
    renderRequestSurfaces();

    expect(screen.getByRole("region", { name: "Choose how to continue" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Waiting for the next question"),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("folds the embedded questionnaire into a summary row and restores it on demand", async () => {
    const groupKey = "tool:ask-user-question-fold";
    act(() => {
      useAppStore
        .getState()
        .setExtensionUiRequest(embeddedQuestionRequest({ groupKey, title: "Pick a mode" }));
    });
    const user = userEvent.setup();
    const view = renderRequestSurfaces();
    const card = view.container.querySelector(`[data-extension-ui-group="${groupKey}"]`);

    expect(screen.getByRole("button", { name: "Confirm" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Collapse question" }));

    expect(card).toHaveAttribute("data-extension-ui-collapsed", "true");
    expect(screen.getByRole("region", { name: "Pick a mode" })).toBeVisible();
    expect(screen.getByText("Awaiting answer")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const foldedRow = screen.getByRole("button", { name: /Pick a mode/ });
    expect(foldedRow).toHaveAttribute("aria-expanded", "false");
    await user.click(foldedRow);

    expect(card).not.toHaveAttribute("data-extension-ui-collapsed");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeVisible();
  });

  it("keeps the action row a sibling of the scroll region in one unbroken flex column", () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          groupKey: "tool:ask-flex-chain",
          kind: "input",
          multiSelect: true,
          questionIndex: 3,
          questionCount: 3,
          title: "Which directions?",
          allowFreeform: true,
          options: Array.from({ length: 8 }, (_, index) => ({
            id: `o-${index}`,
            label: `Option ${index}`,
          })),
        }),
      );
    });
    const view = renderRequestSurfaces();

    const scroller = view.container.querySelector<HTMLElement>("[data-extension-ui-scroll]");
    const primary = screen.getByRole("button", { name: "Confirm and send" });
    expect(scroller).not.toBeNull();
    // The regression this guards: the scroll region and the action row must sit
    // in the same flex column, with every ancestor allowed to shrink. A
    // `height: 100%` wrapper in the chain resolves to `auto` inside a
    // max-height-clamped flex column, the body then never overflows, and the
    // action row falls outside the card's `overflow-hidden`.
    expect(scroller!.parentElement?.contains(primary)).toBe(true);

    let node: HTMLElement | null = scroller;
    while (node && node.dataset.extensionUiGroup === undefined) {
      expect(node.className).not.toMatch(/\bh-(full|\[)/);
      if (node.classList.contains("flex")) expect(node.classList.contains("min-h-0")).toBe(true);
      node = node.parentElement;
    }
    expect(node).not.toBeNull();
  });

  it("shows the answered count at the bottom of the card, left-most", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({ ok: true, result: null } as never);
    useAppStore.setState({
      session: {
        sessionId: CONTEXT.expectedSessionId,
        revision: CONTEXT.expectedSessionRevision,
      } as never,
    });
    const groupKey = "tool:ask-answered-badge";
    const questionRequest = (questionIndex: number) =>
      extensionRequest({
        kind: "select",
        presentation: "inline",
        groupKey,
        questionIndex,
        questionCount: 2,
        options: [{ id: `o-${questionIndex}`, label: `Option ${questionIndex}` }],
      });
    act(() => useAppStore.getState().setExtensionUiRequest(questionRequest(1)));
    const user = userEvent.setup();
    const view = renderRequestSurfaces();

    await user.click(screen.getByRole("button", { name: "Option 1" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Waiting for the next question"),
    );

    // During the wait it sits on the waiting row, so the count never vanishes.
    const waitingBadge = screen.getByText("1 answered");
    expect(waitingBadge.closest('[role="button"]')).not.toBeNull();

    // Once the next question is up it moves into the action row at the very
    // bottom, as that row's left-most item — no strip above the question.
    act(() => useAppStore.getState().setExtensionUiRequest(questionRequest(2)));
    const actions = view.container.querySelector("[data-extension-ui-actions]");
    const badge = screen.getByText("1 answered");
    expect(actions?.contains(badge)).toBe(true);
    expect(actions?.firstElementChild?.contains(badge)).toBe(true);
  });

  it("keeps the custom answer scoped to its own question", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue({ ok: true, result: null } as never);
    useAppStore.setState({
      session: {
        sessionId: CONTEXT.expectedSessionId,
        revision: CONTEXT.expectedSessionRevision,
      } as never,
    });
    const groupKey = "tool:ask-custom-per-question";
    const questionRequest = (questionIndex: number) =>
      extensionRequest({
        kind: "select",
        presentation: "inline",
        groupKey,
        questionIndex,
        questionCount: 2,
        allowFreeform: true,
        options: [{ id: `o-${questionIndex}`, label: `Option ${questionIndex}` }],
      });
    act(() => useAppStore.getState().setExtensionUiRequest(questionRequest(1)));
    const user = userEvent.setup();
    renderRequestSurfaces();

    await user.type(screen.getByLabelText("Custom response"), "my own answer");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Waiting for the next question"),
    );
    expect(hostRequest).toHaveBeenCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "resolved", value: "my own answer" }),
    );

    act(() => useAppStore.getState().setExtensionUiRequest(questionRequest(2)));

    // The next question opens with an empty box and nothing selected: the typed
    // text was consumed by question 1 and must not follow the user along.
    expect(screen.getByLabelText("Custom response")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Option 2" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("needs an explicit click, not a bare Enter, to commit a questionnaire answer", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue({ ok: true, result: null } as never);
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          allowFreeform: true,
          options: [{ id: "keep", label: "Keep" }],
        }),
      );
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    await user.type(screen.getByLabelText("Custom response"), "draft answer");
    await user.keyboard("{Enter}");
    // Enter belongs to the textarea here — the action button is the commitment.
    expect(hostRequest).not.toHaveBeenCalled();

    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(hostRequest).toHaveBeenCalledOnce());
    expect(hostRequest).toHaveBeenCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "resolved", value: "draft answer" }),
    );
  });

  it("does not seed a multi-select rewind's positions into the custom answer box", () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "input",
          multiSelect: true,
          questionIndex: 2,
          questionCount: 2,
          defaultValue: "1,3",
          allowFreeform: true,
          options: [
            { id: "Alpha", label: "Alpha", description: "first" },
            { id: "Beta", label: "Beta" },
            { id: "Gamma", label: "Gamma" },
          ],
        }),
      );
    });
    renderRequestSurfaces();

    // The rewind's answer belongs to the checkboxes, never to the text field.
    expect(screen.getByLabelText("Custom response")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Alpha. first" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Gamma" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Beta" })).toHaveAttribute("aria-pressed", "false");
  });

  it("folds from the whole header rather than only a corner chevron", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({ ok: true, result: null } as never);
    useAppStore.setState({
      session: {
        sessionId: CONTEXT.expectedSessionId,
        revision: CONTEXT.expectedSessionRevision,
      } as never,
    });
    const groupKey = "tool:ask-user-question-header-fold";
    act(() => {
      useAppStore
        .getState()
        .setExtensionUiRequest(embeddedQuestionRequest({ groupKey, title: "Pick a mode" }));
    });
    const user = userEvent.setup();
    const view = renderRequestSurfaces();
    const card = view.container.querySelector(`[data-extension-ui-group="${groupKey}"]`);

    // Exactly one control, and it is the header itself.
    const toggle = screen.getByRole("button", { name: "Collapse question" });
    expect(toggle).toHaveAttribute("data-extension-ui-fold-toggle", "true");
    expect(toggle).toContainElement(screen.getByRole("heading", { name: "Pick a mode" }));
    await user.click(toggle);
    expect(card).toHaveAttribute("data-extension-ui-collapsed", "true");

    // …and it is reachable without a mouse.
    await user.click(screen.getByRole("button", { name: /Pick a mode/ }));
    screen.getByRole("button", { name: "Collapse question" }).focus();
    await user.keyboard("{Enter}");
    expect(card).toHaveAttribute("data-extension-ui-collapsed", "true");
  });

  it("keeps the folded questionnaire folded while the same group asks the next question", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({ ok: true, result: null } as never);
    useAppStore.setState({
      session: {
        sessionId: CONTEXT.expectedSessionId,
        revision: CONTEXT.expectedSessionRevision,
      } as never,
    });
    const groupKey = "tool:ask-user-question-refold";
    act(() => {
      useAppStore
        .getState()
        .setExtensionUiRequest(embeddedQuestionRequest({ groupKey, title: "Pick a mode" }));
    });
    const user = userEvent.setup();
    const view = renderRequestSurfaces();
    const card = view.container.querySelector(`[data-extension-ui-group="${groupKey}"]`);

    await user.click(screen.getByRole("button", { name: "Collapse question" }));
    await user.click(screen.getByRole("button", { name: /Pick a mode/ }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Waiting for the next question"),
    );

    await user.click(screen.getByRole("button", { name: "Collapse question" }));

    expect(card).toHaveAttribute("data-extension-ui-collapsed", "true");
    expect(screen.getByRole("button", { name: /Waiting for the next question/ })).toHaveTextContent(
      "1 answered",
    );

    act(() => {
      useAppStore
        .getState()
        .setExtensionUiRequest(embeddedQuestionRequest({ groupKey, title: "Pick a target" }));
    });

    expect(card).toHaveAttribute("data-extension-ui-collapsed", "true");
    expect(screen.getByRole("button", { name: /Pick a target/ })).toBeVisible();
    expect(screen.getByText("Awaiting answer")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
  });

  it("reopens a folded questionnaire when a different group asks", async () => {
    const first = embeddedQuestionRequest({
      groupKey: "tool:ask-user-question-first",
      title: "First questionnaire",
    });
    act(() => useAppStore.getState().setExtensionUiRequest(first));
    const user = userEvent.setup();
    const view = renderRequestSurfaces();

    await user.click(screen.getByRole("button", { name: "Collapse question" }));
    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();

    act(() => useAppStore.getState().closeExtensionUiRequest(first.requestId, "answered"));
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        embeddedQuestionRequest({
          groupKey: "tool:ask-user-question-second",
          title: "Second questionnaire",
        }),
      );
    });

    expect(screen.getByRole("region", { name: "Second questionnaire" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeVisible();
    expect(view.container.querySelectorAll("[data-extension-ui-collapsed]")).toHaveLength(0);
  });

  it("keeps the fold control on the embedded surface only", () => {
    act(() => {
      useAppStore.setState({
        extensionUiRequest: extensionRequest({ title: "Legacy modal request" }),
        extensionUiQueue: [],
      });
    });
    renderRequestSurfaces();

    expect(screen.getByRole("dialog", { name: "Legacy modal request" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Collapse question" })).not.toBeInTheDocument();
  });

  it("keeps one Inline group shell across sequential select and input requests", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({ ok: true, result: null } as never);
    useAppStore.setState({
      session: {
        sessionId: CONTEXT.expectedSessionId,
        revision: CONTEXT.expectedSessionRevision,
      } as never,
    });
    const groupKey = "tool:0123456789abcdef";
    const first = extensionRequest({
      kind: "select",
      title: "Choose a direction",
      options: [
        { id: "alpha", label: "Alpha" },
        { id: "beta", label: "Beta" },
      ],
      groupKey,
      presentation: "inline",
    });
    act(() => useAppStore.getState().setExtensionUiRequest(first));
    const user = userEvent.setup();
    const view = renderRequestSurfaces();

    expect(view.container.querySelector(`[data-extension-ui-group="${groupKey}"]`)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Alpha" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Waiting for the next question"),
    );

    const second = extensionRequest({
      kind: "input",
      title: "Add context",
      groupKey,
      presentation: "inline",
    });
    act(() => useAppStore.getState().setExtensionUiRequest(second));

    expect(screen.getByText("1 answered")).toBeVisible();
    expect(screen.getByRole("region", { name: "Add context" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(view.container.querySelectorAll("[data-extension-ui-surface]")).toHaveLength(1);
  });

  it("blocks Composer submission through group waiting and restores focus after group close", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue({ ok: true, result: null } as never);
    useAppStore.setState({
      host: hostSnapshot(),
      workspace: workspaceSnapshot(),
      session: sessionSnapshot(),
    });
    const groupKey = "tool:composer-block";
    const request = extensionRequest({
      groupKey,
      presentation: "inline",
    });
    act(() => useAppStore.getState().setExtensionUiRequest(request));
    const user = userEvent.setup();
    render(
      <>
        <InlineExtensionUiRequest />
        <Composer />
      </>,
    );

    const composer = screen.getByRole("textbox");
    await user.type(composer, "Keep this draft{Enter}");
    expect(composer).toHaveValue("Keep this draft");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Answer the Extension question above before sending a message.",
    );
    expect(hostRequest).not.toHaveBeenCalledWith(
      "agent.prompt",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.getByText("Waiting for the next question…")).toBeVisible());
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(composer).not.toHaveFocus();

    act(() => useAppStore.getState().closeExtensionDecisionGroup(groupKey, "completed"));
    await waitFor(() => expect(composer).toHaveFocus());
    expect(composer).toHaveValue("Keep this draft");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });
});

describe("registered Extension message renderer output", () => {
  afterEach(() => cleanup());

  it("shows compact output and expands only when the full rendering differs", async () => {
    const user = userEvent.setup();
    const row: TranscriptRow = {
      key: "custom:renderer",
      role: "custom",
      blocks: [{ kind: "text", text: "raw fallback" }],
      copyText: "raw fallback",
      customType: "subagent-slash-result",
      extensionMessageRender: {
        version: 1,
        collapsed: ["Subagents doctor report"],
        expanded: ["Subagents doctor report", "Runtime: ok"],
      },
    };

    render(<ExtensionMessageRow row={row} />);

    const name = screen.getByText("Subagents doctor report");
    expect(name).toBeVisible();
    expect(screen.queryByText(/raw fallback/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Runtime: ok/)).not.toBeInTheDocument();
    const disclosure = screen.getByRole("button", { name: /Subagents doctor report/ });
    expect(disclosure).toHaveAttribute("title", "Show full Extension output");
    await user.click(name);
    expect(screen.getByText(/Runtime: ok/)).toBeVisible();
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(disclosure).toHaveAttribute("title", "Show compact Extension output");

    await user.click(name);
    expect(screen.queryByText(/Runtime: ok/)).not.toBeInTheDocument();
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
  });
});
