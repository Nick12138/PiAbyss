import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostEventEnvelope } from "@piabyss/protocol";
import { publishValidatedHostEvent, subscribeValidatedHostEvent } from "./validated-host-events";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function filesChanged(
  overrides: Partial<HostEventEnvelope<"workspace.filesChanged">> = {},
): HostEventEnvelope<"workspace.filesChanged"> {
  return {
    protocolVersion: 1,
    event: "workspace.filesChanged",
    hostInstanceId: HOST_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRevision: 4,
    sessionId: null,
    sessionRevision: 0,
    packageRevision: 2,
    sequence: 10,
    timestamp: 1,
    payload: { directories: ["src"] },
    ...overrides,
  };
}

const unsubscribers: Array<() => void> = [];

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  vi.restoreAllMocks();
});

describe("validated Host event subscriptions", () => {
  it("routes only the named event from the captured Workspace generation", () => {
    const received: string[][] = [];
    unsubscribers.push(
      subscribeValidatedHostEvent(
        "workspace.filesChanged",
        {
          expectedHostInstanceId: HOST_ID,
          expectedWorkspaceId: WORKSPACE_ID,
          expectedWorkspaceRevision: 4,
        },
        (event) => received.push(event.payload.directories),
      ),
    );

    publishValidatedHostEvent(filesChanged());
    publishValidatedHostEvent(filesChanged({ workspaceRevision: 5 }));
    publishValidatedHostEvent(filesChanged({ hostInstanceId: crypto.randomUUID() }));

    expect(received).toEqual([["src"]]);
  });

  it("isolates a throwing subscriber from later subscribers", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const received: string[] = [];
    const scope = {
      expectedHostInstanceId: HOST_ID,
      expectedWorkspaceId: WORKSPACE_ID,
      expectedWorkspaceRevision: 4,
    };
    unsubscribers.push(
      subscribeValidatedHostEvent("workspace.filesChanged", scope, () => {
        throw new Error("listener failed");
      }),
      subscribeValidatedHostEvent("workspace.filesChanged", scope, (event) => {
        received.push(...event.payload.directories);
      }),
    );

    publishValidatedHostEvent(filesChanged());

    expect(received).toEqual(["src"]);
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
