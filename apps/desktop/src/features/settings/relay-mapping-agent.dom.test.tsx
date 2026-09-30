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

import { openRelayMappingAgents } from "./relay-mapping-agent";

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

function handoffFor(stationId: string): RelayMappingHandoffResult {
  return {
    stationId,
    mappingPath: `/agent/piabyss/relay-pricing/mappings/${stationId}.json`,
    baseUrl: `https://${stationId}.example`,
    hasApiKey: true,
    authJsonPath: "/agent/auth.json",
    mapping: null,
    sharedWith: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.request.mockImplementation(
    async (
      _ctx: unknown,
      _method: unknown,
      params: {
        stationId: string;
      },
    ) => ({ ok: true, result: handoffFor(params.stationId) }),
  );
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

describe("openRelayMappingAgents", () => {
  it("injects one reference per station into the new-conversation draft key", async () => {
    const ok = await openRelayMappingAgents([
      { stationId: "hetune", providerName: "河图" },
      { stationId: "example", providerName: "示例" },
    ]);
    expect(ok).toBe(true);

    const state = useAppStore.getState();
    // 新会话消息为空 → 草稿键必须是 new:<cwd>；注错 session:<id> 键会导致胶囊不可见。
    const newKey = draftKeyForTarget({
      kind: "new-conversation",
      canonicalCwd: defaultWorkspace.canonicalCwd,
    });
    const refs: DraftReference[] = state.draftReferences[newKey] ?? [];
    expect(refs).toHaveLength(2);
    expect(refs.map((reference) => reference.id)).toEqual([
      "relay-mapping:hetune",
      "relay-mapping:example",
    ]);
    expect(refs[0]!.kind).toBe("relay-mapping");
    expect(refs[0]!.label).toBe("河图");
    expect(refs[0]!.payload).toContain("piabyss-relay-mapping");
    expect(state.draftReferences["session:s-new"]).toBeUndefined();
  });

  it("aborts when every handoff request fails", async () => {
    mocks.request.mockResolvedValue({ ok: false, error: { code: "X", message: "nope" } });
    const ok = await openRelayMappingAgents([{ stationId: "hetune", providerName: "河图" }]);
    expect(ok).toBe(false);
    expect(mocks.createNewSession).not.toHaveBeenCalled();
  });

  it("dispatches the remaining stations when only some handoffs fail", async () => {
    mocks.request.mockImplementation(
      async (
        _ctx: unknown,
        _method: unknown,
        params: {
          stationId: string;
        },
      ) =>
        params.stationId === "broken"
          ? { ok: false, error: { code: "X", message: "nope" } }
          : { ok: true, result: handoffFor(params.stationId) },
    );
    const ok = await openRelayMappingAgents([
      { stationId: "hetune", providerName: "河图" },
      { stationId: "broken", providerName: "坏站" },
    ]);
    expect(ok).toBe(true);
    const newKey = draftKeyForTarget({
      kind: "new-conversation",
      canonicalCwd: defaultWorkspace.canonicalCwd,
    });
    const refs: DraftReference[] = useAppStore.getState().draftReferences[newKey] ?? [];
    expect(refs).toHaveLength(1);
    expect(refs[0]!.id).toBe("relay-mapping:hetune");
  });

  it("does nothing for an empty selection", async () => {
    const ok = await openRelayMappingAgents([]);
    expect(ok).toBe(false);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.createNewSession).not.toHaveBeenCalled();
  });
});
