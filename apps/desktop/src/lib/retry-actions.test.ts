import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostResponseEnvelope,
  HostStatusSnapshot,
  SessionSnapshot,
  WorkspaceSnapshot,
} from "@piabyss/protocol";
import { buildAttachmentReferenceBlock } from "@piabyss/protocol";
import { hostClient } from "./bridge/host-client";
import { useAppStore } from "./stores/app-store";
import { requestGoOn, requestRetry } from "./retry-actions";
import { buildAttachedFileBlock, type TranscriptRow } from "../features/chat/transcript-model";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_A = "33333333-3333-4333-8333-333333333333";

function host(): HostStatusSnapshot {
  return {
    protocolVersion: 1,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_A,
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
    sessionId: SESSION_A,
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
      sessionId: SESSION_A,
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
  expectedSessionId: SESSION_A,
  expectedSessionRevision: 3,
};

function envelope(method: string, body: { ok: true; result: unknown } | { ok: false }) {
  return {
    protocolVersion: 1,
    id: "test-request",
    method,
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 1,
    sessionId: SESSION_A,
    sessionRevision: 3,
    packageRevision: 1,
    ...body,
  } as HostResponseEnvelope;
}

function userRow(copyText: string, blocks: TranscriptRow["blocks"] = []): TranscriptRow {
  return { key: "user:0", role: "user", blocks, copyText };
}

function notifications() {
  return useAppStore.getState().notifications.map(({ message, level }) => ({ message, level }));
}

/** Info/success notifications are transient (toast only) and live in a
 *  separate channel — never in the persistent `notifications` history. */
function toasts() {
  return useAppStore.getState().transientNotifications.map(({ message, level }) => ({
    message,
    level,
  }));
}

describe("requestRetry", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().clearNotifications();
    useAppStore.getState().setAuthBlocked(null);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-sends the plain user text via agent.prompt", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("agent.prompt", { ok: true, result: { accepted: true, runId: "r1" } }) as never,
    );

    await expect(requestRetry(userRow("please review"))).resolves.toBe(true);

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "agent.prompt",
      EXPECTED_CONTEXT,
      { text: "please review" },
      null,
    );
    expect(useAppStore.getState().authBlocked).toBeNull();
  });

  it("rebuilds text attachments, documents, and images into the prompt", async () => {
    const documentBlock = buildAttachmentReferenceBlock([
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "manual.pdf",
        mediaType: "application/pdf",
        sizeBytes: 1024,
        status: "ready",
      },
    ]);
    const raw = [
      "please review",
      buildAttachedFileBlock("main.rs", "fn main() {}\n"),
      documentBlock,
    ].join("\n\n");
    const request = vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("agent.prompt", { ok: true, result: { accepted: true, runId: "r1" } }) as never,
    );

    await expect(
      requestRetry(
        userRow(raw, [
          { kind: "text", text: "please review" },
          { kind: "image", data: "BASE64", mimeType: "image/png" },
        ]),
      ),
    ).resolves.toBe(true);

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "agent.prompt",
      EXPECTED_CONTEXT,
      {
        text: `please review\n\n${buildAttachedFileBlock("main.rs", "fn main() {}")}`,
        images: [{ mediaType: "image/png", data: "BASE64" }],
        attachmentIds: ["11111111-1111-4111-8111-111111111111"],
      },
      null,
    );
  });

  it("surfaces AUTH_REQUIRED into the auth banner", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ...envelope("agent.prompt", { ok: false }),
      error: {
        code: "AUTH_REQUIRED",
        message: "No credentials",
        details: { providerId: "p1" },
      },
    } as never);

    await expect(requestRetry(userRow("please review"))).resolves.toBe(false);

    expect(useAppStore.getState().authBlocked).toEqual({ providerId: "p1" });
    expect(notifications()).toEqual([]);
  });

  it("refuses to retry while the agent is busy", async () => {
    useAppStore.getState().applySessionSnapshot(session({ isIdle: false }));
    const request = vi.spyOn(hostClient, "request");

    await expect(requestRetry(userRow("please review"))).resolves.toBe(false);

    expect(request).not.toHaveBeenCalled();
    expect(toasts()).toEqual([
      { message: "Wait for the agent to finish before retrying", level: "info" },
    ]);
  });
});

describe("requestGoOn", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(null);
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().clearNotifications();
    useAppStore.getState().setAuthBlocked(null);
    useAppStore.getState().setHost(host());
    useAppStore.getState().setWorkspace(workspace());
    useAppStore.getState().applySessionSnapshot(session());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a bare Continue prompt to the active session", async () => {
    const request = vi.spyOn(hostClient, "request").mockResolvedValue(
      envelope("agent.prompt", { ok: true, result: { accepted: true, runId: "r2" } }) as never,
    );

    await expect(requestGoOn()).resolves.toBe(true);

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "agent.prompt",
      EXPECTED_CONTEXT,
      { text: "Continue" },
      null,
    );
    expect(useAppStore.getState().authBlocked).toBeNull();
  });

  it("surfaces AUTH_REQUIRED into the auth banner", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({
      ...envelope("agent.prompt", { ok: false }),
      error: {
        code: "AUTH_REQUIRED",
        message: "No credentials",
        details: { providerId: "p2" },
      },
    } as never);

    await expect(requestGoOn()).resolves.toBe(false);

    expect(useAppStore.getState().authBlocked).toEqual({ providerId: "p2" });
    expect(notifications()).toEqual([]);
  });

  it("refuses to continue while the agent is busy", async () => {
    useAppStore.getState().applySessionSnapshot(session({ isIdle: false }));
    const request = vi.spyOn(hostClient, "request");

    await expect(requestGoOn()).resolves.toBe(false);

    expect(request).not.toHaveBeenCalled();
    expect(toasts()).toEqual([
      { message: "Wait for the agent to finish before retrying", level: "info" },
    ]);
  });
});
