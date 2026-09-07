/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  SerializableSessionTreeNode,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { __resetDraftPersistenceForTests } from "../../lib/draft-persistence";
import { subscribeTranscriptScroll } from "../../lib/transcript-navigation";
import { useAppStore } from "../../lib/stores/app-store";
import { TreePanel } from "./TreePanel";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
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

function workspace(): WorkspaceSnapshot {
  return {
    id: WORKSPACE_ID,
    cwd: "/workspace",
    canonicalCwd: "/workspace",
    revision: 1,
    servicesReady: true,
  };
}

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
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
    ...overrides,
  };
}

const EXPECTED_CONTEXT = {
  expectedHostInstanceId: HOST_ID,
  expectedWorkspaceId: WORKSPACE_ID,
  expectedWorkspaceRevision: 1,
  expectedSessionId: SESSION_ID,
  expectedSessionRevision: 3,
};

// u1 → mc1(model_change) → a1 → { u2 → tr1(toolResult, current leaf), u3 }
const TREE: SerializableSessionTreeNode[] = [
  {
    entry: { id: "u1", type: "message", message: { role: "user", content: "first ask" } },
    children: [
      {
        entry: { id: "mc1", type: "model_change" },
        children: [
          {
            entry: {
              id: "a1",
              type: "message",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "the answer" }],
              },
            },
            children: [
              {
                entry: {
                  id: "u2",
                  type: "message",
                  message: { role: "user", content: "trunk follow-up" },
                },
                children: [
                  {
                    entry: {
                      id: "tr1",
                      type: "message",
                      message: { role: "toolResult", content: "tool output" },
                    },
                    children: [],
                  },
                ],
              },
              {
                entry: {
                  id: "u3",
                  type: "message",
                  message: { role: "user", content: "abandoned attempt" },
                },
                children: [],
              },
            ],
          },
        ],
      },
    ],
  },
];

function envelope(method: string, result: unknown): HostResponseEnvelope {
  return {
    protocolVersion: 1,
    id: "test-request",
    method,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_ID,
    sessionRevision: 3,
    packageRevision: 1,
    ok: true,
    result,
  } as HostResponseEnvelope;
}

describe("TreePanel", () => {
  beforeEach(() => {
    useAppStore.setState({ desktopSettings: { language: "en" } as never });
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().clearNotifications();
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
    useAppStore.setState({
      draftTexts: {},
      draftTargets: {},
      draftEditVersions: {},
      draftHydratedWorkspace: null,
    });
  });

  afterEach(() => {
    __resetDraftPersistenceForTests();
    vi.restoreAllMocks();
    cleanup();
  });

  it("localizes the empty session state in Chinese", () => {
    useAppStore.setState({ desktopSettings: { language: "zh" } as never });
    useAppStore.getState().applySessionSnapshot(null);
    render(<TreePanel visible />);

    expect(screen.getByText("当前没有活动会话。")).toBeVisible();
  });

  it("loads the tree and navigates to an abandoned branch", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "session.getTree") {
        return envelope("session.getTree", { tree: TREE, leafId: "tr1" }) as never;
      }
      return envelope("agent.navigateTree", {
        session: session({ thinkingLevel: "high" }),
        cancelled: false,
        editorText: "abandoned attempt",
      }) as never;
    });
    const user = userEvent.setup();
    render(<TreePanel visible />);

    expect(await screen.findByText("abandoned attempt")).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith("session.getTree", EXPECTED_CONTEXT, null);

    // Non-conversation entries are collapsed out of the panel.
    expect(screen.queryByText("model_change")).not.toBeInTheDocument();
    expect(screen.queryByText("tool output")).not.toBeInTheDocument();

    // The actual leaf is a hidden tool result; the marker falls back to the
    // deepest visible row on its path.
    const current = screen.getByText("trunk follow-up").closest("button")!;
    expect(current).not.toBeDisabled();
    expect(current).toHaveAttribute("aria-current", "true");

    await user.click(screen.getByText("abandoned attempt").closest("button")!);

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("agent.navigateTree", EXPECTED_CONTEXT, {
        targetId: "u3",
      }),
    );
    await waitFor(() => expect(useAppStore.getState().session?.thinkingLevel).toBe("high"));
    expect(useAppStore.getState().sessionTreeNavigated).toBe(true);
  });

  it("scrolls the transcript to an on-path message instead of rewiring the session", async () => {
    const navigateSpy = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue(envelope("session.getTree", { tree: TREE, leafId: "tr1" }) as never);
    const seen: string[] = [];
    const unsubscribe = subscribeTranscriptScroll((request) => {
      if (request.sourceId) seen.push(request.sourceId);
      return true;
    });
    const user = userEvent.setup();
    render(<TreePanel visible />);

    await screen.findByText("abandoned attempt");
    await user.click(screen.getByText("the answer").closest("button")!);

    await waitFor(() => expect(seen).toContain("a1"));
    expect(navigateSpy).not.toHaveBeenCalledWith("agent.navigateTree", expect.anything());
    unsubscribe();
  });

  it("constrains tree message text so narrow panels can ellipsize it", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("session.getTree", { tree: TREE, leafId: "tr1" }) as never,
    );
    render(<TreePanel visible />);

    const message = await screen.findByText("the answer");
    const button = message.closest("button")!;

    expect(button).toHaveClass("min-w-0", "max-w-full", "overflow-hidden");
    expect(message).toHaveClass("min-w-0", "max-w-full", "overflow-hidden", "text-ellipsis");
  });

  it("adds five pixels of horizontal outer spacing to the current badge and fork button", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("session.getTree", { tree: TREE, leafId: "tr1" }) as never,
    );
    render(<TreePanel visible />);

    await screen.findByText("abandoned attempt");

    expect(screen.getByText("current")).toHaveClass("mx-[5px]");
    expect(screen.getByRole("button", { name: "Fork from: abandoned attempt" })).toHaveClass(
      "mx-[5px]",
    );
  });

  it("hides the fork action for the first user message", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("session.getTree", { tree: TREE, leafId: "tr1" }) as never,
    );
    render(<TreePanel visible />);

    await screen.findByText("first ask");

    expect(screen.queryByRole("button", { name: "Fork from: first ask" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Fork from: abandoned attempt" }),
    ).toBeInTheDocument();
  });

  it("disables navigation while the agent is busy", async () => {
    useAppStore.getState().applySessionSnapshot(session({ isIdle: false, isStreaming: true }));
    vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("session.getTree", { tree: TREE, leafId: "tr1" }) as never,
    );
    render(<TreePanel visible />);

    expect(await screen.findByText("abandoned attempt")).toBeInTheDocument();
    expect(screen.getByText("Agent is busy — navigation disabled")).toBeInTheDocument();
    expect(screen.getByText("abandoned attempt").closest("button")).toBeDisabled();
  });

  it("forks from a user row via the inline fork button", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "session.getTree") {
        return envelope("session.getTree", { tree: TREE, leafId: "tr1" }) as never;
      }
      return envelope("session.fork", {
        session: session(),
        selectedText: "abandoned attempt",
      }) as never;
    });
    const user = userEvent.setup();
    render(<TreePanel visible />);

    await screen.findByText("abandoned attempt");
    await user.click(screen.getByRole("button", { name: "Fork from: abandoned attempt" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "session.fork",
        EXPECTED_CONTEXT,
        { entryId: "u3" },
        expect.any(Number),
      ),
    );
  });

  it("shows tree load errors", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ...envelope("session.getTree", undefined),
      ok: false,
      result: undefined,
      error: { code: "HOST_NOT_READY", message: "Server not bound" },
    } as never);
    render(<TreePanel visible />);

    expect(await screen.findByText("Server not bound")).toBeInTheDocument();
  });
});
