/**
 * Pixie (小精灵) workspace runner — the Host-owned helper agent over a REAL
 * folder workspace (`<agentDir>/workspace/pixie`, or the plugin-configured
 * `PIABYSS_PIXIE_WORKSPACE`).
 *
 * v4 "workspace-ification": every conversation segment is a STANDARD session
 * stored at `<agentDir>/sessions/<workspaceKey(pixieCwd)>/<id>.jsonl` through
 * the one and only `createHostAgentSession` factory (standard project+user
 * scope loading — the pi-pixie extension joins naturally and registers
 * dispatch/rest when its cwd matches). A small timeline file
 * (`<agentDir>/piabyss/pixie/timeline.json`) keeps segment POINTERS only;
 * rendering always reads the session JSONL, so fork/archive/search semantics
 * come for free and a missing file degrades to an archived placeholder.
 *
 * Segments end three ways (all through the same finalize path): the pixie
 * calls `pixie_rest` herself (reason "agent"), the user taps 打个盹 (reason
 * "user", Host-injected instruction + forced fallback), or the per-segment
 * turn budget rolls over (reason "rollover"). In every case the NEXT user
 * message lazily starts a fresh segment whose first prompt carries the
 * built-in `<pixie-context>` identity + handoff + known-workspaces block.
 *
 * The delegation registry (dispatch records) also lives here now, persisted
 * to `dispatches.json` and extended with the three callback kinds:
 * done / error (settled by pixie_report, turn-end auto-fallback, or failure)
 * and ask (pixie_ask → awaiting_user → user reply routed back via followUp).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type {
  PixieAgentMessage,
  PixieDispatchKind,
  PixieDispatchRecord,
  PixieSegment,
  PixieSessionAlive,
} from "@piabyss/protocol";
import { createHostAgentSession } from "./agent-session-factory.js";
import { piabyssDataDir } from "./piabyss-data.js";
import { logger } from "./logger.js";

/** Default pixie workspace directory relative to the agent dir. */
const PIXIE_WORKSPACE_SEGMENT = join("workspace", "pixie");
/** Session name so each segment is recognizable in transcripts. */
const PIXIE_SESSION_NAME = "🧚 小精灵";

/** Fallback sleep phrases when the pixie does not pick one herself. */
const SLEEP_PHRASES = [
  "我先打个盹~",
  "我去转一圈，回来再聊~",
  "眯一会儿，有活随时喊我",
  "打个哈欠……这一段先存档啦",
  "小憩片刻 💤",
];

/** Registry bound: in-memory cap (matches the V1 bound). */
const MAX_DISPATCHES = 50;

/* ── 环境配置（读取时机 = 使用时机，插件库改配置即时生效）────────────── */

/** Resolve the pixie workspace path (plugin config → `{agentDir}` → default). */
export function resolvePixieWorkspacePath(agentDir: string): string {
  const configured = process.env.PIABYSS_PIXIE_WORKSPACE?.trim();
  if (!configured) return join(agentDir, "workspace", "pixie");
  return join(configured.replaceAll("{agentDir}", agentDir));
}

/** Parse `provider/modelId` (first slash — openrouter-style ids keep theirs). */
export function parsePixieModelRef(value: string | undefined): {
  provider: string;
  id: string;
} | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

/** Delegation stale threshold (ms); 0/invalid → default 30 min. */
export function pixieStaleMs(): number {
  const raw = Number(process.env.PIABYSS_PIXIE_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
}

/** Stale-warning push toggle (PIABYSS_PIXIE_STALE_NOTIFY); default on. */
function pixieStaleNotifyEnabled(): boolean {
  return process.env.PIABYSS_PIXIE_STALE_NOTIFY?.trim().toLowerCase() !== "off";
}

/** Per-segment turn budget (auto rollover); invalid → default 200. */
export function pixieSegmentMaxTurns(): number {
  const raw = Number(process.env.PIABYSS_PIXIE_MAX_TURNS);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 200;
}

/* ── 基础设施 ────────────────────────────────────────────────────── */

export function pixieDir(agentDir: string): string {
  const dir = join(piabyssDataDir(agentDir), "pixie");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Host-owned event emitter (wired in main.ts once the server exists). */
let emitServerEvent: ((event: string, payload: unknown) => void) | null = null;

export function configurePixieEventEmitter(
  emit: (event: string, payload: unknown) => void,
): void {
  emitServerEvent = emit;
}

function emit(event: string, payload: unknown): void {
  try {
    emitServerEvent?.(event, payload);
  } catch {
    /* event delivery is best-effort */
  }
}

/** The Host-owned runtime, injected once at startup (schedule runner先例). */
let hostModelRuntime: ModelRuntime | null = null;

export function configurePixieRuntime(runtime: ModelRuntime): void {
  hostModelRuntime = runtime;
}

function requireHostModelRuntime(): ModelRuntime {
  if (!hostModelRuntime) {
    throw new Error("Pixie runtime is not configured (configurePixieRuntime)");
  }
  return hostModelRuntime;
}

/* ── 时间线（timeline.json：只存指针）──────────────────────────────── */

type PixieSegmentReason = "agent" | "user" | "rollover";

type PixieSegmentRecord = PixieSegment;

type PixieTimelineFile = { version: 1; segments: PixieSegmentRecord[] };

function timelinePath(agentDir: string): string {
  return join(pixieDir(agentDir), "timeline.json");
}

function loadTimeline(agentDir: string): PixieTimelineFile {
  const path = timelinePath(agentDir);
  if (!existsSync(path)) return { version: 1, segments: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as PixieTimelineFile).version !== 1 ||
      !Array.isArray((parsed as PixieTimelineFile).segments)
    ) {
      return { version: 1, segments: [] };
    }
    const segments: PixieSegmentRecord[] = [];
    for (const raw of (parsed as PixieTimelineFile).segments) {
      if (typeof raw !== "object" || raw === null) continue;
      const record = raw as Partial<PixieSegmentRecord>;
      if (
        typeof record.id !== "string" ||
        typeof record.sessionId !== "string" ||
        typeof record.sessionPath !== "string" ||
        typeof record.startedAt !== "number"
      ) {
        continue;
      }
      segments.push({
        id: record.id,
        sessionId: record.sessionId,
        sessionPath: record.sessionPath,
        startedAt: record.startedAt,
        endedAt: typeof record.endedAt === "number" ? record.endedAt : null,
        separator: typeof record.separator === "string" ? record.separator : null,
        reason:
          record.reason === "agent" || record.reason === "user" || record.reason === "rollover"
            ? record.reason
            : null,
        handoff: typeof record.handoff === "string" ? record.handoff : null,
      });
    }
    return { version: 1, segments };
  } catch {
    return { version: 1, segments: [] };
  }
}

function saveTimeline(agentDir: string, timeline: PixieTimelineFile): void {
  try {
    writeFileSync(timelinePath(agentDir), JSON.stringify(timeline, null, 2), "utf8");
  } catch (err) {
    logger.warn("Failed to persist pixie timeline", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/* ── 已知工作区（context.json：pixie.setContext 落盘）───────────────── */

type PixieContextFile = { version: 1; workspaces: string[]; updatedAt: number };

function contextPath(agentDir: string): string {
  return join(pixieDir(agentDir), "context.json");
}

function loadKnownWorkspaces(agentDir: string): string[] {
  const path = contextPath(agentDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PixieContextFile>;
    return Array.isArray(parsed.workspaces)
      ? parsed.workspaces.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

/** Persist the known-workspace list pushed by the frontend (pixie.setContext). */
export function setPixieContext(agentDir: string, workspaces: string[]): void {
  const file: PixieContextFile = {
    version: 1,
    workspaces: workspaces.slice(0, 200),
    updatedAt: Date.now(),
  };
  try {
    writeFileSync(contextPath(agentDir), JSON.stringify(file, null, 2), "utf8");
  } catch (err) {
    logger.warn("Failed to persist pixie context", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (runner && runner.agentDir === agentDir) {
    runner.knownWorkspaces = file.workspaces;
  }
}

function knownWorkspacesOf(agentDir: string): string[] {
  if (runner && runner.agentDir === agentDir) return runner.knownWorkspaces;
  return loadKnownWorkspaces(agentDir);
}

/* ── 委派注册表（dispatches.json：持久化 + 三类回调）────────────────── */

/** Dispatch accepted but the target session has not settled yet. */
type PixieDispatch = PixieDispatchRecord;

const dispatches: PixieDispatch[] = [];
let dispatchesLoadedFor: string | null = null;

function dispatchesPath(agentDir: string): string {
  return join(pixieDir(agentDir), "dispatches.json");
}

function persistDispatches(agentDir: string): void {
  try {
    writeFileSync(
      dispatchesPath(agentDir),
      JSON.stringify({ version: 1, records: dispatches }, null, 2),
      "utf8",
    );
  } catch (err) {
    logger.warn("Failed to persist pixie dispatches", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}function loadDispatches(agentDir: string): void {
  if (dispatchesLoadedFor === agentDir) return;
  dispatchesLoadedFor = agentDir;
  const path = dispatchesPath(agentDir);
  if (!existsSync(path)) return;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return;
  }
  const records = (raw as { records?: unknown }).records;
  if (!Array.isArray(records)) return;
  for (const item of records) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Partial<PixieDispatch>;
    if (typeof record.id !== "string" || typeof record.task !== "string") continue;
    const status =
      record.status === "awaiting_user" ||
      record.status === "reported" ||
      record.status === "failed" ||
      record.status === "paused" ||
      record.status === "stopped"
        ? record.status
        : record.status === "queued" || record.status === "cancelled"
          ? record.status
          : "dispatched";
    dispatches.push({
      id: record.id,
      // 队列是进程内存的：重启后 queued/cancelled 记录失去队列归属，取消落档。
      status: status === "queued" ? "cancelled" : status,
      kind:
        record.kind === "done" ||
        record.kind === "error" ||
        record.kind === "ask" ||
        record.kind === "progress" ||
        record.kind === "stopped"
          ? record.kind
          : null,
      cwd: typeof record.cwd === "string" ? record.cwd : "",
      sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
      sessionPath: typeof record.sessionPath === "string" ? record.sessionPath : null,
      task: record.task,
      report: typeof record.report === "string" ? record.report : null,
      question: typeof record.question === "string" ? record.question : null,
      options: Array.isArray(record.options)
        ? record.options.filter((option): option is string => typeof option === "string")
        : [],
      createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
      reportedAt: typeof record.reportedAt === "number" ? record.reportedAt : null,
      stale: record.stale === true,
      startedAt: typeof record.startedAt === "number" ? record.startedAt : null,
      lastActiveAt:
        typeof record.lastActiveAt === "number" ? record.lastActiveAt : null,
      staleNotified: record.staleNotified === true,
      batchId: typeof record.batchId === "string" ? record.batchId : null,
      failCount:
        typeof record.failCount === "number" && Number.isSafeInteger(record.failCount)
          ? record.failCount
          : 0,
      progressSummary:
        typeof record.progressSummary === "string" ? record.progressSummary : null,
      files: Array.isArray(record.files)
        ? record.files.filter((file): file is string => typeof file === "string")
        : null,
      retryOf: typeof record.retryOf === "string" ? record.retryOf : null,
      model: typeof record.model === "string" ? record.model : null,
      thinkingLevel: typeof record.thinkingLevel === "string" ? record.thinkingLevel : null,
    });
  }
  dispatches.sort((left, right) => right.createdAt - left.createdAt);
  if (dispatches.length > MAX_DISPATCHES) dispatches.length = MAX_DISPATCHES;
}

/** Latest activity timestamp of a record (stale / warning clocks read this). */
function lastActiveOf(record: PixieDispatch): number {
  return record.lastActiveAt ?? record.startedAt ?? record.createdAt;
}

/**
 * Lazy staleness pass + one-shot push: a record that crossed the stale
 * threshold and has not been warned yet emits `pixie.staleWarning` exactly
 * once (the frontend shows a banner; repeated scans are no-ops).
 */
function markStaleDispatches(): void {
  const threshold = pixieStaleMs();
  const now = Date.now();
  for (const record of dispatches) {
    const live =
      record.status === "dispatched" || record.status === "paused" || record.status === "awaiting_user";
    if (!live) continue;
    if (record.stale && record.staleNotified) continue;
    const idle = now - lastActiveOf(record);
    if (idle <= threshold) continue;
    record.stale = true;
    if (!record.staleNotified && pixieStaleNotifyEnabled()) {
      record.staleNotified = true;
      dispatchesDirty = true;
      emit("pixie.staleWarning", {
        dispatchId: record.id,
        minutes: Math.max(1, Math.round(idle / 60_000)),
        task: record.task,
        cwd: record.cwd,
      });
    }
  }
}

/** Periodic stale scan (60s) so warnings push without waiting for a read. */
let staleWatcherTimer: ReturnType<typeof setInterval> | null = null;
let staleWatcherFor: string | null = null;

export function startPixieStaleWatcher(agentDir: string): void {
  if (staleWatcherTimer && staleWatcherFor === agentDir) return;
  stopPixieStaleWatcher();
  staleWatcherFor = agentDir;
  staleWatcherTimer = setInterval(() => {
    try {
      loadDispatches(agentDir);
      markStaleDispatches();
      persistDispatchesIfDirty(agentDir);
    } catch {
      /* best-effort */
    }
  }, 60_000);
  staleWatcherTimer.unref?.();
}

export function stopPixieStaleWatcher(): void {
  if (staleWatcherTimer) {
    clearInterval(staleWatcherTimer);
    staleWatcherTimer = null;
    staleWatcherFor = null;
  }
}

/** Persist only when the registry already has unsaved staleness flips. */
let dispatchesDirty = false;

function persistDispatchesIfDirty(agentDir: string): void {
  if (!dispatchesDirty) return;
  dispatchesDirty = false;
  persistDispatches(agentDir);
}

/** Register a new delegation (queued when the target session is busy). */
export function registerDispatch(input: {
  cwd: string;
  sessionId: string | null;
  sessionPath: string | null;
  task: string;
  agentDir: string;
  /** Batch aggregation tag (multi-workspace parallel dispatches). */
  batchId?: string | null;
  /** Redispatch chain: the failed record this one was re-sent from. */
  retryOf?: string | null;
  /** Carried-over consecutive failure count (retry chain). */
  failCount?: number;
  /** Register as queued (engine holds the envelope until the target frees up). */
  queued?: boolean;
  /** 用户明确授权的模型覆盖（"provider/id"）；缺省 = 会话当前模型。 */
  model?: string | null;
  /** 用户明确授权的推理深度覆盖；缺省 = 会话默认。 */
  thinkingLevel?: string | null;
}): PixieDispatch {
  loadDispatches(input.agentDir);
  const now = Date.now();
  const record: PixieDispatch = {
    id: `pix_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    status: input.queued ? "queued" : "dispatched",
    kind: null,
    cwd: input.cwd,
    sessionId: input.sessionId,
    sessionPath: input.sessionPath,
    task: input.task,
    report: null,
    question: null,
    options: [],
    createdAt: now,
    startedAt: input.queued ? null : now,
    reportedAt: null,
    lastActiveAt: input.queued ? null : now,
    stale: false,
    staleNotified: false,
    batchId: input.batchId ?? null,
    failCount: input.failCount ?? 0,
    progressSummary: null,
    files: null,
    retryOf: input.retryOf ?? null,
    model: input.model ?? null,
    thinkingLevel: input.thinkingLevel ?? null,
  };
  dispatches.unshift(record);
  if (dispatches.length > MAX_DISPATCHES) dispatches.length = MAX_DISPATCHES;
  persistDispatches(input.agentDir);
  return record;
}

/** Dequeue a queued dispatch: queued → dispatched (engine injects the envelope). */
export function activateDispatch(id: string, agentDir: string): PixieDispatch | null {
  const record = dispatches.find((d) => d.id === id);
  if (!record || record.status !== "queued") return null;
  const now = Date.now();
  record.status = "dispatched";
  record.startedAt = now;
  record.lastActiveAt = now;
  persistDispatches(agentDir);
  return record;
}

/** Non-final progress update (pixie_report kind=progress; checkpoint 汇报). */
export function progressDispatch(
  id: string,
  summary: string,
  files: string[] | null,
  agentDir: string,
  pause = false,
): PixieDispatch | null {
  const record = dispatches.find((d) => d.id === id);
  if (!record) return null;
  if (record.status !== "dispatched" && record.status !== "paused" && record.status !== "awaiting_user")
    return null;
  record.status = pause ? "paused" : "dispatched";
  record.kind = "progress";
  record.progressSummary = summary;
  record.lastActiveAt = Date.now();
  if (files && files.length > 0) record.files = files.slice(0, 20);
  persistDispatches(agentDir);
  return record;
}

/** Resume a paused delegation (paused → dispatched; user 插入新指令后). */
export function resumePausedDispatch(id: string, agentDir: string): PixieDispatch | null {
  const record = dispatches.find((d) => d.id === id);
  if (!record || record.status !== "paused") return null;
  record.status = "dispatched";
  record.kind = null;
  record.lastActiveAt = Date.now();
  persistDispatches(agentDir);
  return record;
}

/**
 * Terminal-settle hook: the controller installs a queue-drain callback so
 * every settle/fail/stop/cancel path wakes the next queued dispatch without
 * each call site remembering to.
 */
let onTerminalSettleHook: ((sessionId: string | null) => void) | null = null;

export function configurePixieTerminalSettleHook(
  hook: (sessionId: string | null) => void,
): void {
  onTerminalSettleHook = hook;
}

function notifyTerminal(record: PixieDispatch): void {
  try {
    onTerminalSettleHook?.(record.sessionId);
  } catch {
    /* best-effort */
  }
}

/** Settle a delegation with a done/error report (pixie_report or auto-fallback). */
export function settleDispatch(
  id: string,
  report: string,
  kind: PixieDispatchKind = "done",
  agentDir?: string,
): PixieDispatch | null {
  const record = dispatches.find((d) => d.id === id);
  if (!record) return null;
  if (record.status !== "dispatched" && record.status !== "paused" && record.status !== "awaiting_user")
    return null;
  record.status = "reported";
  record.kind = kind;
  record.report = report;
  record.reportedAt = Date.now();
  record.lastActiveAt = record.reportedAt;
  if (agentDir) persistDispatches(agentDir);
  notifyTerminal(record);
  return record;
}

/** Fail a delegation (injection failure, abort, error turn); bumps failCount. */
export function failDispatch(id: string, reason: string, agentDir?: string): PixieDispatch | null {
  const record = dispatches.find((d) => d.id === id);
  if (!record) return null;
  if (record.status !== "dispatched" && record.status !== "paused" && record.status !== "awaiting_user")
    return null;
  record.status = "failed";
  record.kind = "error";
  record.report = reason;
  record.reportedAt = Date.now();
  record.lastActiveAt = record.reportedAt;
  record.failCount += 1;
  if (agentDir) persistDispatches(agentDir);
  notifyTerminal(record);
  return record;
}

/** Settle a user-stopped delegation (dispatched/paused → stopped, 不计失败). */
export function stopSettleDispatch(id: string, agentDir?: string): PixieDispatch | null {
  const record = dispatches.find((d) => d.id === id);
  if (!record) return null;
  if (record.status !== "dispatched" && record.status !== "paused" && record.status !== "awaiting_user")
    return null;
  record.status = "stopped";
  record.kind = "stopped";
  record.reportedAt = Date.now();
  record.lastActiveAt = record.reportedAt;
  if (agentDir) persistDispatches(agentDir);
  notifyTerminal(record);
  return record;
}

/** Cancel a queued dispatch (纯摘队列，未碰过会话，不计失败). */
export function cancelQueuedDispatch(id: string, agentDir: string): PixieDispatch | null {
  const record = dispatches.find((d) => d.id === id);
  if (!record || record.status !== "queued") return null;
  record.status = "cancelled";
  record.reportedAt = Date.now();
  persistDispatches(agentDir);
  notifyTerminal(record);
  return record;
}

/**
 * In-place resume of a failed/stopped delegation: the delegated session is
 * still alive, so the SAME record continues (context intact); failCount
 * carries over +1 for the escalation ladder.
 */
export function reactivateDispatchForResume(id: string, agentDir: string): PixieDispatch | null {
  const record = dispatches.find((d) => d.id === id);
  if (!record) return null;
  if (record.status !== "failed" && record.status !== "stopped") return null;
  const now = Date.now();
  record.status = "dispatched";
  record.kind = null;
  record.report = null;
  record.reportedAt = null;
  record.question = null;
  record.options = [];
  record.startedAt = now;
  record.lastActiveAt = now;
  record.stale = false;
  record.staleNotified = false;
  record.failCount += 1;
  persistDispatches(agentDir);
  return record;
}

/** Record an authorized model/thinking-level change on a live delegation. */
export function recordDispatchModelChange(
  id: string,
  model: string | null,
  thinkingLevel: string | null,
  agentDir: string,
): PixieDispatch | null {
  const record = dispatches.find((d) => d.id === id);
  if (!record) return null;
  record.model = model;
  record.thinkingLevel = thinkingLevel;
  record.lastActiveAt = Date.now();
  persistDispatches(agentDir);
  return record;
}

/** Mark a delegation as asking the user a question (pixie_ask). */
export function askDispatch(
  id: string,
  question: string,
  options: string[],
  agentDir: string,
): PixieDispatch | null {
  const record = dispatches.find((d) => d.id === id);
  if (!record) return null;
  if (record.status !== "dispatched") return null;
  record.status = "awaiting_user";
  record.kind = "ask";
  record.question = question;
  record.options = options.slice(0, 10);
  record.lastActiveAt = Date.now();
  persistDispatches(agentDir);
  return record;
}

/** Route the user's answer back into the delegated session (dispatched again). */
export function reactivateDispatchAfterReply(
  id: string,
  text: string,
  agentDir: string,
): { record: PixieDispatch; text: string } | { error: string } {
  const record = dispatches.find((d) => d.id === id);
  if (!record) return { error: "委派记录不存在" };
  if (record.status !== "awaiting_user") return { error: "该委派不在等待答复状态" };
  record.status = "dispatched";
  record.kind = null;
  record.lastActiveAt = Date.now();
  persistDispatches(agentDir);
  return { record, text };
}

/** Does this workspace session have a live delegation awaiting its report? */
export function hasActiveDispatchFor(sessionId: string): boolean {
  return dispatches.some(
    (d) =>
      (d.status === "dispatched" ||
        d.status === "paused" ||
        d.status === "awaiting_user" ||
        d.status === "queued") &&
      d.sessionId === sessionId,
  );
}

/** Find a dispatched record by session id (first match, oldest active wins). */
export function findDispatchBySession(sessionId: string): PixieDispatch | undefined {
  return dispatches.find((d) => d.status === "dispatched" && d.sessionId === sessionId);
}

/** Queued dispatches for a session, in enqueue order (drain head-first). */
export function queuedDispatchesFor(sessionId: string): PixieDispatch[] {
  return dispatches
    .filter((d) => d.status === "queued" && d.sessionId === sessionId)
    .sort((left, right) => left.createdAt - right.createdAt);
}

/** Live (busy-holding) dispatch for a session: the queue gate reads this. */
export function liveDispatchFor(sessionId: string): PixieDispatch | undefined {
  return dispatches.find(
    (d) =>
      (d.status === "dispatched" || d.status === "paused" || d.status === "awaiting_user") &&
      d.sessionId === sessionId,
  );
}

export function findDispatchById(id: string): PixieDispatch | undefined {
  return dispatches.find((d) => d.id === id);
}

export function listDispatches(limit: number, agentDir?: string): PixieDispatchRecord[] {
  if (agentDir) loadDispatches(agentDir);
  markStaleDispatches();
  return dispatches.slice(0, Math.max(1, limit)).map((d) => ({ ...d }));
}

/* ── 段与运行器 ──────────────────────────────────────────────────── */

type PixieSegmentRuntime = {
  record: PixieSegmentRecord;
  session: AgentSession;
  lastError: string | null;
};

type PixieRunner = {
  agentDir: string;
  timeline: PixieTimelineFile;
  current: PixieSegmentRuntime | null;
  /** Set by pixie_rest / 打个盹 / rollover; finalized on agent_settled. */
  pendingRest: {
    phrase: string | null;
    handoff: string | null;
    reason: PixieSegmentReason;
  } | null;
  /** 打个盹 requested while the pixie decides; forced finalize on settle. */
  pendingUserRest: boolean;
  /** User prompts injected into the current segment (rollover budget). */
  turnsInCurrentSegment: number;
  /** Segment ids whose JSONL could not be reopened after a Host restart. */
  resumeFailed: Set<string>;
  knownWorkspaces: string[];
  unsubscribeSettle: (() => void) | null;
};

let runner: PixieRunner | null = null;

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function randomSleepPhrase(): string {
  return SLEEP_PHRASES[Math.floor(Math.random() * SLEEP_PHRASES.length)]!;
}

/** Ensure the runner exists for this agentDir (timeline loaded, no session). */
function ensureRunner(agentDir: string): PixieRunner {
  if (runner && runner.agentDir === agentDir) return runner;
  runner = {
    agentDir,
    timeline: loadTimeline(agentDir),
    current: null,
    pendingRest: null,
    pendingUserRest: false,
    turnsInCurrentSegment: 0,
    resumeFailed: new Set(),
    knownWorkspaces: loadKnownWorkspaces(agentDir),
    unsubscribeSettle: null,
  };
  return runner;
}

function workspaceSettingsManager(pixieCwd: string, agentDir: string): SettingsManager {
  // Same project-trust probing as workspace graph builds: the pixie workspace
  // is Host-owned, so "never" is the only state that disables project scope.
  const globalSettings = SettingsManager.create(pixieCwd, agentDir, { projectTrusted: false });
  return SettingsManager.create(pixieCwd, agentDir, {
    projectTrusted: globalSettings.getDefaultProjectTrust() !== "never",
  });
}

/**
 * Create one standard pixie segment session: standard loading (project + user
 * scope — the pi-pixie extension joins and registers dispatch/rest by cwd),
 * the one and only host session factory, and the standard session storage
 * (`SessionManager.create(cwd)` → `<agentDir>/sessions/<key>/`).
 */
async function createSegmentSession(
  agentDir: string,
  pixieCwd: string,
): Promise<AgentSession> {
  const settingsManager = workspaceSettingsManager(pixieCwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: pixieCwd, agentDir, settingsManager });
  await resourceLoader.reload();
  const sessionManager = SessionManager.create(pixieCwd);
  const created = await createHostAgentSession({
    cwd: pixieCwd,
    agentDir,
    modelRuntime: requireHostModelRuntime(),
    settingsManager,
    resourceLoader,
    sessionManager,
    modelRef: parsePixieModelRef(process.env.PIABYSS_PIXIE_MODEL),
  });
  try {
    created.session.setSessionName(PIXIE_SESSION_NAME);
  } catch {
    /* cosmetic */
  }
  return created.session;
}

/** Reopen the latest open segment after a Host restart (SessionManager.open). */
async function resumeSegmentSession(
  agentDir: string,
  pixieCwd: string,
  sessionPath: string,
): Promise<AgentSession> {
  const settingsManager = workspaceSettingsManager(pixieCwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: pixieCwd, agentDir, settingsManager });
  await resourceLoader.reload();
  const sessionManager = SessionManager.open(sessionPath);
  const created = await createHostAgentSession({
    cwd: pixieCwd,
    agentDir,
    modelRuntime: requireHostModelRuntime(),
    settingsManager,
    resourceLoader,
    sessionManager,
    modelRef: parsePixieModelRef(process.env.PIABYSS_PIXIE_MODEL),
  });
  return created.session;
}

/** The settle listener: finalizes pending rests at the run boundary. */
function subscribeSettle(state: PixieRunner, session: AgentSession): void {
  state.unsubscribeSettle?.();
  state.unsubscribeSettle = session.subscribe((event) => {
    if (event.type !== "agent_settled") return;
    const pending = state.pendingRest ?? (state.pendingUserRest
      ? { phrase: null, handoff: null, reason: "user" as const }
      : null);
    state.pendingRest = null;
    state.pendingUserRest = false;
    if (!pending || !state.current) return;
    finalizeCurrentSegment(state, pending);
  });
}

/** Close the current segment record (timeline write + event). */
function finalizeCurrentSegment(
  state: PixieRunner,
  pending: { phrase: string | null; handoff: string | null; reason: PixieSegmentReason },
): void {
  const current = state.current;
  if (!current) return;
  current.record.endedAt = Date.now();
  current.record.separator = pending.phrase?.trim() || randomSleepPhrase();
  current.record.reason = pending.reason;
  current.record.handoff = pending.handoff?.trim() || null;
  saveTimeline(state.agentDir, state.timeline);
  state.unsubscribeSettle?.();
  state.unsubscribeSettle = null;
  state.current = null;
  state.pendingRest = null;
  state.pendingUserRest = false;
  state.turnsInCurrentSegment = 0;
  logger.info("Pixie segment finalized", {
    segmentId: current.record.id,
    reason: pending.reason,
    separator: current.record.separator,
  });
  emit("pixie.segmentChanged", { segmentId: current.record.id, phase: "ended" });
}

/** Create a fresh segment (record + standard session + settle listener). */
async function startNewSegment(
  state: PixieRunner,
  reason: PixieSegmentReason,
): Promise<PixieSegmentRuntime> {
  const pixieCwd = resolvePixieWorkspacePath(state.agentDir);
  mkdirSync(pixieCwd, { recursive: true });
  const session = await createSegmentSession(state.agentDir, pixieCwd);
  const record: PixieSegmentRecord = {
    id: randomId("seg"),
    sessionId: session.sessionId,
    sessionPath: session.sessionFile ?? "",
    startedAt: Date.now(),
    endedAt: null,
    separator: null,
    reason: null,
    handoff: null,
  };
  state.timeline.segments.push(record);
  saveTimeline(state.agentDir, state.timeline);
  const runtime: PixieSegmentRuntime = { record, session, lastError: null };
  state.current = runtime;
  state.turnsInCurrentSegment = 0;
  subscribeSettle(state, session);
  emit("pixie.segmentChanged", { segmentId: record.id, phase: "started" });
  return runtime;
}

/**
 * Ensure a live current segment: resume the latest open segment after a Host
 * restart, or return the in-memory one. Never CREATES a segment — creation
 * happens on the next user message (lazy, matching 搬家即睡觉 semantics).
 */
async function ensureCurrentSegment(agentDir: string): Promise<PixieSegmentRuntime | null> {
  const state = ensureRunner(agentDir);
  if (state.current) return state.current;
  const last = state.timeline.segments[state.timeline.segments.length - 1];
  if (!last || last.endedAt !== null || state.resumeFailed.has(last.id)) return null;
  try {
    const pixieCwd = resolvePixieWorkspacePath(agentDir);
    mkdirSync(pixieCwd, { recursive: true });
    const session = await resumeSegmentSession(agentDir, pixieCwd, last.sessionPath);
    const runtime: PixieSegmentRuntime = { record: last, session, lastError: null };
    state.current = runtime;
    state.turnsInCurrentSegment = messagesOf(session).filter((m) => m.role === "user").length;
    subscribeSettle(state, session);
    logger.info("Pixie segment resumed after restart", { segmentId: last.id });
    return runtime;
  } catch (err) {
    state.resumeFailed.add(last.id);
    logger.warn("Failed to resume pixie segment; it renders as archived", {
      segmentId: last.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Built-in identity + handoff + known-workspaces preamble for a new segment. */
function buildSegmentContextPreamble(agentDir: string, handoff: string | null): string {
  const workspaces = knownWorkspacesOf(agentDir);
  const lines = [
    "[pixie|ui]",
    "<pixie-context>",
    "你是小精灵，PiAbyss 桌面里的常驻小助手。语气轻快自然、回答简洁直接；轻活直接答，重活用 pixie_dispatch 委派给对应工作区的会话执行。",
    "回调处理约定：收到 <pixie-report>（完成）→ 只转述不代写总结，并检查相关备忘录是否需要回填；收到 <pixie-error>（报错）→ 决策：原样重试 / 调整委派词再派 / 如实向用户报告；收到 <pixie-ask>（询问）→ 立即把问题转述给用户（不要代答），用户会直接在小精灵对话里回复，你收到的下一条用户消息就是答复。",
    "模型与推理深度授权：委派和插话默认不传 model/thinkingLevel（跟随会话当前设置）。仅当用户在对话中明确指定了模型或推理深度（如「用 xxx 模型跑」「思考深度调到 high」）时，才把对应参数传给 pixie_dispatch / pixie_interject；未经用户明确授权，绝不得主动更换模型或推理深度。",
    "委派目标 cwd 必须来自下方已知工作区列表（或用户当前打开的工作区）；用户手动指令的优先级最高。",
    ...(handoff ? [`刚睡醒。上一段的小结：${handoff}`] : []),
    ...(workspaces.length > 0
      ? ["已知的 PiAbyss 工作区：", ...workspaces.map((path) => `- ${path}`)]
      : []),
    "</pixie-context>",
  ];
  return lines.join("\n");
}

/**
 * Unified prompt-injection entry for the CURRENT segment (UI 通道 [pixie|ui]，
 * 未来网关 [pixie|tg]，控制面 inject)。Handles: lazy new segment (with the
 * context preamble), rollover budget, and busy refusal for interactive sends.
 */
async function deliverToCurrentSegment(args: {
  agentDir: string;
  text: string;
  source: "ui" | "tg" | "system";
  /** Interactive send → refuse when busy; callback/envelope → steer in. */
  interactive: boolean;
}): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  const state = ensureRunner(args.agentDir);
  let current = await ensureCurrentSegment(args.agentDir);
  if (current && state.pendingRest === null && state.pendingUserRest === false) {
    if (state.turnsInCurrentSegment >= pixieSegmentMaxTurns()) {
      // Turn budget exhausted: close with a rollover phrase; the next block
      // creates the fresh segment.
      finalizeCurrentSegment(state, { phrase: null, handoff: null, reason: "rollover" });
      current = null;
    }
  }
  const preamble =
    !current || current.record.endedAt !== null
      ? buildSegmentContextPreamble(
          args.agentDir,
          state.timeline.segments[state.timeline.segments.length - 1]?.handoff ?? null,
        )
      : null;
  if (!current || current.record.endedAt !== null) {
    try {
      current = await startNewSegment(state, "agent");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("Failed to create pixie segment session", { error: message });
      return { ok: false, error: `小精灵会话创建失败：${message}` };
    }
  }
  const session = current.session;
  if (session.isStreaming) {
    if (args.interactive) return { ok: false, error: "上一条回复还在生成中" };
    // Non-interactive envelopes must not be lost: steer into the running turn.
    void session.steer(`${preamble ? `${preamble}\n` : ""}[pixie|${args.source}]\n${args.text}`).catch(
      () => undefined,
    );
    return { ok: true, sessionId: session.sessionId };
  }
  const prompt = `${preamble ? `${preamble}\n` : ""}[pixie|${args.source}]\n${args.text}`;
  state.turnsInCurrentSegment += 1;
  current.lastError = null;
  void session.prompt(prompt).catch((error: unknown) => {
    current!.lastError = error instanceof Error ? error.message : String(error);
  });
  return { ok: true, sessionId: session.sessionId };
}

/** Send a user message from the desktop UI (fire-and-forget like schedule). */
export async function sendPixieMessage(args: {
  agentDir: string;
  text: string;
}): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  return deliverToCurrentSegment({ ...args, source: "ui", interactive: true });
}

/** Inject a gateway/inject-endpoint message (non-interactive). */
export async function injectPixieMessage(args: {
  agentDir: string;
  text: string;
  source: "ui" | "tg" | "system";
}): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  return deliverToCurrentSegment({ ...args, interactive: false });
}

/** 打个盹 button (pixie.newSegment): instruct the pixie, force on refusal. */
export async function requestPixieSegment(args: { agentDir: string }): Promise<{ ok: true }> {
  const state = ensureRunner(args.agentDir);
  const current = await ensureCurrentSegment(args.agentDir);
  if (!current) return { ok: true }; // nothing open: the next message starts fresh
  state.pendingUserRest = true;
  const instruction = [
    "[pixie|ui]",
    "<pixie-nap-request>",
    "用户请你打个盹。请调用 pixie_rest 工具收尾本段：phrase 填你喜欢的睡觉短语，handoff 用一句话写给下一段自己的交接摘要。",
    "</pixie-nap-request>",
  ].join("\n");
  const session = current.session;
  if (session.isStreaming) {
    void session.steer(instruction).catch(() => undefined);
    return { ok: true };
  }
  void session.prompt(instruction).catch(() => undefined);
  return { ok: true };
}

/** pixie_rest tool landing (control plane): rest at the next run boundary. */
export async function requestPixieRest(args: {
  agentDir: string;
  phrase?: string | null;
  handoff?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const state = ensureRunner(args.agentDir);
  const current = await ensureCurrentSegment(args.agentDir);
  if (!current) return { ok: false, error: "当前没有进行中的会话段" };
  state.pendingRest = {
    phrase: args.phrase?.trim() || null,
    handoff: args.handoff?.trim() || null,
    reason: "agent",
  };
  state.pendingUserRest = false;
  return { ok: true };
}

/* ── 消息投影 ────────────────────────────────────────────────────── */

/** Project a session message into the wire shape (schedule runner projection). */
function toPixieMessage(message: {
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
}): PixieAgentMessage | null {
  const role = String(message.role ?? "unknown");
  let text = "";
  const thoughts: string[] = [];
  let blocks: unknown[] = [];
  const content = message.content;
  if (typeof content === "string") {
    text = content.trim();
    blocks = text ? [{ type: "text", text }] : [];
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    const kept: unknown[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; text?: string; thinking?: string };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "thinking" && typeof b.thinking === "string") thoughts.push(b.thinking);
      kept.push(block);
    }
    text = parts.join("\n").trim();
    blocks = kept;
  }
  if (!text && thoughts.length === 0 && blocks.length === 0) return null;
  const out: PixieAgentMessage = { role, text };
  if (thoughts.length > 0) out.reasoning = thoughts.join("\n\n").trim();
  if (blocks.length > 0) out.content = blocks;
  if (typeof message.toolCallId === "string") out.toolCallId = message.toolCallId;
  if (typeof message.toolName === "string") out.toolName = message.toolName;
  if (message.isError === true) out.isError = true;
  return out;
}

function messagesOf(session: AgentSession): PixieAgentMessage[] {
  const raw = session.messages as unknown as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(raw)) return [];
  const out: PixieAgentMessage[] = [];
  for (const message of raw) {
    const projected = toPixieMessage(message);
    if (projected) out.push(projected);
  }
  return out;
}

/** Minimal JSONL transcript read for archived/non-resident segments. */
export function pixieTranscriptFrom(sessionPath: string): PixieAgentMessage[] {
  if (!sessionPath || !existsSync(sessionPath)) return [];
  let raw = "";
  try {
    raw = readFileSync(sessionPath, "utf8");
  } catch {
    return [];
  }
  const out: PixieAgentMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.type !== "message") continue;
    const message = (parsed.message ?? {}) as Record<string, unknown>;
    const projected = toPixieMessage(message);
    if (projected) out.push(projected);
  }
  return out;
}

/** Strip the `[pixie|…]` channel marker for display (first line only). */
export function stripPixieSourceMarker(text: string): string {
  return text.replace(/^\[pixie\|[a-z]+\]\n?/, "");
}

/**
 * One-line progress inferred from the delegated session's tail messages
 * (查岗/错误推送的「已完成进度」；不依赖 agent 主动汇报). Prefers the last
 * assistant text, falls back to the last tool call name.
 */
export function summarizeDelegatedProgress(session: AgentSession | null): string | null {
  if (!session) return null;
  try {
    const messages = messagesOf(session);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]!;
      if (message.role === "assistant" && message.text.trim()) {
        const text = message.text.trim().replaceAll(/\s+/g, " ");
        return text.length > 200 ? `${text.slice(0, 200)}…` : text;
      }
      if (message.role === "assistant" && message.toolName) {
        return `正在调用工具：${message.toolName}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Error-type short tag for the failure decision flow (7.1). */
export function classifyError(raw: string): string {
  if (/rate.?limit|429|quota/i.test(raw)) return "rate_limit";
  if (/abort|interrupt|cancel/i.test(raw)) return "aborted";
  if (/timeout|ETIMEDOUT|ECONN/i.test(raw)) return "network";
  if (/auth|401|403|api.?key/i.test(raw)) return "auth";
  return "tool_error";
}

/* ── 状态（pixie.state）──────────────────────────────────────────── */

/** Full pixie state for the frontend: segment timeline + delegation registry. */
export function pixieState(agentDir: string): {
  resident: boolean;
  sessionPath: string | null;
  running: boolean;
  error: string | null;
  messages: PixieAgentMessage[];
  segments: (PixieSegmentRecord & { messages: PixieAgentMessage[] })[];
  askPending: boolean;
  modelName: string | null;
  dispatches: PixieDispatchRecord[];
} {
  const state = ensureRunner(agentDir);
  loadDispatches(agentDir);
  markStaleDispatches();
  // Best-effort resume of the latest open segment (Host restart path). Never
  // creates a session; failure degrades to the archived placeholder.
  const current = state.current;
  const segmentViews = state.timeline.segments.map((record) => {
    const isCurrent = current !== null && current.record.id === record.id;
    return {
      ...record,
      messages: isCurrent ? messagesOf(current.session) : pixieTranscriptFrom(record.sessionPath),
    };
  });
  return {
    resident: current !== null,
    sessionPath: current?.record.sessionPath ?? null,
    running: current?.session.isStreaming ?? false,
    error: current?.lastError ?? null,
    messages: current ? messagesOf(current.session) : [],
    segments: segmentViews,
    askPending: dispatches.some((d) => d.status === "awaiting_user"),
    modelName: current?.session.model
      ? `${current.session.model.provider}/${current.session.model.id}`
      : null,
    dispatches: dispatches.slice(0, 20).map((d) => ({ ...d })),
  };
}

export function abortPixie(): boolean {
  if (!runner?.current) return false;
  void runner.current.session.abort().catch(() => undefined);
  return true;
}

/* ── 回调回流（done / error / ask → 小精灵会话）────────────────────── */

/**
 * Deliver a settled delegation back into the CURRENT pixie segment as a
 * user-turn envelope. The record is already mutated by the caller
 * (settleDispatch / failDispatch / askDispatch); this only handles the
 * feedback prompt + event emission.
 */
export async function deliverDispatchCallback(args: {
  agentDir: string;
  record: PixieDispatch;
  kind: PixieDispatchKind;
  summary: string;
  options?: string[];
  /** 产物/变更文件清单（progress/done 回调透传）。 */
  files?: string[] | null;
  /** error 专用：被委派会话存活状态（失败决策流）。 */
  sessionAlive?: PixieSessionAlive;
  /** error 专用：错误类型短标签。 */
  errorType?: string | null;
  /** error 专用：失败前的已完成进度。 */
  progress?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const record = args.record;
  const filesBlock =
    args.files && args.files.length > 0
      ? ["产物/变更文件：", ...args.files.slice(0, 20).map((file) => `- ${file}`)]
      : [];
  let envelope: string[];
  if (args.kind === "ask") {
    envelope = [
      `<pixie-ask dispatchId="${record.id}">`,
      `被委派会话（目标 cwd：${record.cwd}）需要用户决策，已暂停等待答复：`,
      `问题：${args.summary}`,
      ...(record.options.length > 0
        ? ["可选项：", ...record.options.map((option) => `- ${option}`)]
        : []),
      "请立即把问题转述给用户（不要代答）。用户会直接在小精灵对话里回复，你收到的下一条用户消息就是答复。",
      "</pixie-ask>",
    ];
  } else if (args.kind === "error") {
    const failCount = record.failCount;
    const alive = args.sessionAlive ?? "dead";
    const aliveText =
      alive === "alive"
        ? "会话还活着，可原地续跑（用 pixie_retry 工具 mode=resume 从断点继续，上下文零丢失）"
        : alive === "stopped"
          ? "会话被用户手动叫停，这是主动操作，不要自动重碰，如实向用户报告即可"
          : "会话已不在宿主内存（可能已重启或已结束），需评估上下文能否恢复：可用 pixie_retry 工具 mode=redispatch 重派，或如实向用户报告";
    const escalate =
      failCount >= 3
        ? `⚠️ 该任务已连续失败 ${failCount} 次：请停止自动重试，把全部现场（任务、目标、每次失败原因、进度）整理后升级报告给用户，由用户决定后续。`
        : "请按会话状态决策：可续跑→原地续跑；方向性错误→调整委派词重派；无法自行判断→如实向用户报告。";
    envelope = [
      `<pixie-error dispatchId="${record.id}">`,
      `委派任务执行失败（目标 cwd：${record.cwd}，第 ${failCount} 次失败）：`,
      `错误类型：${args.errorType ?? classifyError(args.summary)}`,
      `原始错误：${args.summary}`,
      ...(args.progress ? [`已完成进度：${args.progress}`] : []),
      ...filesBlock,
      `会话状态：${aliveText}`,
      escalate,
      "</pixie-error>",
    ];
  } else if (args.kind === "progress") {
    envelope = [
      `<pixie-progress dispatchId="${record.id}">`,
      `被委派会话（目标 cwd：${record.cwd}）的进度汇报：`,
      args.summary,
      ...filesBlock,
      record.status === "paused"
        ? "该任务已按用户要求暂停，等待用户下一步指令；请把进度转述给用户并等待。"
        : "请把进度转述给用户（轻量即可，不必展开）；任务仍在继续执行。",
      "</pixie-progress>",
    ];
  } else if (args.kind === "stopped") {
    envelope = [
      `<pixie-stopped dispatchId="${record.id}">`,
      `委派任务（目标 cwd：${record.cwd}）已被用户叫停：${args.summary}`,
      "请向用户确认已停止；不要自动重发该任务。",
      "</pixie-stopped>",
    ];
  } else {
    envelope = [
      `<pixie-report dispatchId="${record.id}">`,
      `被委派会话已回调（目标 cwd：${record.cwd}）：`,
      args.summary,
      ...filesBlock,
      "请把上述结果整理后转述给用户（只转述，不代写总结），并检查相关备忘录是否需要回填。",
      "</pixie-report>",
    ];
  }
  const delivered = await deliverToCurrentSegment({
    agentDir: args.agentDir,
    text: envelope.join("\n"),
    source: "system",
    interactive: false,
  });
  if (!delivered.ok) {
    // Registry already settled by the mutator; the pixie just misses the live
    // envelope (she was busy). Not an error for the delegated side.
    logger.warn("Pixie callback could not be delivered", {
      dispatchId: record.id,
      error: delivered.error,
    });
  }
  if (args.kind === "ask") {
    emit("pixie.askReceived", {
      dispatchId: record.id,
      question: args.summary,
      options: record.options,
    });
  } else {
    emit("pixie.reportReceived", {
      dispatchId: record.id,
      summary: args.summary,
      kind: args.kind,
      ...(args.files && args.files.length > 0 ? { files: args.files.slice(0, 20) } : {}),
      ...(args.kind === "error"
        ? {
            sessionAlive: args.sessionAlive ?? "dead",
            failCount: record.failCount,
            errorType: args.errorType ?? classifyError(args.summary),
            progress: args.progress ?? record.progressSummary,
          }
        : {}),
    });
  }
  return { ok: true };
}

/* ── 兼容残留 ────────────────────────────────────────────────────── */

/** Legacy no-op hook (the v3 env-window marker; kept for type stability). */
export const PIXIE_RESIDENT_LEGACY_ENV = "PIABYSS_PIXIE_RESIDENT";

/** Read the persisted known-workspace list (dispatch engine gating uses it). */
export function getKnownWorkspaces(agentDir: string): string[] {
  return knownWorkspacesOf(agentDir);
}

/** @internal test seam: clear all module-level pixie state (registry+runner). */
export function resetPixieStateForTests(): void {
  stopPixieStaleWatcher();
  dispatches.length = 0;
  dispatchesLoadedFor = null;
  dispatchesDirty = false;
  runner = null;
  emitServerEvent = null;
}
