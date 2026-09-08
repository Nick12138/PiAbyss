import { describe, expect, it } from "vitest";
import type { ExtensionUiOrigin, HostIdentity } from "@piabyss/protocol";
import {
  classifyHostDecisionRisk,
  resolveDecisionRoute,
  resolveExtensionUiOwnerSessionState,
  type DecisionRouteInput,
} from "./extension-ui-policy.js";

const toolOrigin: ExtensionUiOrigin = {
  invocationKind: "tool",
  extensionId: "ext-1",
  extensionDisplayName: "Example",
  sourceKind: "package",
  toolName: "deploy",
  toolCallId: "tool-call-1",
};

function routeInput(patch: Partial<DecisionRouteInput> = {}): DecisionRouteInput {
  return {
    mode: "auto",
    kind: "select",
    origin: toolOrigin,
    hasDestructiveOption: false,
    ownerSessionState: "active",
    inlineSurfaceAvailable: true,
    ...patch,
  };
}

describe("resolveDecisionRoute", () => {
  it("classifies only trusted permission and project-trust events as Host-high risk", () => {
    expect(
      classifyHostDecisionRisk({
        invocationKind: "event",
        extensionId: "ext-1",
        extensionDisplayName: "Permission guard",
        sourceKind: "package",
        eventType: "tool_call",
        toolName: "bash",
        toolCallId: "tool-call-1",
      }),
    ).toEqual({ hostRisk: "high", hostRiskReason: "high-risk" });
    expect(
      classifyHostDecisionRisk({
        invocationKind: "event",
        extensionId: "ext-1",
        extensionDisplayName: "Trust guard",
        sourceKind: "package",
        eventType: "project_trust",
      }),
    ).toEqual({ hostRisk: "high", hostRiskReason: "project-trust" });
    expect(
      classifyHostDecisionRisk({
        invocationKind: "event",
        extensionId: "ext-1",
        extensionDisplayName: "Lifecycle guard",
        sourceKind: "package",
        eventType: "session_before_switch",
      }),
    ).toEqual({});
    expect(classifyHostDecisionRisk(toolOrigin)).toEqual({});
  });

  it("keeps legacy mode modal and routes ordinary active tools inline in auto", () => {
    expect(resolveDecisionRoute(routeInput({ mode: "legacy-modal" }))).toMatchObject({
      disposition: "present",
      presentation: "modal",
      risk: "normal",
    });
    expect(resolveDecisionRoute(routeInput())).toEqual({
      disposition: "present",
      presentation: "inline",
      risk: "normal",
      reason: "active-tool",
    });
  });

  it("routes active commands inline and unknown origins conservatively", () => {
    expect(
      resolveDecisionRoute(
        routeInput({
          origin: {
            invocationKind: "command",
            extensionId: "ext-1",
            extensionDisplayName: "Example",
            sourceKind: "package",
            commandName: "review",
          },
        }),
      ),
    ).toMatchObject({ presentation: "inline", reason: "active-command" });
    expect(
      resolveDecisionRoute(routeInput({ origin: { invocationKind: "unknown" } })),
    ).toMatchObject({ presentation: "modal", reason: "unknown-origin" });
    expect(
      resolveDecisionRoute(
        routeInput({
          mode: "inline-first",
          origin: { invocationKind: "unknown" },
        }),
      ),
    ).toMatchObject({ presentation: "inline", reason: "unknown-origin" });
  });

  it("keeps mandatory risk and lifecycle guards modal", () => {
    expect(
      resolveDecisionRoute(routeInput({ riskHint: "high", presentationHint: "inline" })),
    ).toMatchObject({ presentation: "modal", risk: "high", reason: "high-risk" });
    expect(
      resolveDecisionRoute(
        routeInput({
          ...classifyHostDecisionRisk({
            invocationKind: "event",
            extensionId: "ext-1",
            extensionDisplayName: "Trust guard",
            sourceKind: "package",
            eventType: "project_trust",
          }),
          presentationHint: "inline",
        }),
      ),
    ).toMatchObject({ presentation: "modal", risk: "high", reason: "project-trust" });
    expect(
      resolveDecisionRoute(routeInput({ hasDestructiveOption: true, riskHint: "normal" })),
    ).toMatchObject({
      presentation: "modal",
      risk: "high",
      reason: "destructive-option",
    });
    expect(
      resolveDecisionRoute(
        routeInput({
          presentationHint: "inline",
          origin: {
            invocationKind: "event",
            extensionId: "ext-1",
            extensionDisplayName: "Example",
            sourceKind: "package",
            eventType: "session_start",
          },
        }),
      ),
    ).toMatchObject({ presentation: "modal", reason: "session-lifecycle" });
    expect(
      resolveDecisionRoute(
        routeInput({
          presentationHint: "inline",
          origin: {
            invocationKind: "event",
            extensionId: "ext-1",
            extensionDisplayName: "Example",
            sourceKind: "package",
            eventType: "session_before_compact",
          },
        }),
      ),
    ).toMatchObject({ presentation: "modal", reason: "session-lifecycle" });
  });

  it("honors explicit modal and only honors explicit inline when available", () => {
    expect(resolveDecisionRoute(routeInput({ presentationHint: "modal" }))).toMatchObject({
      presentation: "modal",
      reason: "explicit-modal",
    });
    expect(
      resolveDecisionRoute(
        routeInput({
          presentationHint: "inline",
          ownerSessionState: "candidate",
          inlineSurfaceAvailable: false,
        }),
      ),
    ).toMatchObject({ presentation: "modal", reason: "inline-unavailable" });
    expect(resolveDecisionRoute(routeInput({ presentationHint: "inline" }))).toMatchObject({
      presentation: "inline",
      reason: "explicit-inline",
    });
  });

  it("cancels stale owners and queues background owners with a final presentation", () => {
    expect(resolveDecisionRoute(routeInput({ ownerSessionState: "stale" }))).toEqual({
      disposition: "cancel",
      risk: "normal",
      reason: "stale-owner",
    });
    expect(resolveDecisionRoute(routeInput({ ownerSessionState: "background" }))).toEqual({
      disposition: "queue",
      presentation: "inline",
      risk: "normal",
      reason: "background-session",
      presentationReason: "active-tool",
    });
  });
});

const identity: HostIdentity = {
  hostInstanceId: "host-1",
  workspaceId: "workspace-1",
  workspaceRevision: 2,
  sessionId: "session-1",
  sessionRevision: 3,
  packageRevision: 4,
};

describe("resolveExtensionUiOwnerSessionState", () => {
  it("distinguishes active, candidate, background, and stale bindings", () => {
    expect(resolveExtensionUiOwnerSessionState(identity, identity, true)).toBe("active");
    expect(resolveExtensionUiOwnerSessionState(identity, identity, false)).toBe("candidate");
    expect(
      resolveExtensionUiOwnerSessionState(
        identity,
        { ...identity, sessionId: "session-2", sessionRevision: 1 },
        true,
      ),
    ).toBe("background");
    expect(
      resolveExtensionUiOwnerSessionState(identity, { ...identity, workspaceRevision: 3 }, true),
    ).toBe("stale");
    expect(
      resolveExtensionUiOwnerSessionState(
        identity,
        { ...identity, sessionId: null, sessionRevision: 0 },
        true,
      ),
    ).toBe("stale");
  });
});
