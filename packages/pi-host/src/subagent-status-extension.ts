/**
 * Bridges the my-pi-plugins pi-subagent HTTP API into a Host event.
 *
 * The pi-subagent extension (my-pi-plugins/packages/pi-subagent) starts a
 * loopback HTTP server (`http://127.0.0.1:<SUBAGENT_HTTP_PORT|18765>`) once
 * per process. This adapter polls `GET /api/runs` and publishes the mapped
 * `SubagentsStatusSnapshot` through the `subagents.statusChanged` host event;
 * when the plugin is absent (connection refused) it degrades to an
 * empty/unavailable snapshot.
 *
 * The extension-factory lifecycle and the identity/generation gate are
 * preserved from the previous pi-subagents RPC bridge so that a mid-session
 * package install/reload keeps publishing instead of freezing the panel.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { HostIdentity, SubagentStatusNode, SubagentsStatusSnapshot } from "@piabyss/protocol";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  getSubagentApi,
  type SubagentHttpRunSummary,
  type SubagentHttpRunsResponse,
} from "./subagent-api.js";
import { mapSubagentRunState } from "./subagent-runs.js";

const POLL_MS = 750;
/** dto-validate caps the runs array at 32; anything beyond becomes `omitted`. */
const MAX_RUNS = 32;

function unavailable(): SubagentsStatusSnapshot {
  return {
    version: 1,
    available: false,
    generatedAt: Date.now(),
    totalActive: 0,
    omitted: 0,
    fleet: [],
    runs: [],
  };
}

/** Map one plugin run summary to the panel's status node shape. */
export function mapSubagentHttpRun(run: SubagentHttpRunSummary): SubagentStatusNode {
  const label = run.title?.trim() || run.id;
  return {
    id: run.id,
    kind: "subagent",
    label,
    ...(run.agent?.trim() ? { role: run.agent } : {}),
    ...(run.model?.trim() ? { model: run.model } : {}),
    state: mapSubagentRunState(run.status),
    ...(typeof run.startedAt === "number" ? { startedAt: run.startedAt } : {}),
    ...(typeof run.finishedAt === "number" ? { endedAt: run.finishedAt } : {}),
    updatedAt:
      typeof run.finishedAt === "number"
        ? run.finishedAt
        : typeof run.startedAt === "number"
          ? run.startedAt
          : Date.now(),
    ...(run.outputPreview ? { activity: { state: run.outputPreview.slice(0, 200) } } : {}),
  };
}

/** Normalize a `GET /api/runs` payload into a bounded status snapshot.
 * Runs are scoped to the active orchestrator session: a run is shown when its
 * recorded sessionId matches the active session, OR when its run id appears
 * in the active session's own transcript — i.e. this session really spawned
 * it. The transcript fallback covers both legacy runs without a recorded
 * sessionId and runs whose recorded sessionId is stale (the plugin snapshots
 * the orchestrator session id from a process-global env var set at the last
 * session_start; session switches that skip session_start leave it pointing
 * at the previous session). Historical runs from other sessions never leak
 * into the panel. */
export function normalizeSubagentRuns(
  runs: SubagentHttpRunSummary[],
  now = Date.now(),
  sessionId?: string | null,
  ownedRunIds: Set<string> | null = null,
): SubagentsStatusSnapshot {
  const scoped = runs.filter((run) => {
    if (typeof run.sessionId === "string" && run.sessionId && run.sessionId === sessionId) {
      return true;
    }
    return ownedRunIds?.has(run.id) ?? false;
  });
  const mapped = scoped.slice(0, MAX_RUNS).map(mapSubagentHttpRun);
  return {
    version: 1,
    available: true,
    generatedAt: now,
    totalActive: mapped.filter((node) => node.state === "running").length,
    omitted: Math.max(0, scoped.length - MAX_RUNS),
    fleet: [],
    runs: mapped,
  };
}

let sessionRunIdCache: { sessionId: string; mtime: number; ids: Set<string> } | null = null;

/** Clear the per-session mtime cache (test isolation). */
export function resetSessionRunIdCache(): void {
  sessionRunIdCache = null;
}

/** Extract the run ids the given session spawned by scanning its transcript.
 * Only `subagent` tool RESULTS that report a successful submission ("已提交")
 * count as spawns — mentions in `list`/`result`/wait outputs are ignored,
 * otherwise one `subagent(action:"list")` call would attribute every run to
 * the session. Uses a per-session mtime cache so the 750ms status poll stays
 * cheap. Returns null when the session file cannot be resolved. */
export function collectSessionRunIds(
  sessionsDir: string,
  sessionId: string | null | undefined,
): Set<string> | null {
  if (!sessionsDir || !sessionId) return null;
  let files: string[];
  try {
    files = readdirSync(sessionsDir).filter(
      (name) => name.endsWith(".jsonl") && name.includes(sessionId),
    );
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const target = files
    .map((name) => join(sessionsDir, name))
    .sort((left, right) => {
      try {
        return statSync(right).mtimeMs - statSync(left).mtimeMs;
      } catch {
        return 0;
      }
    })[0];
  if (!target) return null;
  let mtime: number;
  try {
    mtime = statSync(target).mtimeMs;
  } catch {
    return null;
  }
  if (
    sessionRunIdCache &&
    sessionRunIdCache.sessionId === sessionId &&
    sessionRunIdCache.mtime === mtime
  ) {
    return sessionRunIdCache.ids;
  }
  const ids = new Set<string>();
  try {
    for (const line of readFileSync(target, "utf8").split(/\r?\n/)) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const message = (entry as { message?: unknown }).message;
      if (!message || typeof message !== "object") continue;
      const record = message as { role?: unknown; toolName?: unknown; content?: unknown };
      if (record.role !== "toolResult" || record.toolName !== "subagent") continue;
      const text = toolResultText(record.content);
      // A spawn confirmation looks like "已提交 1 个子代理任务… - run_xxx".
      if (!text.includes("已提交")) continue;
      for (const match of text.matchAll(/\brun_[a-z0-9]{8,}/g)) ids.add(match[0]);
    }
  } catch {
    return null;
  }
  sessionRunIdCache = { sessionId, mtime, ids };
  return ids;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("\n");
}

export type SubagentStatusBridge = {
  extension: ExtensionFactory;
  setIdentity(identity: HostIdentity): void;
  markReady(): void;
  dispose(): void;
};

/**
 * Bridges the pi-subagent HTTP API into a Host event. The adapter only talks
 * to the loopback HTTP API documented by the plugin and degrades to an
 * empty/unavailable snapshot when the plugin is absent or unreachable.
 */
export function createSubagentStatusBridge(
  emit: (identity: HostIdentity, snapshot: SubagentsStatusSnapshot) => void,
  options: { sessionsDir?: string } = {},
): SubagentStatusBridge {
  let identity: HostIdentity | null = null;
  let latest = unavailable();
  let disposed = false;
  let nextGeneration = 0;
  let activeGeneration = 0;
  let identityGeneration = 0;
  let readyGeneration = 0;

  const emitCurrent = () => {
    if (
      disposed ||
      !identity ||
      identityGeneration !== activeGeneration ||
      readyGeneration !== activeGeneration
    )
      return;
    emit(identity, latest);
  };

  const publish = (generation: number, snapshot: SubagentsStatusSnapshot) => {
    latest = snapshot;
    if (generation === activeGeneration) emitCurrent();
  };

  let stopActiveExtension: (() => void) | null = null;
  const extension: ExtensionFactory = (pi: ExtensionAPI) => {
    stopActiveExtension?.();
    // The SDK re-invokes inline extension factories whenever the resource
    // loader reloads (package install/remove/update, skill mutation). For an
    // already-live session the lifecycle only calls setIdentity/markReady on
    // session create/open, so without inheriting the previous instance's sync
    // markers every publish after the reload is dropped by the generation gate
    // below and the desktop panel freezes on its last snapshot (e.g. the
    // pre-install "pi-subagent not detected" state).
    const inheritsLiveSession =
      identity !== null &&
      identityGeneration === activeGeneration &&
      readyGeneration === activeGeneration;
    const generation = ++nextGeneration;
    activeGeneration = generation;
    if (inheritsLiveSession) {
      identityGeneration = generation;
      readyGeneration = generation;
    }
    let interval: ReturnType<typeof setInterval> | undefined;
    let sessionDisposed = false;
    let polling = false;
    const stop = () => {
      sessionDisposed = true;
      if (interval) clearInterval(interval);
      interval = undefined;
    };
    stopActiveExtension = stop;

    const pollOnce = async () => {
      if (disposed || sessionDisposed || generation !== activeGeneration || polling) return;
      polling = true;
      try {
        const data = await getSubagentApi<SubagentHttpRunsResponse>("/api/runs");
        if (disposed || sessionDisposed || generation !== activeGeneration) return;
        // Legacy runs (no sessionId recorded) are attributed via the active
        // session's own transcript: if the session invoked `subagent` and got
        // that run id, it belongs to this session.
        const ownedRunIds = options.sessionsDir
          ? collectSessionRunIds(options.sessionsDir, identity?.sessionId)
          : null;
        publish(
          generation,
          data && Array.isArray(data.runs)
            ? normalizeSubagentRuns(data.runs, Date.now(), identity?.sessionId, ownedRunIds)
            : unavailable(),
        );
      } finally {
        polling = false;
      }
    };

    const startPolling = () => {
      if (disposed || sessionDisposed || generation !== activeGeneration) return;
      publish(generation, unavailable());
      if (interval) clearInterval(interval);
      interval = setInterval(() => void pollOnce(), POLL_MS);
      interval.unref?.();
      void pollOnce();
    };

    pi.on("session_start", () => {
      if (generation !== activeGeneration) return;
      sessionDisposed = false;
      startPolling();
    });
    pi.on("session_shutdown", () => {
      if (generation !== activeGeneration) return;
      // The host promotes retained (idle-cached/background) sessions without
      // re-invoking this factory, and disposes the previously active runner
      // afterwards — so a shutdown can arrive while the bridge is already
      // re-pointed at another session's identity. Polling is identity-driven;
      // keep it alive as long as an identity is bound, or the panel freezes
      // on the unavailable snapshot forever.
      if (identity && identityGeneration === activeGeneration) {
        sessionDisposed = false;
        if (!interval) {
          interval = setInterval(() => void pollOnce(), POLL_MS);
          interval.unref?.();
          void pollOnce();
        }
        return;
      }
      stop();
      publish(generation, unavailable());
    });

    // A resource-loader reload of an already-live session is not followed by
    // a session_start (only a full agentSession.reload is), so resume polling
    // here; the session_start handler clears and rebuilds these intervals
    // when a full session reload does fire.
    if (inheritsLiveSession) {
      sessionDisposed = false;
      startPolling();
    }
  };

  return {
    extension,
    setIdentity(next) {
      // Session lifecycle commits identity before publishing session.snapshot.
      // Do not emit here: the desktop must observe the snapshot first or it
      // will reject this session-scoped event as an identity mismatch.
      identity = { ...next };
      identityGeneration = activeGeneration;
      readyGeneration = 0;
    },
    markReady() {
      readyGeneration = activeGeneration;
      emitCurrent();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      identity = null;
      identityGeneration = 0;
      readyGeneration = 0;
      activeGeneration = 0;
      stopActiveExtension?.();
      stopActiveExtension = null;
    },
  };
}
