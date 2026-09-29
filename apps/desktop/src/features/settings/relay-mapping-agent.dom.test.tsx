/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HostStatusSnapshot, RelayMappingHandoffResult } from "@piabyss/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { draftKeyForTarget, type DraftReference } from "../../lib/draft-target";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  activateWorkspaceAcrossWorkspaces: vi.fn(),
  createNewSession: vi.fn(),
  waitForWorkspaceServicesReady: vi.fn(),
  defaultProjectWorkspacePath: vi.fn(),
}));

vi.mock("../../lib/bridge/host-client", () => ({ hostClient: { request: mocks.request } }));
vi.mock("../../lib/bridge/session-navigation", () => ({
  activateWorkspaceAcrossWorkspaces: mocks.activateWorkspaceAcrossWorkspaces,
}));
vi.mock("../../lib/commands/actions", () => ({ createNewSession: mocks.createNewSession }));
vi.mock("../workspaces/workspace-switch-policy", () => ({
  waitForWorkspaceServicesReady: mocks.waitForWorkspaceServicesReady,
}));
vi.mock("../memo/memo-model", () => ({
  defaultProjectWorkspacePath: mocks.defaultProjectWorkspacePath,
}));

import { openRelayMappingAgent } from "./relay-mapping-agent";

const host: HostStatusSnapshot = {
  protocolVersion: 1,
  hostInstanceId: "host-1",
  workspaceId: "workspace-1",
  workspaceRevision: 1,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 1,
  sdkVersion: "0.82.1",
  nodeVersion: process.version,
  agentDir: "/agent",
  phase: "ready",
  capabilities: { packageUpdateCheck: true, extensionUi: true, sessionExport: true },
  modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
};

const defaultWorkspace = {
  id: "ws-default",
  cwd: "/agent/piabyss/DefaultProject",
  canonicalCwd: "/agent/piabyss/DefaultProject",
  revision: 1,
  servicesReady: true,
};

const handoffResult: RelayMappingHandoffResult = {
  stationId: "hetune",
  mappingPath: "/agent/piabyss/relay-pricing/mappings/hetune.json",
  baseUrl: "https://x.example",
  hasApiKey: true,
  authJsonPath: "/agent/auth.json",
  mapping: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.request.mockResolvedValue({ ok: true, result: handoffResult });
  mocks.defaultProjectWorkspacePath.mockReturnValue(defaultWorkspace.canonicalCwd);
  mocks.activateWorkspaceAcrossWorkspaces.mockResolvedValue({ status: "already-active" });
  mocks.waitForWorkspaceServicesReady.mockResolvedValue(true);
  mocks.createNewSession.mockImplementation(async () => {
    // createNewSession 会 applySessionSnapshot：新会话快照存在但消息为空。
    useAppStore.setState({
      workspace: defaultWorkspace,
      session: {
        sessionId: "s-new",
        revision: 1,
        messages: [],
        isIdle: true,
      },
    } as never);
    return true;
  });
  useAppStore.setState({
    host,
    workspace: defaultWorkspace,
    session: null,
    connecting: false,
    rehydrating: false,
    desynchronized: false,
    hostFatal: null,
    desktopSettings: null,
    draftReferences: {},
    draftTargets: {},
    draftEditVersions: {},
  } as never);
});

describe("openRelayMappingAgent", () => {
  it("injects the reference into the new-conversation draft key (not session:)", async () => {
    const ok = await openRelayMappingAgent("hetune", "河图");
    expect(ok).toBe(true);

    const state = useAppStore.getState();
    // 新会话消息为空 → 草稿键必须是 new:<cwd>；注错 session:<id> 键会导致胶囊不可见。
    const newKey = draftKeyForTarget({
      kind: "new-conversation",
      canonicalCwd: defaultWorkspace.canonicalCwd,
    });
    const refs: DraftReference[] = state.draftReferences[newKey] ?? [];
    expect(refs).toHaveLength(1);
    expect(refs[0]!.kind).toBe("relay-mapping");
    expect(refs[0]!.label).toBe("河图");
    expect(refs[0]!.payload).toContain("piabyss-relay-mapping");
    expect(state.draftReferences["session:s-new"]).toBeUndefined();
  });

  it("aborts when the host handoff request fails", async () => {
    mocks.request.mockResolvedValue({ ok: false, error: { code: "X", message: "nope" } });
    const ok = await openRelayMappingAgent("hetune", "河图");
    expect(ok).toBe(false);
    expect(mocks.createNewSession).not.toHaveBeenCalled();
  });
});
