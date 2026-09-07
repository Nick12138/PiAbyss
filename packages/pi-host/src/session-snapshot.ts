import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ModelSummary,
  SerializableAgentMessage,
  SerializableSessionEntry,
  SerializableToolInfo,
  SessionSnapshot,
  ToolSnapshot,
} from "@piabyss/protocol";
import { toJsonValue } from "@piabyss/protocol";
import { buildContextUsageBreakdown } from "./context-usage-breakdown.js";
import { renderExtensionMessageEntries } from "./extension-message-renderer.js";
import { getQueueSnapshot } from "./queue-state.js";
import { logger } from "./logger.js";
import type { WorkspaceGraph } from "./workspace-graph-types.js";

const MAX_SESSION_SNAPSHOT_BYTES = 12 * 1024 * 1024;
const OMITTED_IMAGE_TEXT = "[Image omitted from desktop snapshot: size limit]";

function serializeAgentMessage(message: unknown): SerializableAgentMessage {
  const serialized = toJsonValue(message);
  if (
    typeof serialized !== "object" ||
    serialized === null ||
    Array.isArray(serialized) ||
    Object.hasOwn(serialized, "content")
  ) {
    return serialized as unknown as SerializableAgentMessage;
  }

  // SDK summaries and bash executions omit content, while the desktop wire
  // contract keeps one uniform message shape.
  return { ...serialized, content: "" } as SerializableAgentMessage;
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function jsonArrayByteLength(values: readonly unknown[]): number {
  let bytes = 2;
  for (let index = 0; index < values.length; index += 1) {
    bytes += jsonByteLength(values[index]);
    if (index > 0) bytes += 1;
  }
  return bytes;
}

function snapshotByteLength(snapshot: SessionSnapshot): number {
  const withoutMessages = { ...snapshot, messages: [] };
  return jsonByteLength(withoutMessages) - 2 + jsonArrayByteLength(snapshot.messages);
}

function entriesByteLength(
  entries: readonly SerializableSessionEntry[],
  leafId: string | null,
): number {
  return (
    Buffer.byteLength(',"entries":', "utf8") +
    jsonArrayByteLength(entries) +
    Buffer.byteLength(',"leafId":', "utf8") +
    jsonByteLength(leafId)
  );
}

function omitImages(messages: readonly SerializableAgentMessage[]): SerializableAgentMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((block) => {
      if (block.type !== "image" || typeof block.data !== "string") return block;
      changed = true;
      return { type: "text", text: OMITTED_IMAGE_TEXT };
    });
    return changed ? { ...message, content } : message;
  });
}

function recentMessageSuffix(
  snapshot: SessionSnapshot,
  maxSnapshotBytes: number,
): SerializableAgentMessage[] {
  const emptySnapshotBytes = snapshotByteLength({ ...snapshot, messages: [] });
  if (emptySnapshotBytes > maxSnapshotBytes) return [];

  let suffixStart = snapshot.messages.length;
  let suffixLength = 0;
  let bytes = emptySnapshotBytes;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index]!;
    const nextBytes = bytes + jsonByteLength(message) + (suffixLength > 0 ? 1 : 0);
    if (nextBytes > maxSnapshotBytes) break;
    suffixStart = index;
    suffixLength += 1;
    bytes = nextBytes;
  }
  return snapshot.messages.slice(suffixStart);
}

function minimalSessionSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return {
    sessionId: snapshot.sessionId,
    cwd: snapshot.cwd,
    revision: snapshot.revision,
    isStreaming: snapshot.isStreaming,
    isIdle: snapshot.isIdle,
    isCompacting: snapshot.isCompacting,
    isRetrying: snapshot.isRetrying,
    thinkingLevel: snapshot.thinkingLevel,
    autoCompactionEnabled: snapshot.autoCompactionEnabled,
    autoRetryEnabled: snapshot.autoRetryEnabled,
    steeringMode: snapshot.steeringMode,
    followUpMode: snapshot.followUpMode,
    pending: {
      revision: snapshot.pending.revision,
      steering: [],
      followUp: [],
    },
    messages: [],
    tools: {
      revision: snapshot.tools.revision,
      workspaceId: snapshot.tools.workspaceId,
      sessionId: snapshot.tools.sessionId,
      sessionRevision: snapshot.tools.sessionRevision,
      tools: [],
      active: [],
    },
  };
}

export function buildToolSnapshot(args: {
  session: AgentSession;
  workspaceId: string;
  sessionId: string;
  sessionRevision: number;
  toolRevision: number;
}): ToolSnapshot {
  const tools: SerializableToolInfo[] = args.session.getAllTools().map((t) => {
    const anyT = t as {
      name: string;
      description?: string;
      parameters?: unknown;
      sourceLabel?: string;
      source?: { kind?: string } | string;
    };
    const source =
      anyT.sourceLabel ?? (typeof anyT.source === "string" ? anyT.source : anyT.source?.kind);
    return {
      name: anyT.name,
      description: anyT.description,
      parameters: anyT.parameters !== undefined ? toJsonValue(anyT.parameters) : undefined,
      source,
    };
  });

  return {
    revision: args.toolRevision,
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    sessionRevision: args.sessionRevision,
    tools,
    active: [...args.session.getActiveToolNames()],
  };
}

export function buildSessionSnapshot(args: {
  session: AgentSession;
  sessionManager: SessionManager;
  cwd: string;
  sessionId: string;
  revision: number;
  workspaceId: string;
  toolRevision: number;
  maxSnapshotBytes?: number;
  includeStreamingMessage?: boolean;
}): SessionSnapshot {
  const { session } = args;
  const model = session.model;
  const modelSummary: ModelSummary | undefined = model
    ? {
        provider: model.provider,
        modelId: model.id,
        name: model.name ?? model.id,
        thinkingLevels: session.getAvailableThinkingLevels?.() as string[] | undefined,
      }
    : undefined;

  const streamingMessage = args.includeStreamingMessage
    ? session.agent.state.streamingMessage
    : undefined;
  const messages = [
    ...session.messages,
    ...(streamingMessage === undefined ? [] : [streamingMessage]),
  ].map(serializeAgentMessage);
  const contextUsage = session.getContextUsage?.();
  const contextBreakdown = contextUsage
    ? buildContextUsageBreakdown({
        systemPrompt: session.systemPrompt,
        tools: session.getAllTools(),
        activeToolNames: session.getActiveToolNames(),
        messages: session.messages,
        totalTokens: contextUsage.tokens,
      })
    : undefined;

  const snapshot: SessionSnapshot = {
    sessionId: args.sessionId || session.sessionId,
    sessionPath: session.sessionFile,
    name: session.sessionName,
    cwd: args.cwd,
    revision: args.revision,
    isStreaming: !session.isIdle,
    isIdle: session.isIdle,
    isCompacting: session.isCompacting,
    isRetrying: session.isRetrying,
    model: modelSummary,
    thinkingLevel: String(session.thinkingLevel),
    autoCompactionEnabled: session.autoCompactionEnabled,
    autoRetryEnabled: session.autoRetryEnabled,
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    pending: getQueueSnapshot(session),
    ...(contextUsage
      ? {
          contextUsage: {
            tokens: contextUsage.tokens,
            contextWindow: contextUsage.contextWindow,
            breakdown: contextBreakdown,
          },
        }
      : {}),
    messages,
    tools: buildToolSnapshot({
      session,
      workspaceId: args.workspaceId,
      sessionId: args.sessionId || session.sessionId,
      sessionRevision: args.revision,
      toolRevision: args.toolRevision,
    }),
  };

  const maxSnapshotBytes = args.maxSnapshotBytes ?? MAX_SESSION_SNAPSHOT_BYTES;
  const snapshotBytes = snapshotByteLength(snapshot);

  // Session messages can include an in-flight projection that is not persisted
  // yet. Preserve the compaction-aware entry path only when the entire desktop
  // projection fits; oversized messages never build a duplicate entry tree.
  const canReadEntryPath =
    snapshotBytes <= maxSnapshotBytes &&
    typeof args.sessionManager.buildContextEntries === "function" &&
    typeof args.sessionManager.getLeafId === "function";
  if (canReadEntryPath) {
    const rawEntries = args.sessionManager.buildContextEntries();
    const entries = rawEntries.map((entry) => toJsonValue(entry) as SerializableSessionEntry);
    const leafId = args.sessionManager.getLeafId() ?? null;
    if (snapshotBytes + entriesByteLength(entries, leafId) <= maxSnapshotBytes) {
      const extensionMessageRenders = renderExtensionMessageEntries(
        session,
        rawEntries,
        (entry, error) => {
          logger.warn("Extension message renderer failed", {
            entryId: entry.id,
            customType: typeof entry.customType === "string" ? entry.customType : undefined,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
      const candidate: SessionSnapshot = {
        ...snapshot,
        entries,
        leafId,
        ...(Object.keys(extensionMessageRenders).length > 0 ? { extensionMessageRenders } : {}),
      };
      if (snapshotByteLength(candidate) <= maxSnapshotBytes) return candidate;
      return { ...snapshot, entries, leafId };
    }
  }

  if (snapshotBytes <= maxSnapshotBytes) return snapshot;

  const withoutImages = { ...snapshot, messages: omitImages(snapshot.messages) };
  if (snapshotByteLength(withoutImages) <= maxSnapshotBytes) return withoutImages;

  const recentMessages = {
    ...withoutImages,
    messages: recentMessageSuffix(withoutImages, maxSnapshotBytes),
  };
  if (snapshotByteLength(recentMessages) <= maxSnapshotBytes) return recentMessages;

  return minimalSessionSnapshot(recentMessages);
}

/**
 * Rehydrate must project the live AgentSession. The cached graph snapshot is
 * intentionally rebuilt only at lifecycle boundaries, so it can lag behind a
 * streaming assistant turn while this Host route is inactive.
 */
export function refreshActiveSessionSnapshot(graph: WorkspaceGraph): SessionSnapshot | null {
  const cached = graph.sessionSnapshot;
  if (!graph.agentSession || !graph.sessionManager || !cached) return cached;

  const snapshot = buildSessionSnapshot({
    session: graph.agentSession,
    sessionManager: graph.sessionManager,
    cwd: graph.canonicalCwd,
    sessionId: cached.sessionId,
    revision: cached.revision,
    workspaceId: graph.workspaceId,
    toolRevision: graph.toolRevision,
    includeStreamingMessage: true,
  });
  graph.sessionSnapshot = snapshot;
  return snapshot;
}
