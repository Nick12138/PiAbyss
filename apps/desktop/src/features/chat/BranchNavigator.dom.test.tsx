/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  SerializableAgentMessage,
  SerializableSessionTreeNode,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore } from "../../lib/stores/app-store";
import { subscribeTranscriptScroll } from "../../lib/transcript-navigation";
import { __resetSessionTreeForTest, useSessionTreeSync } from "../tree/tree-data";
import { Transcript } from "./Transcript";

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

// The main branch is active; `u3` is the abandoned sibling of `u2`.
const TREE: SerializableSessionTreeNode[] = [
  {
    entry: { id: "u1", type: "message", message: { role: "user", content: "first ask" } },
    children: [
      {
        entry: {
          id: "a1",
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "the answer" }] },
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
                  id: "a2",
                  type: "message",
                  message: { role: "assistant", content: [{ type: "text", text: "main reply" }] },
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
];

function messages(): SerializableAgentMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "first ask" }], id: "u1" },
    { role: "assistant", content: [{ type: "text", text: "the answer" }], id: "a1" },
    { role: "user", content: [{ type: "text", text: "trunk follow-up" }], id: "u2" },
    { role: "assistant", content: [{ type: "text", text: "main reply" }], id: "a2" },
  ] as SerializableAgentMessage[];
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
    messages: messages(),
    entries: [
      {
        id: "u1",
        parentId: null,
        type: "message",
        message: { role: "user", content: "first ask" },
      },
      {
        id: "a1",
        parentId: "u1",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "the answer" }] },
      },
      {
        id: "u2",
        parentId: "a1",
        type: "message",
        message: { role: "user", content: "trunk follow-up" },
      },
      {
        id: "a2",
        parentId: "u2",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "main reply" }] },
      },
    ] as never,
    leafId: "a2",
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

/** The transcript needs the shared tree store; sync is mounted beside it. */
function Harness() {
  useSessionTreeSync();
  return <Transcript />;
}

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("inline branch navigation", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    __resetSessionTreeForTest();
    useAppStore.setState({ desktopSettings: { language: "en" } as never });
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().clearNotifications();
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useAppStore.getState().applySessionSnapshot(null);
  });

  it("renders ‹ 1/2 › on the row whose siblings exist and nothing on linear rows", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("session.getTree", { tree: TREE, leafId: "a2" }) as never,
    );
    render(<Harness />);

    // u2 (trunk follow-up) and u3 are siblings; u2 is active → 1/2.
    const navigator = await screen.findByText("1/2");
    expect(navigator).toBeInTheDocument();
    const row = navigator.closest("[data-row-key]")!;
    expect(row.textContent).toContain("trunk follow-up");
    // Only one branch point exists in this tree.
    expect(screen.getAllByText("1/2")).toHaveLength(1);
  });

  it("switches to the sibling branch by rewiring the session leaf", async () => {
    const request = vi.spyOn(hostClient, "request").mockImplementation(async (method) => {
      if (method === "session.getTree") {
        return envelope("session.getTree", { tree: TREE, leafId: "a2" }) as never;
      }
      return envelope("agent.navigateTree", {
        session: session({ leafId: "u3", revision: 4 }),
        cancelled: false,
      }) as never;
    });
    const user = userEvent.setup();
    render(<Harness />);

    await screen.findByText("1/2");
    await user.click(screen.getByRole("button", { name: "Next branch" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "agent.navigateTree",
        {
          expectedHostInstanceId: HOST_ID,
          expectedWorkspaceId: WORKSPACE_ID,
          expectedWorkspaceRevision: 1,
          expectedSessionId: SESSION_ID,
          expectedSessionRevision: 3,
        },
        { targetId: "u3" },
      ),
    );
    expect(useAppStore.getState().sessionTreeNavigated).toBe(true);
  });

  it("scrolls instead of rewiring when the alternative is already rendered", async () => {
    const request = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue(envelope("session.getTree", { tree: TREE, leafId: "a2" }) as never);
    const seen: string[] = [];
    const unsubscribe = subscribeTranscriptScroll((navRequest) => {
      if (navRequest.sourceId) seen.push(navRequest.sourceId);
      return false;
    });
    const user = userEvent.setup();
    render(<Harness />);

    await screen.findByText("1/2");
    // The previous alternative is the row itself; wire the scroll bus to
    // observe the request and let it decline so navigation proceeds.
    await user.click(screen.getByRole("button", { name: "Next branch" }));

    await waitFor(() => expect(seen).toContain("u3"));
    expect(request).not.toHaveBeenCalledWith("agent.navigateTree", expect.anything());
    unsubscribe();
  });

  it("disables the navigator while the agent is busy", async () => {
    useAppStore.getState().applySessionSnapshot(session({ isIdle: false, isStreaming: true }));
    vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("session.getTree", { tree: TREE, leafId: "a2" }) as never,
    );
    render(<Harness />);

    await screen.findByText("1/2");
    expect(screen.getByRole("button", { name: "Previous branch" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next branch" })).toBeDisabled();
  });
});
