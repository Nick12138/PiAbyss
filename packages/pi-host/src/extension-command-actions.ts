/**
 * ExtensionCommandContextActions wiring for bindExtensions.
 *
 * Without these, the SDK defaults resolve `{ cancelled: false }` while doing
 * nothing — extension commands like ctx.newSession()/fork()/navigateTree()/
 * switchSession()/reload() (handoff, git-checkpoint, bookmark, …) "succeed"
 * silently. Every action goes through the Host's own session lifecycle so
 * identity advancement, snapshot emission, busy-session retention, and lock
 * semantics stay identical to GUI-initiated operations. Mirrors rpc-mode's
 * wiring (modes/rpc/rpc-mode.js) with the Host's candidate-commit flow
 * standing in for AgentSessionRuntime.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  ExtensionCommandContextActions,
} from "@earendil-works/pi-coding-agent";
import type { HostError } from "@piabyss/protocol";
import {
  createSession,
  openSession,
  prepareForkFile,
  reloadSession,
} from "./session-lifecycle.js";
import { buildSessionSnapshot } from "./session-snapshot.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

function isErrorResult(value: unknown): value is { error: HostError } {
  return typeof value === "object" && value !== null && "error" in value;
}

/** Not re-exported from the package root — derive it from the session method. */
type ReplacedSessionContext = ReturnType<AgentSession["createReplacedSessionContext"]>;

export function createExtensionCommandContextActions(args: {
  factory: WorkspaceGraphFactory;
  /** The session these bindings belong to (not necessarily the active one). */
  session: AgentSession;
}): ExtensionCommandContextActions {
  const { factory, session } = args;

  const replacedContext = (): ReplacedSessionContext => {
    const active = factory.getGraph()?.agentSession;
    if (!active) throw new Error("No active session after replacement");
    return active.createReplacedSessionContext();
  };

  return {
    waitForIdle: () => session.waitForIdle(),

    newSession: async (options) => {
      const result = await createSession(factory, randomUUID(), undefined, {
        ...(options?.parentSession !== undefined
          ? { parentSession: options.parentSession }
          : {}),
        ...(options?.setup !== undefined ? { setup: options.setup } : {}),
      });
      if (isErrorResult(result)) throw new Error(result.error.message);
      await options?.withSession?.(replacedContext());
      return { cancelled: false };
    },

    fork: async (entryId, options) => {
      const g = factory.getGraph();
      if (!g?.sessionManager) throw new Error("No active session manager");
      const prepared = prepareForkFile({
        sessionFile: g.sessionManager.getSessionFile(),
        canonicalCwd: g.canonicalCwd,
        entryId,
        ...(options?.position !== undefined ? { position: options.position } : {}),
      });
      if ("error" in prepared) throw new Error(prepared.error.message);
      // openSession owns graph-operation locking and identity advancement.
      const opened = await openSession(factory, randomUUID(), prepared.forkedPath);
      if (isErrorResult(opened)) throw new Error(opened.error.message);
      await options?.withSession?.(replacedContext());
      return { cancelled: false };
    },

    navigateTree: async (targetId, options) => {
      const g = factory.getGraph();
      const server = factory.getServer();
      if (!g?.agentSession || !g.sessionManager || !server) {
        throw new Error("No active session");
      }
      if (g.agentSession !== session) {
        // The snapshot rebuild below publishes the Host's *active* session;
        // navigating a retained/background session through it would mix the
        // two. The SDK guards stale ctx via runner invalidation, but a live
        // background binding can still reach here.
        throw new Error("Session is no longer the active session");
      }
      // The extension asked for this navigation explicitly — pass the options
      // through like rpc-mode does (the UI path pins summarize:false instead).
      const outcome = await session.navigateTree(targetId, {
        ...(options?.summarize !== undefined ? { summarize: options.summarize } : {}),
        ...(options?.customInstructions !== undefined
          ? { customInstructions: options.customInstructions }
          : {}),
        ...(options?.replaceInstructions !== undefined
          ? { replaceInstructions: options.replaceInstructions }
          : {}),
        ...(options?.label !== undefined ? { label: options.label } : {}),
      });
      // No RPC caller receives the updated snapshot here — publish it the way
      // the agent.navigateTree handler does for GUI-initiated navigation.
      const identity = server.getIdentity();
      const snap = buildSessionSnapshot({
        session,
        sessionManager: g.sessionManager,
        cwd: g.canonicalCwd,
        sessionId: identity.sessionId ?? "",
        revision: identity.sessionRevision,
        workspaceId: g.workspaceId,
        toolRevision: g.toolRevision,
      });
      g.sessionSnapshot = snap;
      server.emit("session.snapshot", snap);
      return { cancelled: outcome.cancelled };
    },

    switchSession: async (sessionPath, options) => {
      const opened = await openSession(factory, randomUUID(), sessionPath);
      if (isErrorResult(opened)) throw new Error(opened.error.message);
      await options?.withSession?.(replacedContext());
      return { cancelled: false };
    },

    reload: async () => {
      // Host-level reload (openSession with forceReload) rather than the
      // session-local SDK reload: the frontend gets a fresh snapshot and the
      // extension runner is rebuilt through the tested rebind path. Throws
      // SESSION_NOT_FOUND for unpersisted sessions.
      const result = await reloadSession(factory, randomUUID());
      if (isErrorResult(result)) throw new Error(result.error.message);
    },
  };
}
