import { describe, expect, it } from "vitest";
import type {
  AgentSession,
  ExtensionInvocationMetadata,
  SourceInfo,
} from "@earendil-works/pi-coding-agent";
import {
  createExtensionInvocationRunner,
  getActiveExtensionInvocation,
  getActiveExtensionCommandOrigin,
  getActiveExtensionUiOrigin,
  normalizeExtensionIdentity,
  registerExtensionInvocationCompletion,
  resolveExtensionCommandInvocation,
  type ResolvedExtensionCommandInvocation,
  withExtensionCommandOrigin,
} from "./extension-invocation-context.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sessionWithCommands(names: string[]): AgentSession {
  return {
    extensionRunner: {
      getCommand: (name: string) =>
        names.includes(name) ? commandInvocation(name).command : undefined,
    },
  } as unknown as AgentSession;
}

function commandInvocation(invocation: string): ResolvedExtensionCommandInvocation {
  return {
    invocation,
    command: {
      name: invocation,
      invocationName: invocation,
      sourceInfo: {
        path: `/packages/commands/extensions/${invocation}.ts`,
        source: "npm:@piabyss/commands@2.0.0",
        scope: "user",
        origin: "package",
        baseDir: "/packages/commands",
      },
      handler: async () => {},
    },
  };
}

function packageSourceInfo(
  path = "/packages/commands/extensions/index.ts",
  source = "npm:@piabyss/commands@2.0.0",
): SourceInfo {
  return {
    path,
    source,
    scope: "user",
    origin: "package",
    baseDir: "/packages/commands",
  };
}

function toolMetadata(toolCallId: string): ExtensionInvocationMetadata {
  return {
    kind: "tool",
    sourceInfo: packageSourceInfo(),
    toolName: "ask_user_question",
    toolCallId,
  };
}

describe("extension invocation context", () => {
  it("mirrors the SDK's exact leading slash command parsing", () => {
    const session = sessionWithCommands(["brainstorm", "plan:2"]);
    expect(resolveExtensionCommandInvocation(session, "/brainstorm topic")).toMatchObject({
      invocation: "brainstorm",
      command: { invocationName: "brainstorm" },
    });
    expect(resolveExtensionCommandInvocation(session, "/plan:2")).toMatchObject({
      invocation: "plan:2",
    });
    expect(resolveExtensionCommandInvocation(session, " /brainstorm")).toBeUndefined();
    expect(resolveExtensionCommandInvocation(session, "/unknown")).toBeUndefined();
  });

  it("keeps concurrent session command origins isolated across awaits", async () => {
    const first = sessionWithCommands([]);
    const second = sessionWithCommands([]);
    const firstGate = deferred();
    const secondGate = deferred();
    const seen: string[] = [];

    const firstRun = withExtensionCommandOrigin(
      first,
      "00000000-0000-4000-8000-000000000001",
      commandInvocation("brainstorm"),
      async () => {
        const origin = getActiveExtensionCommandOrigin(first);
        seen.push(origin?.invocation ?? "missing-first");
        expect(origin?.origin).toMatchObject({
          invocationKind: "command",
          extensionDisplayName: "@piabyss/commands",
          sourceKind: "package",
          commandName: "brainstorm",
        });
        expect(getActiveExtensionCommandOrigin(second)).toBeUndefined();
        await firstGate.promise;
        seen.push(getActiveExtensionCommandOrigin(first)?.invocation ?? "missing-first");
      },
    );
    const secondRun = withExtensionCommandOrigin(
      second,
      "00000000-0000-4000-8000-000000000002",
      commandInvocation("plan"),
      async () => {
        seen.push(getActiveExtensionCommandOrigin(second)?.invocation ?? "missing-second");
        expect(getActiveExtensionCommandOrigin(first)).toBeUndefined();
        await secondGate.promise;
        seen.push(getActiveExtensionCommandOrigin(second)?.invocation ?? "missing-second");
      },
    );

    firstGate.resolve();
    secondGate.resolve();
    await Promise.all([firstRun, secondRun]);
    expect(seen).toEqual(["brainstorm", "plan", "brainstorm", "plan"]);
    expect(getActiveExtensionCommandOrigin(first)).toBeUndefined();
    expect(getActiveExtensionCommandOrigin(second)).toBeUndefined();
  });

  it("generates stable opaque identities without exposing source paths", () => {
    const current = normalizeExtensionIdentity(packageSourceInfo());
    const upgraded = normalizeExtensionIdentity(
      packageSourceInfo("/packages/commands/extensions/index.ts", "npm:@piabyss/commands@3.0.0"),
    );
    const sibling = normalizeExtensionIdentity(
      packageSourceInfo("/packages/commands/extensions/other.ts"),
    );
    expect(current).toEqual(upgraded);
    expect(current.extensionId).toMatch(/^ext_[0-9a-f]{24}$/);
    expect(current.extensionId).not.toContain("packages");
    expect(current.extensionDisplayName).toBe("@piabyss/commands");
    expect(current.sourceKind).toBe("package");
    expect(sibling.extensionId).not.toBe(current.extensionId);

    expect(
      normalizeExtensionIdentity({
        path: "/Users/alice/.pi/extensions/review.ts",
        source: "extension:/Users/alice/.pi/extensions/review.ts",
        scope: "temporary",
        origin: "top-level",
      }),
    ).toMatchObject({ extensionDisplayName: "review", sourceKind: "synthetic" });
  });

  it("propagates trusted tool and event origins through awaited async work", async () => {
    const session = sessionWithCommands([]);
    const runner = createExtensionInvocationRunner(session);
    const toolOrigin = await runner(toolMetadata("tool-call-1"), async () => {
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return getActiveExtensionInvocation(session);
    });
    expect(toolOrigin?.origin).toMatchObject({
      invocationKind: "tool",
      extensionDisplayName: "@piabyss/commands",
      toolName: "ask_user_question",
      toolCallId: "tool-call-1",
    });

    const eventOrigin = await runner(
      {
        kind: "event",
        sourceInfo: packageSourceInfo(),
        eventType: "tool_call",
        toolName: "read",
        toolCallId: "tool-call-2",
      },
      async () => {
        await Promise.resolve();
        return getActiveExtensionInvocation(session);
      },
    );
    expect(eventOrigin?.origin).toMatchObject({
      invocationKind: "event",
      eventType: "tool_call",
      toolName: "read",
      toolCallId: "tool-call-2",
    });
    expect(eventOrigin?.invocationId).not.toBe(toolOrigin?.invocationId);
  });

  it("isolates concurrent tool calls and clears completed or failed contexts", async () => {
    const session = sessionWithCommands([]);
    const runner = createExtensionInvocationRunner(session);
    const firstGate = deferred();
    const secondGate = deferred();

    const first = runner(toolMetadata("tool-call-1"), async () => {
      await firstGate.promise;
      return getActiveExtensionUiOrigin(session);
    });
    const second = runner(toolMetadata("tool-call-2"), async () => {
      await secondGate.promise;
      return getActiveExtensionUiOrigin(session);
    });
    secondGate.resolve();
    firstGate.resolve();
    const [firstOrigin, secondOrigin] = await Promise.all([first, second]);
    expect(firstOrigin).toMatchObject({ invocationKind: "tool", toolCallId: "tool-call-1" });
    expect(secondOrigin).toMatchObject({ invocationKind: "tool", toolCallId: "tool-call-2" });
    expect(getActiveExtensionUiOrigin(session)).toEqual({ invocationKind: "unknown" });

    await expect(
      Promise.resolve(
        runner(toolMetadata("tool-call-failed"), async () => {
          throw new Error("tool failed");
        }),
      ),
    ).rejects.toThrow("tool failed");
    expect(getActiveExtensionInvocation(session)).toBeUndefined();

    let finishDetached!: () => void;
    let detachedOrigin: ReturnType<typeof getActiveExtensionInvocation>;
    const detachedDone = new Promise<void>((resolve) => {
      finishDetached = resolve;
    });
    await runner(toolMetadata("tool-call-detached"), () => {
      setTimeout(() => {
        detachedOrigin = getActiveExtensionInvocation(session);
        finishDetached();
      }, 0);
    });
    await detachedDone;
    expect(detachedOrigin).toBeUndefined();
  });

  it("publishes completion after successful and failed invocation scopes", async () => {
    const session = sessionWithCommands([]);
    const runner = createExtensionInvocationRunner(session);
    const completions: string[] = [];

    await runner(toolMetadata("tool-call-complete"), async () => {
      const context = getActiveExtensionInvocation(session);
      expect(context).toBeDefined();
      registerExtensionInvocationCompletion(context!, (status) => {
        completions.push(`tool:${status}`);
      });
      registerExtensionInvocationCompletion(context!, () => {
        throw new Error("observer failure");
      });
    });

    await expect(
      Promise.resolve(
        runner(toolMetadata("tool-call-failed"), async () => {
          const context = getActiveExtensionInvocation(session);
          expect(context).toBeDefined();
          registerExtensionInvocationCompletion(context!, (status) => {
            completions.push(`failed:${status}`);
          });
          throw new Error("expected failure");
        }),
      ),
    ).rejects.toThrow("expected failure");

    expect(completions).toEqual(["tool:completed", "failed:failed"]);
  });
});
