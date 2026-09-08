import { describe, expect, it } from "vitest";
import type { AgentSession, ExtensionInvocationMetadata } from "@earendil-works/pi-coding-agent";
import type { ExtensionUiGroupClosed, HostIdentity } from "@piabyss/protocol";
import {
  createExtensionInvocationRunner,
  getActiveExtensionInvocation,
  withExtensionCommandOrigin,
} from "./extension-invocation-context.js";
import { createExtensionUiGroupKey, ExtensionUiGroupRegistry } from "./extension-ui-groups.js";

const identity: HostIdentity = {
  hostInstanceId: "host-1",
  workspaceId: "workspace-1",
  workspaceRevision: 1,
  sessionId: "session-1",
  sessionRevision: 1,
  packageRevision: 1,
};

function metadata(
  toolCallId: string,
  kind: "tool" | "event" = "tool",
): ExtensionInvocationMetadata {
  const sourceInfo = {
    path: "/packages/questions/extensions/index.ts",
    source: "npm:@piabyss/questions@1.0.0",
    scope: "user" as const,
    origin: "package" as const,
    baseDir: "/packages/questions",
  };
  return kind === "tool"
    ? {
        kind,
        sourceInfo,
        toolName: "ask_user_question",
        toolCallId,
      }
    : {
        kind,
        sourceInfo,
        eventType: "tool_execution_end",
        toolName: "ask_user_question",
        toolCallId,
      };
}

describe("ExtensionUiGroupRegistry", () => {
  it("reuses one redacted key for sequential requests and closes on completion", async () => {
    const session = {} as AgentSession;
    const events: ExtensionUiGroupClosed[] = [];
    const groups = new ExtensionUiGroupRegistry((event) => events.push(event));
    const runner = createExtensionInvocationRunner(session);

    const keys = await runner(metadata("provider-call-sensitive"), async () => {
      const context = getActiveExtensionInvocation(session)!;
      const first = groups.groupForRequest(context, identity);
      const second = groups.groupForRequest(context, identity);
      expect(createExtensionUiGroupKey(context, identity)).toBe(first);
      return [first, second];
    });

    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^tool:[0-9a-f]{32}$/);
    expect(keys[0]).not.toContain("provider-call-sensitive");
    expect(events).toEqual([{ groupKey: keys[0], status: "completed" }]);
  });

  it("keeps parallel tool invocations separate and reports failures", async () => {
    const session = {} as AgentSession;
    const events: ExtensionUiGroupClosed[] = [];
    const groups = new ExtensionUiGroupRegistry((event) => events.push(event));
    const runner = createExtensionInvocationRunner(session);

    const first = runner(metadata("call-1"), async () =>
      groups.groupForRequest(getActiveExtensionInvocation(session), identity),
    );
    const second = runner(metadata("call-2"), async () => {
      const key = groups.groupForRequest(getActiveExtensionInvocation(session), identity);
      throw Object.assign(new Error("failed"), { key });
    });

    const firstKey = await first;
    await expect(Promise.resolve(second)).rejects.toThrow("failed");
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.groupKey)).size).toBe(2);
    expect(events).toContainEqual({ groupKey: firstKey, status: "completed" });
    expect(events).toContainEqual(expect.objectContaining({ status: "failed" }));
  });

  it("groups repeated command runs by their distinct Host invocation IDs", async () => {
    const session = {} as AgentSession;
    const events: ExtensionUiGroupClosed[] = [];
    const groups = new ExtensionUiGroupRegistry((event) => events.push(event));
    const command = {
      invocation: "review",
      command: {
        name: "review",
        invocationName: "review",
        sourceInfo: {
          path: "/packages/questions/extensions/review.ts",
          source: "npm:@piabyss/questions@1.0.0",
          scope: "user" as const,
          origin: "package" as const,
          baseDir: "/packages/questions",
        },
        handler: async () => {},
      },
    };

    const runCommand = (runId: string) =>
      withExtensionCommandOrigin(session, runId, command, async () =>
        groups.groupForRequest(getActiveExtensionInvocation(session), identity),
      );
    const firstKey = await runCommand("00000000-0000-4000-8000-000000000001");
    const secondKey = await runCommand("00000000-0000-4000-8000-000000000002");

    expect(firstKey).toMatch(/^command:[0-9a-f]{32}$/);
    expect(secondKey).toMatch(/^command:[0-9a-f]{32}$/);
    expect(secondKey).not.toBe(firstKey);
    expect(events).toEqual([
      { groupKey: firstKey!, status: "completed" },
      { groupKey: secondKey!, status: "completed" },
    ]);
  });

  it("does not auto-group event invocations and closes disposal once", async () => {
    const session = {} as AgentSession;
    const events: ExtensionUiGroupClosed[] = [];
    const groups = new ExtensionUiGroupRegistry((event) => events.push(event));
    const runner = createExtensionInvocationRunner(session);

    await runner(metadata("event-call", "event"), async () => {
      expect(
        groups.groupForRequest(getActiveExtensionInvocation(session), identity),
      ).toBeUndefined();
    });

    await runner(metadata("disposed-call"), async () => {
      const key = groups.groupForRequest(getActiveExtensionInvocation(session), identity);
      expect(key).toMatch(/^tool:/);
      groups.closeAll("cancelled");
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("cancelled");
  });
});
