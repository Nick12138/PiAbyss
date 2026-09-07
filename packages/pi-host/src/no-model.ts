import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { buildSessionSnapshot } from "./session-snapshot.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

/** True when a session currently has no enabled Provider model.
 * Matches the SDK NO_MODEL sentinel (provider/id both "unknown"), which the
 * SDK's clearModel() installs when PiAbyss has no enabled Provider. */
export function isPiAbyssNoModel(
  model: { provider?: string; id?: string } | null | undefined,
): boolean {
  return model?.provider === "unknown" && model?.id === "unknown";
}

/**
 * Clear the active model without changing the persisted default.
 * Uses the SDK's native clearModel(): resets state.model to the NO_MODEL
 * sentinel, disables thinking, and emits a model_select extension event.
 * Does not publish a Host session snapshot — callers with a graph must call
 * publishIdleActiveSessionSnapshot after this.
 */
export async function clearSessionModel(session: AgentSession): Promise<void> {
  await session.clearModel();
}

/**
 * Rebuild and emit the active graph snapshot after an idle no-model reconcile.
 * Revision stays the same — this is not a session switch.
 */
export function publishIdleActiveSessionSnapshot(factory: WorkspaceGraphFactory): void {
  const graph = factory.getGraph();
  const server = factory.server;
  const session = graph?.agentSession;
  const sessionManager = graph?.sessionManager;
  const current = graph?.sessionSnapshot;
  if (!graph || !server || !session || !sessionManager || !current) return;

  const snapshot = buildSessionSnapshot({
    session,
    sessionManager,
    cwd: graph.canonicalCwd,
    sessionId: current.sessionId,
    revision: current.revision,
    workspaceId: graph.workspaceId,
    toolRevision: graph.toolRevision,
  });
  graph.sessionSnapshot = snapshot;
  server.emit("session.snapshot", snapshot);
}
