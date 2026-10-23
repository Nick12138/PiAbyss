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
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  getSubagentApi,
  type SubagentHttpRunSummary,
  type SubagentHttpRunsResponse,
} from "./subagent-api.js";
import { mapSubagentRunState } from "./subagent-runs.js";

/** Poll cadence: fast while a run is live, slow when the fleet is idle.
 *
 * The 750ms tick issues a loopback HTTP request that makes the plugin re-read
 * its whole run store; an idle fleet (nothing running) kept paying that for a
 * panel that had nothing to update. Idle backoff keeps the panel live without
 * the per-second disk churn. */
const ACTIVE_POLL_MS = 750;
const IDLE_POLL_MS = 5_000;
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
    ...(run.thinking?.trim() ? { thinking: run.thinking } : {}),
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
 * recorded sessionId matches the active session, OR (for legacy runs without
 * a recorded sessionId) when its run id appears in the active session's own
 * transcript — i.e. this session really spawned it. Once a run has an explicit
 * sessionId, that value is authoritative; transcript evidence must not
 * override it, otherwise a stale/ambiguous transcript could reintroduce a
 * run from another session. Historical runs from other sessions never leak
 * into the panel. */
export function normalizeSubagentRuns(
  runs: SubagentHttpRunSummary[],
  now = Date.now(),
  sessionId?: string | null,
  ownedRunIds: Set<string> | null = null,
): SubagentsStatusSnapshot {
  const scoped = runs.filter((run) => {
    // Explicit ownership is authoritative. The transcript fallback is only
    // for pre-sessionId runs produced by older plugin versions.
    if (typeof run.sessionId === "string" && run.sessionId.trim()) {
      return run.sessionId === sessionId;
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

let sessionRunIdCache: {
  sessionId: string;
  mtime: number;
  offset: number;
  ids: Set<string>;
} | null = null;

/** Clear the per-session mtime cache (test isolation). */
export function resetSessionRunIdCache(): void {
  sessionRunIdCache = null;
}

/** The structured details list is plugin-generated, so it only needs a shape check. */
const STRUCTURED_RUN_ID = /^run_[a-z0-9]+$/;
/** Spawn confirmation header, e.g. "已提交 2 个子代理任务（并发上限 10…）：". */
const SPAWN_CONFIRMATION_HEADER = /^已提交\s*\d+\s*个子代理任务/;
/** A run bullet in the spawn confirmation body ("- run_xxx"). */
const SPAWN_CONFIRMATION_BULLET = /^[ \t]*[-*][ \t]*(run_[a-z0-9]{8,})\b/;

/** Run ids a `subagent` tool result actually submitted.
 *
 * The plugin returns them as structured `details.runIds`, which is the only
 * authoritative source. Matching the raw result text is *not* evidence of a
 * spawn: an `action:"list"`/`"result"` output routinely mentions dozens of
 * foreign run ids, and its text can even contain "已提交" through a run title
 * like「复查已提交的 A/B/C 改造」 — that one title used to make every listed
 * run look like a run this session had spawned. For older plugin versions
 * without `details`, only the anchored confirmation shape counts: the
 * "已提交 N 个子代理任务" header followed by its "- run_xxx" bullet lines. */
function spawnedRunIds(record: { content?: unknown; details?: unknown }): string[] {
  const details = record.details;
  if (details && typeof details === "object") {
    const runIds = (details as { runIds?: unknown }).runIds;
    if (Array.isArray(runIds)) {
      return runIds
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => STRUCTURED_RUN_ID.test(id));
    }
  }
  const lines = toolResultText(record.content).split(/\r?\n/);
  const header = lines.findIndex((line) => SPAWN_CONFIRMATION_HEADER.test(line.trim()));
  if (header < 0) return [];
  const ids: string[] = [];
  for (let index = header + 1; index < lines.length; index += 1) {
    const match = SPAWN_CONFIRMATION_BULLET.exec(lines[index] ?? "");
    if (!match?.[1]) break;
    ids.push(match[1]);
  }
  return ids;
}

/** Extract the run ids the given session spawned by scanning its transcript.
 * Only `subagent` tool RESULTS that report a successful submission count as
 * spawns — mentions in `list`/`result`/wait outputs are ignored, otherwise one
 * `subagent(action:"list")` call would attribute every run to the session.
 * Uses a per-session mtime cache so the 750ms status poll stays cheap.
 * Returns null when the session file cannot be resolved. */
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
  let fileStat;
  try {
    fileStat = statSync(target);
  } catch {
    return null;
  }
  const mtime = fileStat.mtimeMs;
  const size = fileStat.size;
  const previous =
    sessionRunIdCache && sessionRunIdCache.sessionId === sessionId ? sessionRunIdCache : null;
  if (previous && previous.mtime === mtime && previous.offset === size) return previous.ids;

  // A session transcript is append-only, so a growing file only needs the new
  // bytes parsed. Re-reading it whole made every 750ms poll pay for the entire
  // conversation once the session got long — exactly when switching felt worst.
  const ids = new Set<string>(previous ? previous.ids : []);
  let offset = previous && size >= previous.offset ? previous.offset : 0;
  const pending = size - offset;
  if (pending > 0) {
    try {
      const fd = openSync(target, "r");
      try {
        const buffer = Buffer.alloc(pending);
        const read = readSync(fd, buffer, 0, pending, offset);
        const chunk = buffer.subarray(0, read).toString("utf8");
        // Consume whole lines only; a partially written tail line is left for
        // the next poll (the writer has not finished the JSON yet).
        const boundary = chunk.lastIndexOf("\n");
        const complete = boundary >= 0 ? chunk.slice(0, boundary + 1) : "";
        if (complete) {
          offset += Buffer.byteLength(complete, "utf8");
          for (const line of complete.split("\n")) {
            let entry: unknown;
            try {
              entry = JSON.parse(line);
            } catch {
              continue;
            }
            if (!entry || typeof entry !== "object") continue;
            const message = (entry as { message?: unknown }).message;
            if (!message || typeof message !== "object") continue;
            const record = message as {
              role?: unknown;
              toolName?: unknown;
              content?: unknown;
              details?: unknown;
            };
            if (record.role !== "toolResult" || record.toolName !== "subagent") continue;
            for (const id of spawnedRunIds(record)) ids.add(id);
          }
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  }
  sessionRunIdCache = { sessionId, mtime, offset, ids };
  return ids;
}

/**
 * Structural equality of two snapshots, ignoring `generatedAt`.
 *
 * Every poll builds a fresh object, so the desktop's store saw a "change" on
 * each tick — 80 re-renders a minute for a panel whose content had not moved.
 * Comparing the payload (runs are bounded at MAX_RUNS) is far cheaper than the
 * React work it avoids.
 */
function sameSnapshotPayload(
  left: SubagentsStatusSnapshot,
  right: SubagentsStatusSnapshot,
): boolean {
  if (left === right) return true;
  if (
    left.available !== right.available ||
    left.totalActive !== right.totalActive ||
    left.omitted !== right.omitted ||
    left.runs.length !== right.runs.length
  ) {
    return false;
  }
  for (let index = 0; index < left.runs.length; index += 1) {
    const a = left.runs[index];
    const b = right.runs[index];
    if (a === b) continue;
    if (!a || !b) return false;
    if (a.id !== b.id || a.state !== b.state || a.updatedAt !== b.updatedAt) return false;
    if (a.activity?.state !== b.activity?.state) return false;
    if (a.label !== b.label || a.role !== b.role || a.model !== b.model) return false;
  }
  return true;
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
    const unchanged = sameSnapshotPayload(latest, snapshot);
    latest = snapshot;
    if (unchanged) return;
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pollDelay = ACTIVE_POLL_MS;
    let sessionDisposed = false;
    let polling = false;

    /** Re-arm the next poll; the delay comes from the previous poll's result. */
    const armPoll = () => {
      if (disposed || sessionDisposed || generation !== activeGeneration) return;
      timer = setTimeout(() => {
        timer = undefined;
        void pollOnce().then(armPoll, armPoll);
      }, pollDelay);
      timer.unref?.();
    };

    const stop = () => {
      sessionDisposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    stopActiveExtension = stop;

    const pollOnce = async () => {
      if (disposed || sessionDisposed || generation !== activeGeneration || polling) return;
      polling = true;
      try {
        const data = await getSubagentApi<SubagentHttpRunsResponse>("/api/runs");
        if (disposed || sessionDisposed || generation !== activeGeneration) return;
        // Only legacy runs without an explicit sessionId are attributed via
        // the active session's transcript. Explicit plugin ownership is
        // authoritative and is checked inside normalizeSubagentRuns.
        const ownedRunIds = options.sessionsDir
          ? collectSessionRunIds(options.sessionsDir, identity?.sessionId)
          : null;
        const snapshot =
          data && Array.isArray(data.runs)
            ? normalizeSubagentRuns(data.runs, Date.now(), identity?.sessionId, ownedRunIds)
            : unavailable();
        // Anything actually running keeps the fast cadence; an idle fleet backs
        // off so the panel stops re-reading the plugin store every 750ms.
        pollDelay = snapshot.totalActive > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS;
        publish(generation, snapshot);
      } catch {
        // Plugin absent or unreachable: back off instead of hammering the port.
        pollDelay = IDLE_POLL_MS;
      } finally {
        polling = false;
      }
    };

    const startPolling = () => {
      if (disposed || sessionDisposed || generation !== activeGeneration) return;
      publish(generation, unavailable());
      if (timer) clearTimeout(timer);
      timer = undefined;
      pollDelay = ACTIVE_POLL_MS;
      void pollOnce().then(armPoll, armPoll);
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
        if (!timer) {
          pollDelay = ACTIVE_POLL_MS;
          void pollOnce().then(armPoll, armPoll);
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
