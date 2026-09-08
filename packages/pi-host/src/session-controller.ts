import { join } from "node:path";
import {
  createHostError,
  stripAttachmentReferenceBlocks,
  toJsonValue,
  type HostError,
  type JsonValue,
} from "@piabyss/protocol";
import type { HandlerContext, MethodHandler } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import { buildSessionUsageReport } from "./session-usage-report.js";
import { searchSessions } from "./session-search.js";
import { invalidateSessionListProjection } from "./session-list-projection.js";
import { isObject, readModelsConfig } from "./provider-models-config.js";
import {
  postSubagentApi,
  type SubagentHttpControlResponse,
} from "./subagent-api.js";
import {
  mapSubagentRunState,
  readSubagentRunStatus,
  readSubagentRunTitle,
  readSubagentRunTranscript,
  resolveSubagentRunId,
  subagentRunExists,
} from "./subagent-runs.js";

type SdkSessionTreeNode = {
  entry: unknown;
  children: SdkSessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
};

/**
 * SDK tree nodes carry `label: undefined` keys; toJsonValue would turn those
 * into nulls, which the wire contract rejects — optional keys must be absent.
 */
function toWireTreeNode(node: SdkSessionTreeNode): JsonValue {
  return {
    entry: toJsonValue(node.entry),
    children: node.children.map(toWireTreeNode),
    ...(node.label !== undefined ? { label: node.label } : {}),
    ...(node.labelTimestamp !== undefined ? { labelTimestamp: node.labelTimestamp } : {}),
  };
}

/** Forward a subagent control action to the pi-subagent HTTP API. */
async function controlSubagentRun(
  factory: WorkspaceGraphFactory,
  ctx: HandlerContext,
  action: "stop" | "pause" | "continue" | "resume",
  resultKey: "stopped" | "paused" | "continued" | "resumed",
): Promise<{ result: unknown } | { error: HostError }> {
  const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
  if (stale) return { error: stale };
  const { nodeId } = ctx.params as { nodeId: string };
  const runId = resolveSubagentRunId(nodeId);
  const outcome = await postSubagentApi<SubagentHttpControlResponse>(
    `/api/runs/${encodeURIComponent(runId)}/${action}`,
  );
  if (!outcome) {
    return {
      error: createHostError("HOST_NOT_READY", "pi-subagent API unavailable", {
        retryable: true,
      }),
    };
  }
  if (!outcome.ok) {
    return {
      error: createHostError(
        "AGENT_BUSY",
        outcome.error ?? `Unable to ${action} subagent`,
        { retryable: true },
      ),
    };
  }
  return { result: { [resultKey]: true } };
}

export function createSessionHandlers(
  factory: WorkspaceGraphFactory,
): Partial<Record<string, MethodHandler>> {
  return {
    "session.list": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () => factory.checkIdentity(ctx.context, { requireWorkspace: true }),
        run: async () => {
          const g = factory.getGraph();
          if (!g) throw new Error("No workspace");
          const items = await factory.listSessions();
          return {
            workspaceId: g.workspaceId,
            items: items.map((s) => {
              const runtime = factory.getSessionRuntimeInfo(s.id, s.path);
              return {
                sessionId: s.id,
                sessionPath: s.path,
                name: s.name,
                cwd: s.cwd,
                createdAt: s.created?.getTime?.() ?? s.modified?.getTime?.() ?? Date.now(),
                updatedAt: s.modified?.getTime?.() ?? Date.now(),
                messageCount: s.messageCount,
                archived: s.archived,
                ...(runtime ?? {}),
              };
            }),
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.create": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        allowNullSession: true,
      });
      if (stale) return { error: stale };
      const params = (ctx.params ?? {}) as { name?: string };
      const result = await factory.createSession(ctx.id, params.name);
      if (result && typeof result === "object" && "error" in result) {
        return { error: result.error };
      }
      return { result };
    },

    "session.open": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        allowNullSession: true,
      });
      if (stale) return { error: stale };
      const params = ctx.params as { sessionPath: string };
      let result = await factory.openSession(ctx.id, params.sessionPath);
      if (
        result &&
        typeof result === "object" &&
        "error" in result &&
        result.error.code === "SESSION_NOT_FOUND"
      ) {
        const { resolveManagedSessionWorkspace } = await import("./session-lifecycle.js");
        const targetCwd = await resolveManagedSessionWorkspace(factory, params.sessionPath);
        const currentCwd = factory.getGraph()?.canonicalCwd;
        if (targetCwd && !factory.sessionPathsEqual(currentCwd, targetCwd)) {
          const switched = await factory.setCurrent(targetCwd, ctx.id);
          if ("error" in switched) return { error: switched.error };
          result = await factory.openSession(ctx.id, params.sessionPath);
        }
      }
      if (result && typeof result === "object" && "error" in result) {
        return { error: result.error };
      }
      return { result };
    },

    "session.reload": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const result = await factory.reloadSession(ctx.id);
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.archive": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const params = ctx.params as { sessionId: string; sessionPath: string };
      const result = await factory.archiveSession(ctx.id, params.sessionId, params.sessionPath);
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.restore": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const params = ctx.params as { sessionId: string; sessionPath: string };
      const result = await factory.restoreSession(ctx.id, params.sessionId, params.sessionPath);
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.delete": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const params = ctx.params as { sessionId: string; sessionPath: string };
      const result = await factory.deleteSession(ctx.id, params.sessionId, params.sessionPath);
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.cleanupArchived": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const result = await factory.cleanupArchivedSessions(ctx.id);
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "subagents.getSession": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const { nodeId } = ctx.params as { nodeId: string };
      const runId = resolveSubagentRunId(nodeId);
      if (!subagentRunExists(runId)) {
        return {
          error: createHostError(
            "SESSION_NOT_FOUND",
            "Subagent run transcript is not available",
            {
              retryable: true,
            },
          ),
        };
      }
      const title = readSubagentRunTitle(runId);
      const state = mapSubagentRunState(readSubagentRunStatus(runId));
      const transcript = readSubagentRunTranscript(runId);
      if (!transcript) {
        // The run exists but its pi session file has not been flushed yet
        // (child still starting, or the run never produced an assistant turn).
        // Return an empty snapshot instead of an error so the panel renders
        // the no-conversation state rather than a load failure.
        return {
          result: {
            nodeId,
            sessionId: `sub-${runId}`,
            ...(title ? { name: title } : {}),
            state,
            entries: [],
            truncated: false,
            updatedAt: Date.now(),
          },
        };
      }
      return {
        result: {
          nodeId,
          sessionId: transcript.sessionId,
          ...(transcript.name || title ? { name: transcript.name ?? title } : {}),
          state,
          entries: transcript.entries,
          truncated: transcript.truncated,
          updatedAt: transcript.updatedAt,
        },
      };
    },

    "subagents.stop": async (ctx) => controlSubagentRun(factory, ctx, "stop", "stopped"),
    "subagents.pause": async (ctx) => controlSubagentRun(factory, ctx, "pause", "paused"),
    "subagents.continue": async (ctx) => controlSubagentRun(factory, ctx, "continue", "continued"),
    "subagents.resume": async (ctx) => controlSubagentRun(factory, ctx, "resume", "resumed"),

    "session.getSnapshot": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () => factory.checkIdentity(ctx.context, { requireWorkspace: true }),
        run: async () => {
          const g = factory.getGraph();
          return g?.sessionSnapshot ?? null;
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.setName": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      if (
        !server.serviceGraphLock.tryAcquire({
          operationKind: "session.setName",
          requestId: ctx.id,
        })
      ) {
        return {
          error: createHostError("SERVICE_GRAPH_BUSY", "Service graph busy", {
            retryable: true,
          }),
        };
      }

      try {
        const stale = factory.checkIdentity(ctx.context, {
          requireWorkspace: true,
          requireSession: true,
        });
        if (stale) return { error: stale };
        const g = factory.getGraph();
        if (!g?.sessionManager || !g.agentSession) {
          return { error: createHostError("AGENT_NOT_READY", "No active session") };
        }
        // Renaming only updates Session metadata. It does not alter the
        // running model request, tools, resource graph, or conversation tree;
        // the graph lock above is sufficient serialization for this mutation.
        const params = ctx.params as { name: string };
        const snapshot = factory.setActiveSessionName(params.name);
        if (!snapshot) {
          return { error: createHostError("AGENT_NOT_READY", "No active session") };
        }
        return { result: snapshot };
      } finally {
        server.serviceGraphLock.release(ctx.id);
      }
    },

    "session.rename": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const params = ctx.params as {
        sessionId: string;
        sessionPath: string;
        name: string;
      };
      const result = await factory.renameSession(
        ctx.id,
        params.sessionId,
        params.sessionPath,
        params.name,
      );
      if ("error" in result) return { error: result.error };
      return { result };
    },

    "session.getEntries": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const g = factory.getGraph();
          if (!g?.sessionManager) throw new Error("No active session");
          const entries = g.sessionManager.getEntries().map((e) => toJsonValue(e));
          return {
            entries,
            leafId: g.sessionManager.getLeafId(),
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.getTree": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const g = factory.getGraph();
          if (!g?.sessionManager) throw new Error("No active session");
          return {
            tree: (g.sessionManager.getTree() as SdkSessionTreeNode[]).map(toWireTreeNode),
            leafId: g.sessionManager.getLeafId(),
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.getStats": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const g = factory.getGraph();
          if (!g?.agentSession) throw new Error("No active session");
          const stats = g.agentSession.getSessionStats();
          return {
            messageCount: stats.totalMessages,
            toolCallCount: stats.toolCalls,
            userMessageCount: stats.userMessages,
            assistantMessageCount: stats.assistantMessages,
            toolResultCount: stats.toolResults,
            tokens: {
              input: stats.tokens.input,
              output: stats.tokens.output,
              cacheRead: stats.tokens.cacheRead,
              cacheWrite: stats.tokens.cacheWrite,
              total: stats.tokens.total,
            },
            cost: stats.cost,
            ...(stats.sessionFile ? { sessionFile: stats.sessionFile } : {}),
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.getForkPoints": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const g = factory.getGraph();
          if (!g?.agentSession) throw new Error("No active session");
          return {
            items: g.agentSession.getUserMessagesForForking().map(({ entryId, text }) => ({
              entryId,
              text: stripAttachmentReferenceBlocks(text),
            })),
          };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.fork": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !g.sessionManager || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      if (!g.agentSession.isIdle || factory.getSessionOperationLock(g.agentSession).isHeld()) {
        return { error: createHostError("AGENT_BUSY", "Agent busy", { retryable: true }) };
      }
      const params = ctx.params as { entryId: string; position?: "before" | "at" };
      const { prepareForkFile } = await import("./session-lifecycle.js");
      const prepared = prepareForkFile({
        sessionFile: g.sessionManager.getSessionFile(),
        canonicalCwd: g.canonicalCwd,
        entryId: params.entryId,
        ...(params.position ? { position: params.position } : {}),
      });
      if ("error" in prepared) return { error: prepared.error };
      // openSession owns graph-operation locking and identity advancement.
      const opened = await factory.openSession(ctx.id, prepared.forkedPath);
      if (opened && typeof opened === "object" && "error" in opened) {
        return { error: opened.error };
      }
      // The fork writes a brand-new JSONL outside withSessionFileMutation;
      // drop the projection cache so session.list sees it immediately.
      invalidateSessionListProjection();
      return {
        result: {
          session: opened,
          ...(prepared.selectedText !== undefined ? { selectedText: prepared.selectedText } : {}),
        },
      };
    },

    "session.export": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, {
        requireWorkspace: true,
        requireSession: true,
      });
      if (stale) return { error: stale };
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !server) {
        return { error: createHostError("AGENT_NOT_READY", "No active session") };
      }
      if (!g.agentSession.isIdle || factory.getSessionOperationLock(g.agentSession).isHeld()) {
        return { error: createHostError("AGENT_BUSY", "Agent busy", { retryable: true }) };
      }
      const params = ctx.params as { format: "html" | "jsonl"; path?: string };
      try {
        const path =
          params.format === "html"
            ? await g.agentSession.exportToHtml(params.path)
            : g.agentSession.exportToJsonl(params.path);
        return { result: { path } };
      } catch (err) {
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            err instanceof Error ? err.message : "Export failed",
          ),
        };
      }
    },

    "session.usageReport": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () => factory.checkIdentity(ctx.context, { requireWorkspace: true }),
        run: async () => {
          const g = factory.getGraph();
          if (!g) throw new Error("No workspace");
          const providerNames = new Map(
            factory.deps.modelRuntime
              .getProviders()
              .map((provider) => [provider.id, provider.name]),
          );
          const modelsConfig = await readModelsConfig(join(factory.deps.agentDir, "models.json"));
          for (const [providerId, rawProvider] of Object.entries(modelsConfig.providers)) {
            if (isObject(rawProvider) && typeof rawProvider.name === "string") {
              providerNames.set(providerId, rawProvider.name);
            }
          }
          return buildSessionUsageReport({
            agentDir: factory.deps.agentDir,
            canonicalCwd: g.canonicalCwd,
            workspaceId: g.workspaceId,
            providerNames,
          });
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },

    "session.searchAll": async (ctx) => {
      // Host-scoped read of session files on disk: no workspace graph or lock
      // is involved, so search works across every workspace at any time.
      const params = ctx.params as {
        query: string;
        limit?: number;
        includeArchived?: boolean;
      };
      try {
        const report = await searchSessions({
          agentDir: factory.deps.agentDir,
          query: params.query,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.includeArchived !== undefined
            ? { includeArchived: params.includeArchived }
            : {}),
        });
        return { result: report };
      } catch (err) {
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            err instanceof Error ? err.message : "Session search failed",
          ),
        };
      }
    },

    "session.getCommands": async (ctx) => {
      const server = factory.getServer();
      if (!server) {
        return { error: createHostError("HOST_NOT_READY", "Server not bound") };
      }
      const { withStableGraphRead } = await import("./stable-graph-read.js");
      const out = await withStableGraphRead({
        requestId: ctx.id,
        identity: server.identity,
        serviceGraphLock: server.serviceGraphLock,
        precheck: () =>
          factory.checkIdentity(ctx.context, {
            requireWorkspace: true,
            requireSession: true,
          }),
        run: async () => {
          const g = factory.getGraph();
          if (!g?.agentSession) throw new Error("No active session");
          const commands: {
            invocation: string;
            description: string;
            argumentHint?: string;
            kind: "template" | "command" | "skill";
          }[] = [];
          for (const template of g.agentSession.promptTemplates) {
            commands.push({
              invocation: template.name,
              description: template.description,
              ...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
              kind: "template",
            });
          }
          try {
            for (const command of g.agentSession.extensionRunner.getRegisteredCommands()) {
              commands.push({
                invocation: command.invocationName,
                description: command.description ?? "",
                kind: "command",
              });
            }
          } catch {
            /* runner may be unavailable mid-reload */
          }
          if (g.resourceLoader) {
            for (const skill of g.resourceLoader.getSkills().skills) {
              commands.push({
                invocation: `skill:${skill.name}`,
                description: skill.description,
                kind: "skill",
              });
            }
          }
          return { commands };
        },
      });
      if (!out.ok) return { error: out.error, identity: out.identity };
      return { result: out.result, identity: out.identity };
    },
  };
}
