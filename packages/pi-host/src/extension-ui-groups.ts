import { createHash } from "node:crypto";
import type {
  ExtensionUiGroupClosed,
  ExtensionUiGroupStatus,
  HostIdentity,
} from "@piabyss/protocol";
import {
  registerExtensionInvocationCompletion,
  type ExtensionInvocationContext,
} from "./extension-invocation-context.js";

type ActiveDecisionGroup = {
  groupKey: string;
  unregisterCompletion: () => void;
};

function decisionGroupKind(
  context: ExtensionInvocationContext,
): "tool" | "command" | undefined {
  if (context.origin.invocationKind === "tool") return "tool";
  if (context.origin.invocationKind === "command") return "command";
  return undefined;
}

export function createExtensionUiGroupKey(
  context: ExtensionInvocationContext,
  identity: HostIdentity,
): string | undefined {
  const kind = decisionGroupKind(context);
  if (!kind || !identity.sessionId) return undefined;

  const origin = context.origin;
  const trustedInvocationKey =
    origin.invocationKind === "tool"
      ? `${origin.extensionId}\0${origin.toolCallId}`
      : origin.invocationKind === "command"
        ? `${origin.extensionId}\0${origin.commandName}`
        : "";
  const digest = createHash("sha256")
    .update(
      [
        identity.hostInstanceId,
        identity.workspaceId ?? "",
        identity.sessionId,
        kind,
        trustedInvocationKey,
        context.invocationId,
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 32);
  return `${kind}:${digest}`;
}

export class ExtensionUiGroupRegistry {
  private readonly groupsByInvocation = new Map<string, ActiveDecisionGroup>();

  constructor(private readonly emitClosed: (payload: ExtensionUiGroupClosed) => void) {}

  groupForRequest(
    context: ExtensionInvocationContext | undefined,
    identity: HostIdentity,
  ): string | undefined {
    if (!context?.active) return undefined;
    const existing = this.groupsByInvocation.get(context.invocationId);
    if (existing) return existing.groupKey;

    const groupKey = createExtensionUiGroupKey(context, identity);
    if (!groupKey) return undefined;
    const group: ActiveDecisionGroup = {
      groupKey,
      unregisterCompletion: () => {},
    };
    this.groupsByInvocation.set(context.invocationId, group);
    group.unregisterCompletion = registerExtensionInvocationCompletion(
      context,
      (status) => {
        this.closeInvocation(
          context.invocationId,
          status === "completed" ? "completed" : "failed",
        );
      },
    );
    return groupKey;
  }

  closeAll(status: Extract<ExtensionUiGroupStatus, "cancelled" | "stale">): void {
    for (const invocationId of [...this.groupsByInvocation.keys()]) {
      this.closeInvocation(invocationId, status);
    }
  }

  private closeInvocation(
    invocationId: string,
    status: ExtensionUiGroupStatus,
  ): void {
    const group = this.groupsByInvocation.get(invocationId);
    if (!group) return;
    this.groupsByInvocation.delete(invocationId);
    group.unregisterCompletion();
    try {
      this.emitClosed({ groupKey: group.groupKey, status });
    } catch {
      // Group publication cannot change Extension invocation semantics.
    }
  }
}
