/**
 * Pixie (小精灵) workspace runner — the Host-owned helper agent over a REAL
 * folder workspace (`<agentDir>/workspace/pixie`, or the plugin-configured
 * `PI_PIXIE_WORKSPACE`; legacy `PIABYSS_PIXIE_WORKSPACE` still works).
 *
 * v4 "workspace-ification": every conversation segment is a STANDARD session
 * stored at `<agentDir>/sessions/<workspaceKey(pixieCwd)>/<id>.jsonl` through
 * the one and only `createHostAgentSession` factory (standard project+user
 * scope loading — the pi-pixie extension joins naturally and registers its
 * tools when its cwd matches). A small timeline file
 * (`<agentDir>/piabyss/pixie/timeline.json`) keeps segment POINTERS only;
 * rendering always reads the session JSONL, so fork/archive/search semantics
 * come for free and a missing file degrades to an archived placeholder.
 *
 * v6「段由用户开」: there is no napping and no automatic segment switch. A new
 * segment is whatever session the pixie workspace created LAST (by header
 * timestamp, not by last-write) — normally the one the sidebar 新会话 button
 * just made. Acquisition reconciles the pointer against the session directory
 * and adopts that newest segment, so delegation callbacks and the page anchor
 * follow the segment the user is actually in. Cross-segment memory is the
 * plugin's job (`pixie-segments` card +
 * `pixie_recall`), reading the same JSONL files — the Host keeps no summary.
 *
 * The delegation registry (dispatch records) also lives here now, persisted
 * to `dispatches.json` and extended with the three callback kinds:
 * done / error (settled by pixie_report, turn-end auto-fallback, or failure)
 * and ask (pixie_ask → awaiting_user → user reply routed back via followUp).
 */
/**
 * Pixie (小精灵) runner — v5「回标准控制面」。
 *
 * 小精灵不再是自管会话的旁路体系：她的当前会话就是 workspace/pixie 这个真实
 * 工作区图里的一个标准会话（活动槽位或后台驻留），与普通会话共用同一套快照
 * 推送、事件流与 session.open 语义；桌面端的小精灵页面只是普通工作区视图的
 * 一层主题皮肤。runner 保留的只有 Host 自动化职责：
 *
 *   1. 当前会话指针（pixie-state.json；v4 timeline.json 首启自动迁移）——每次
 *      取段前与工作区会话目录对账，「创建时间最新的会话」就是当前段；
 *   2. 当前段缺失时在图内建会话（前台时 promoteBackgroundRuntime，快照自动推给
 *      前端）；换段本身由用户在界面里「新会话」触发，Host 不主动换段；
 *   3. 委派回调与控制面 inject 的信封投递（session.prompt/steer，与委派落点
 *      同一机制）；回调优先送回派单的那一段；
 *   4. 段指针与已知工作区的落盘（`setPixieContext` → `context.json`）：
 *      `<pixie-context>` 运行契约与时间锚点已搬到 pi-pixie 插件注入，Host
 *      不再往用户消息外层包前导。
 *
 * 委派登记表（dispatches.json，done/error/ask 回调）依旧住在这里——它跟会话
 * 所有权无关。pi-pixie 插件的环回控制面端点契约保持不变。
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  PixieAgentMessage,
  PixieDispatchKind,
  PixieDispatchRecord,
  PixieSessionAlive,
} from "@piabyss/protocol";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";
import type { WorkspaceGraph } from "./workspace-graph-types.js";
import { createHostAgentSession } from "./agent-session-factory.js";
import { buildSessionSnapshot } from "./session-snapshot.js";
import { recordPixieInteraction } from "./pixie-usage.js";
import { piabyssDataDir } from "./piabyss-data.js";
import { sessionStorageDirs } from "./session-storage.js";
import { upsertPixieSession } from "./pixie-session-cache.js";
import { openSessionIntoGraph } from "./session-lifecycle.js";
import { logger } from "./logger.js";

/** 小精灵工作区的人格文件名（SDK context files 候选之一，见下）。 */
const PIXIE_PERSONA_FILE = "CLAUDE.md";

/** SDK 认可的上下文文件名（同目录只取第一个，大小写变体也在列）。 */
const PIXIE_CONTEXT_FILE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
];

/**
 * 默认人格：首次创建小精灵工作区时写进 `<工作区>/CLAUDE.md`。
 *
 * 与 pi-pixie 插件注入的 `<pixie-context>` 分工：
 * - 这里 = **人格与工作方式**（身份、语气、分工、指挥台怎么用）——可以直接手改，
 *   改完从下一个新段生效（SDK 的 context files 在段会话创建/恢复时 reload）。
 * - 那边 = **与 Host 行为绑定的契约 + 运行期数据**（落点规则、排队、回调总则、
 *   模型授权、已知工作区列表）——必须跟实现同源，不放文件里。
 */
const PIXIE_PERSONA_TEMPLATE = `# 小精灵（PiAbyss 常驻小助手）

> 这份文件是小精灵的**人格与工作方式**，可以直接改；改完从**下一个新段**开始生效（当段不会重载）。
> 「已知工作区列表」等运行期信息由 PiAbyss 注入，不在这里。

## 身份
你是小精灵，PiAbyss 桌面里的常驻小助手。

## 说话方式
语气轻快自然、回答简洁直接。不铺垫、不客套，先给结论；有取舍就把取舍讲清楚。

## 怎么分工
查、解释、问答这类一句话能答的直接答；要跑命令、改文件、多步推进或耗时的活，才委派给对应工作区的会话执行。

## 指挥台怎么用
- 挑会话继续派活前，先看有哪些会话可复用（含简介与最近结果）
- 派错了就叫停，别自己想办法兜底
- 跑偏了就地插话纠正——那是补充，不是新任务
- 同一任务失败了，会话还活着就地续跑，死了才重派
- 用户问「那个任务还在跑吗」，先查岗再答，别凭印象
- 用户新开一段时，段索引与上一段收尾会自动出现；要更早的细节用 pixie_recall 回读
`;

/**
 * 首次创建小精灵工作区时写一份默认人格文件。
 *
 * 「首次」用标记文件记一次：写过就永不再写——所以用户后来改了、删了都不会被覆盖或恢复。
 * 工作区里已经有任一 SDK 认可的上下文文件时也不写（尊重既有约定）。
 */
export function ensurePixiePersonaFile(agentDir: string, pixieCwd: string): void {
  try {
    const marker = join(pixieDir(agentDir), "persona-bootstrapped");
    if (existsSync(marker)) return;
    const hasContextFile = PIXIE_CONTEXT_FILE_NAMES.some((name) =>
      existsSync(join(pixieCwd, name)),
    );
    if (!hasContextFile) {
      mkdirSync(pixieCwd, { recursive: true });
      writeFileSync(join(pixieCwd, PIXIE_PERSONA_FILE), PIXIE_PERSONA_TEMPLATE, "utf8");
      logger.info("Wrote the default pixie persona file", {
        path: join(pixieCwd, PIXIE_PERSONA_FILE),
      });
    }
    writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8");
  } catch (err) {
    logger.warn("Failed to bootstrap the pixie persona file", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 段名长度上限（超出截断加省略号；会话列表本身也会 truncate）。 */
const SEGMENT_NAME_MAX_LENGTH = 40;

/** 会话名压成单行并截断（改名端点用；首句名由 session-title 那边裁）。 */
export function clipSegmentName(value: string | null | undefined): string {
  const oneLine = (value ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > SEGMENT_NAME_MAX_LENGTH
    ? `${oneLine.slice(0, SEGMENT_NAME_MAX_LENGTH)}…`
    : oneLine;
}

/* ── 短名（面板/会话名统一口径）───────────────────────────────────── */

/**
 * 任务短名与会话名的长度上限（码位，不是 UTF-16 单元——CJK 一个字算一个）。
 * 插件侧不做截断，口径全部由 Host 统一裁，保证同一份数据在任何界面一样长。
 */
const PIXIE_SHORT_NAME_LIMIT = 20;

/** 压成单行、按码位裁到 ≤20 字；裁不掉空串（输入为空时返回 ""）。 */
export function clipPixieShortName(value: string | null | undefined): string {
  const oneLine = (value ?? "").replace(/\s+/g, " ").trim();
  return Array.from(oneLine).slice(0, PIXIE_SHORT_NAME_LIMIT).join("");
}

/** 未传短名时的兜底：取 task 前 ~20 字（界面据此永远不会出现「新会话」）。 */
export function pixieFallbackName(task: string): string {
  return clipPixieShortName(task);
}

/** Registry bound: in-memory cap (matches the V1 bound). */
const MAX_DISPATCHES = 50;

/* ── 环境配置（读取时机 = 使用时机，插件库改配置即时生效）────────────── */

/** Generic PI_PIXIE_* name first, legacy PIABYSS_PIXIE_* second. */
function readPixieEnv(name: string, legacyName: string): string | undefined {
  const current = process.env[name]?.trim();
  if (current) return current;
  return process.env[legacyName]?.trim();
}

/** Resolve the pixie workspace path (plugin config → `{agentDir}` → default). */
export function resolvePixieWorkspacePath(agentDir: string): string {
  const configured = readPixieEnv("PI_PIXIE_WORKSPACE", "PIABYSS_PIXIE_WORKSPACE");
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
  const raw = Number(readPixieEnv("PI_PIXIE_STALE_MS", "PIABYSS_PIXIE_STALE_MS"));
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
}

/** Stale-warning push toggle (PI_PIXIE_STALE_NOTIFY); default on. */
function pixieStaleNotifyEnabled(): boolean {
  return (
    readPixieEnv("PI_PIXIE_STALE_NOTIFY", "PIABYSS_PIXIE_STALE_NOTIFY")?.toLowerCase() !== "off"
  );
}

/* ── 基础设施 ────────────────────────────────────────────────────── */

export function pixieDir(agentDir: string): string {
  const dir = join(piabyssDataDir(agentDir), "pixie");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Host-owned event emitter (wired in main.ts once the server exists). */
let emitServerEvent: ((event: string, payload: unknown) => void) | null = null;

export function configurePixieEventEmitter(emit: (event: string, payload: unknown) => void): void {
  emitServerEvent = emit;
}

function emit(event: string, payload: unknown): void {
  try {
    emitServerEvent?.(event, payload);
  } catch {
    /* event delivery is best-effort */
  }
}

/** The Host-owned runtime, injected once at startup (automation runner先例). */
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

/* ── 旧时间线（timeline.json：只读，供迁移与归属反推）────────────────── */

/** 旧 timeline.json 的段记录（打盹时代的产物，Host 不再写；仅迁移期读取）。 */
type PixieSegmentRecord = {
  sessionId: string;
  sessionPath: string;
  startedAt: number;
  endedAt: number | null;
};

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
        typeof record.sessionId !== "string" ||
        typeof record.sessionPath !== "string" ||
        typeof record.startedAt !== "number"
      ) {
        continue;
      }
      segments.push({
        sessionId: record.sessionId,
        sessionPath: record.sessionPath,
        startedAt: record.startedAt,
        endedAt: typeof record.endedAt === "number" ? record.endedAt : null,
      });
    }
    return { version: 1, segments };
  } catch {
    return { version: 1, segments: [] };
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
}
/**
 * 旧派发记录的归属反推（仅迁移期使用）。
 *
 * v5.1 之前记录的 originSessionId 是后补字段，老记录缺失。若直接把 null 当作
 * “所有会话都可见”，面板就退化成混合历史（每个会话都看到同样的旧记录）——
 * 正是引入归属字段要解决的问题。这里用 v4 timeline.json 的段窗口（只读，不再
 * 维护）按 createdAt 落在哪一段来反推真实归属；推不出来就保持 null（不显示）。
 */
function legacySegmentWindows(
  agentDir: string,
): { sessionId: string; startedAt: number; endedAt: number | null }[] {
  try {
    return loadTimeline(agentDir).segments.map((segment) => ({
      sessionId: segment.sessionId,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
    }));
  } catch {
    return [];
  }
}

function inferLegacyOriginSessionId(
  windows: { sessionId: string; startedAt: number; endedAt: number | null }[],
  createdAt: number,
): string | null {
  for (const window of windows) {
    if (createdAt < window.startedAt) continue;
    if (window.endedAt !== null && createdAt > window.endedAt) continue;
    return window.sessionId;
  }
  return null;
}

function loadDispatches(agentDir: string): void {
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
  // 旧记录归属反推的段窗口（惰性：只有真出现缺归属的记录才读 timeline.json）。
  let legacyWindows: { sessionId: string; startedAt: number; endedAt: number | null }[] | null =
    null;
  for (const item of records) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Partial<PixieDispatch>;
    if (typeof record.id !== "string" || typeof record.task !== "string") continue;
    const createdAt = typeof record.createdAt === "number" ? record.createdAt : Date.now();
    const recordedOrigin =
      typeof record.originSessionId === "string" && record.originSessionId
        ? record.originSessionId
        : null;
    if (recordedOrigin === null) legacyWindows ??= legacySegmentWindows(agentDir);
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
      createdAt,
      reportedAt: typeof record.reportedAt === "number" ? record.reportedAt : null,
      stale: record.stale === true,
      startedAt: typeof record.startedAt === "number" ? record.startedAt : null,
      lastActiveAt: typeof record.lastActiveAt === "number" ? record.lastActiveAt : null,
      staleNotified: record.staleNotified === true,
      batchId: typeof record.batchId === "string" ? record.batchId : null,
      failCount:
        typeof record.failCount === "number" && Number.isSafeInteger(record.failCount)
          ? record.failCount
          : 0,
      progressSummary: typeof record.progressSummary === "string" ? record.progressSummary : null,
      files: Array.isArray(record.files)
        ? record.files.filter((file): file is string => typeof file === "string")
        : null,
      retryOf: typeof record.retryOf === "string" ? record.retryOf : null,
      model: typeof record.model === "string" ? record.model : null,
      thinkingLevel: typeof record.thinkingLevel === "string" ? record.thinkingLevel : null,
      // 归属段：老记录缺字段 → 用 v4 段窗口按时间反推；推不出=null（不显示）。
      originSessionId: recordedOrigin ?? inferLegacyOriginSessionId(legacyWindows ?? [], createdAt),
      // v0.5.0 起插件才会传短名；老记录缺字段一律 null（展示层用 task 兜底）。
      taskName: typeof record.taskName === "string" && record.taskName ? record.taskName : null,
      sessionName:
        typeof record.sessionName === "string" && record.sessionName ? record.sessionName : null,
      dispatchMessageId:
        typeof record.dispatchMessageId === "string" && record.dispatchMessageId
          ? record.dispatchMessageId
          : null,
      reportMessageId:
        typeof record.reportMessageId === "string" && record.reportMessageId
          ? record.reportMessageId
          : null,
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
      record.status === "dispatched" ||
      record.status === "paused" ||
      record.status === "awaiting_user";
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

export function startPixieStaleWatcher(factory: WorkspaceGraphFactory): void {
  const agentDir = factory.deps.agentDir;
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
  /** 发起委派时小精灵所在会话段（面板按段过滤的归属键；null = 无归属）。 */
  originSessionId?: string | null;
  /** 任务短名（引擎已裁到 ≤20 字；null = 旧版插件未传，展示层用 task 兜底）。 */
  taskName?: string | null;
  /** 本次新建会话所采用的会话名；复用既有会话为 null（绝不覆盖会话名）。 */
  sessionName?: string | null;
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
    originSessionId: input.originSessionId ?? null,
    taskName: input.taskName ?? null,
    sessionName: input.sessionName ?? null,
    dispatchMessageId: null,
    reportMessageId: null,
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
  if (
    record.status !== "dispatched" &&
    record.status !== "paused" &&
    record.status !== "awaiting_user"
  )
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

export function configurePixieTerminalSettleHook(hook: (sessionId: string | null) => void): void {
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
  if (
    record.status !== "dispatched" &&
    record.status !== "paused" &&
    record.status !== "awaiting_user"
  )
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
  if (
    record.status !== "dispatched" &&
    record.status !== "paused" &&
    record.status !== "awaiting_user"
  )
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
  if (
    record.status !== "dispatched" &&
    record.status !== "paused" &&
    record.status !== "awaiting_user"
  )
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

/**
 * 重复提交检测：同一工作区 + 逐字相同的任务文本，在窗口内已有活跃记录。
 * 环回超时后小精灵按「失败」原样重试，而第一次多半已经受理成功——这条查询让
 * 引擎能把第二次请求认成同一次派发，而不是再开一个会话跑第二遍。
 */
export function findDuplicateDispatchRequest(input: {
  agentDir: string;
  cwd: string;
  task: string;
  withinMs: number;
  now?: number;
}): PixieDispatch | null {
  loadDispatches(input.agentDir);
  const now = input.now ?? Date.now();
  for (const record of dispatches) {
    if (now - record.createdAt > input.withinMs) continue;
    if (!isLiveDispatchRecord(record)) continue;
    if (record.cwd === input.cwd && record.task === input.task) return record;
  }
  return null;
}

export function findDispatchById(id: string): PixieDispatch | undefined {
  return dispatches.find((d) => d.id === id);
}

/** 当前小精灵会话段的指针（轻量：只读 pixie-state.json，不建图不写盘）。 */
export function currentPixieSessionId(agentDir: string): string | null {
  return ensureRunner(agentDir).pointer.sessionId;
}

/** 活跃（未到终态）的委派：跨段都必须可见可操作。 */
function isLiveDispatchRecord(record: PixieDispatch): boolean {
  return (
    record.status === "dispatched" ||
    record.status === "queued" ||
    record.status === "paused" ||
    record.status === "awaiting_user"
  );
}

/**
 * 委派面板列表（pixie.dispatches RPC）：与「当前打开的小精灵会话」关联的
 * 全量委派。关联语义：
 *   - 活跃委派（dispatched/queued/paused/awaiting_user）→ 一律显示：回调注入
 *     的是当前段，跨段活跃任务不能失踪，否则用户看不到也叫不停；
 *   - 终态委派 → 只有 originSessionId 命中当前会话才显示（历史按会话归档）。
 * 不截断：当前会话的全量就是面板要的"全量关联"。
 *
 * currentSessionId=null（拿不到会话上下文）时只显示活跃委派——宁可少显示，
 * 也不能把别的会话的历史混进来。
 */
export function listDispatchesForPanel(
  agentDir: string,
  currentSessionId: string | null,
): PixieDispatchRecord[] {
  loadDispatches(agentDir);
  return dispatches
    .filter(
      (d) =>
        isLiveDispatchRecord(d) ||
        (currentSessionId !== null && d.originSessionId === currentSessionId),
    )
    .map((d) => ({ ...d }));
}

export function listDispatches(limit: number, agentDir?: string): PixieDispatchRecord[] {
  if (agentDir) loadDispatches(agentDir);
  markStaleDispatches();
  return dispatches.slice(0, Math.max(1, limit)).map((d) => ({ ...d }));
}

/* ── 运行器 v6：当前段 = 工作区里创建最新的那条会话 ─────────────────── */

type PixiePointer = {
  sessionId: string | null;
  sessionPath: string | null;
  /** 当前段的创建时间（ms）；对账时与盘上各段的 header 时间比。 */
  createdMs: number;
};

type PixieRunner = {
  agentDir: string;
  /** 当前段缓存；权威是会话目录里创建最新的一条（reconcilePointer）。 */
  pointer: PixiePointer;
  unsubscribeSettle: (() => void) | null;
  settleSessionId: string | null;
  /** Single-flight for graph acquisition（轮询/投递/页面打开可能并发触发）. */
  acquireInFlight: Promise<PixieAcquisition | null> | null;
  knownWorkspaces: string[];
};

type PixieAcquisition = {
  graph: WorkspaceGraph;
  session: AgentSession;
  sessionId: string;
  sessionPath: string;
};

/** backgroundSessions / idleSessionCache 里驻留的运行时形状。 */
type PixieParkedRuntime =
  WorkspaceGraph["backgroundSessions"] extends Map<string, infer R> ? R : never;

let runner: PixieRunner | null = null;

/* ── 指针状态文件（pixie-state.json；v4 timeline.json 首启自动迁移）── */

type PixieStateFile = {
  version: 1;
  sessionId: string | null;
  sessionPath: string | null;
  createdMs?: number;
};

function pixieStatePath(agentDir: string): string {
  return join(pixieDir(agentDir), "pixie-state.json");
}

function loadRunnerState(agentDir: string): Pick<PixieRunner, "pointer"> {
  try {
    const parsed = JSON.parse(readFileSync(pixieStatePath(agentDir), "utf8")) as PixieStateFile;
    if (parsed && parsed.version === 1) {
      return {
        pointer: {
          sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
          sessionPath: typeof parsed.sessionPath === "string" ? parsed.sessionPath : null,
          createdMs: typeof parsed.createdMs === "number" ? parsed.createdMs : 0,
        },
      };
    }
  } catch {
    /* first run or unreadable */
  }
  // v4 迁移：timeline.json 里最后一段还开着（endedAt=null）→ 收编为当前指针。
  // 迁移后 timeline.json 保留不动（只读历史）。createdMs 留 0：首次取段就会按
  // 「盘上创建最新的那条」重新对账。
  try {
    const timeline = loadTimeline(agentDir);
    const last = timeline.segments[timeline.segments.length - 1];
    return {
      pointer: {
        sessionId: last?.endedAt === null ? last.sessionId : null,
        sessionPath: last?.endedAt === null ? last.sessionPath : null,
        createdMs: 0,
      },
    };
  } catch {
    return { pointer: { sessionId: null, sessionPath: null, createdMs: 0 } };
  }
}

function saveRunnerState(state: PixieRunner): void {
  try {
    mkdirSync(pixieDir(state.agentDir), { recursive: true });
    const file: PixieStateFile = {
      version: 1,
      sessionId: state.pointer.sessionId,
      sessionPath: state.pointer.sessionPath,
      createdMs: state.pointer.createdMs,
    };
    writeFileSync(pixieStatePath(state.agentDir), `${JSON.stringify(file, null, 2)}\n`, "utf8");
  } catch (err) {
    logger.warn("Failed to persist the pixie state file", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Ensure the runner exists for this agentDir (state loaded, no session). */
function ensureRunner(agentDir: string): PixieRunner {
  if (runner && runner.agentDir === agentDir) return runner;
  const loaded = loadRunnerState(agentDir);
  runner = {
    agentDir,
    pointer: loaded.pointer,
    unsubscribeSettle: null,
    settleSessionId: null,
    acquireInFlight: null,
    knownWorkspaces: loadKnownWorkspaces(agentDir),
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

/** 把小精灵自己的会话登记进会话缓存（归属 pixie；失败不阻断）。 */
function rememberPixieSegmentSession(
  agentDir: string,
  pixieCwd: string,
  session: { sessionId: string; sessionFile?: string | null },
): void {
  try {
    upsertPixieSession(agentDir, {
      sessionId: session.sessionId,
      sessionPath: session.sessionFile ?? "",
      cwd: pixieCwd,
      owner: "pixie",
      role: "pixie",
      summary: "小精灵工作区会话段",
    });
  } catch {
    /* 缓存写入失败不影响会话本身 */
  }
}

/* ── 图解析与会话落位 ───────────────────────────────────────────── */

/** 小精灵工作区图：已绑定直接用；否则后台建图（Host 自有工作区，无门槛）。 */
async function ensurePixieGraph(
  factory: WorkspaceGraphFactory,
  agentDir: string,
): Promise<WorkspaceGraph | null> {
  const pixieCwd = resolvePixieWorkspacePath(agentDir);
  try {
    mkdirSync(pixieCwd, { recursive: true });
  } catch {
    /* exists */
  }
  const canonical = factory.canonicalizeCwd(pixieCwd);
  const bound = factory.findBoundGraph(canonical);
  if (bound) return bound;
  const built = await factory.ensureBackgroundGraph(canonical);
  if ("error" in built) {
    logger.warn("Failed to ensure the pixie workspace graph", {
      error: built.error.message,
    });
    return null;
  }
  return built.graph;
}

function findCurrentRuntime(
  graph: WorkspaceGraph,
  sessionId: string,
):
  | { where: "active"; session: AgentSession }
  | { where: "parked"; runtime: PixieParkedRuntime }
  | null {
  if (graph.agentSession && graph.sessionSnapshot?.sessionId === sessionId) {
    return { where: "active", session: graph.agentSession };
  }
  const parked =
    graph.backgroundSessions.get(sessionId) ?? graph.idleSessionCache?.get(sessionId) ?? null;
  if (parked) return { where: "parked", runtime: parked };
  return null;
}

/**
 * 给停驻的小精灵图补齐前台会话位——会话的四个槽位一起补。
 *
 * 标准停驻图语义（曾经前台、被 park 的图）把活动会话留在 `graph.agentSession` +
 * `graph.sessionSnapshot`，会话管理器与事件订阅留在 `graph.sessionManager` +
 * `graph.unsubscribeAgent`——`commitReactivateRetainedGraph` 缺前两者就把整张图
 * dispose 重建。Runner 后台建的 pixie 图从未走过前台，会话只存在于
 * backgroundSessions：不补位的话，每次前台切到 pixie 工作区都会先销毁暖图、再走
 * pending shell，紧接着的 session.open 撞上未就绪的 services 返回
 * AGENT_NOT_READY（前端不重试该错误码）——即「每次进小精灵页都提示暂不可用，手动
 * 重试才好」。
 *
 * 只补会话与快照这两个槽位是错的，漏掉后两个各留下一个症状：
 *
 * - 漏 `sessionManager`：`handleAgentEvent` 按「前台会话」取
 *   `graph.sessionManager`，拿到的却是建图时那个从未用过的会话的管理器。它的
 *   `getLeafId()` 永远是 null，计时的 custom entry 于是静默丢弃，
 *   `session.getStats` 折的也是这份空 entries——速度药丸从此没有数字，「会话统计」
 *   面板里模型/工具耗时全空。
 * - 漏 `unsubscribeAgent`：重新激活会先 `graph.unsubscribeAgent?.()`（此时为
 *   null，等于没摘）再给同一会话挂一条新订阅，而 runtime 自己那个监听还活着 →
 *   同一个原始事件被处理两次，前端每个 delta 落两遍（正文逐字重复、工具数翻倍、
 *   瞬时 tok/s 虚高）。
 *
 * 所以这里把 runtime 已建好的那条订阅**共享**给图槽位（不是再挂一条）。该会话同时
 * 留在 backgroundSessions 是必要的：`graphHasResidentSessions` 靠它把这张图判为
 * 有驻留会话，park 时才不摘订阅、不挂起 provider（后台投递的委派回报要靠这条
 * 订阅才有人处理）。重新激活换订阅时由 workspace-lifecycle 把活着的那条回写给
 * runtime，两边始终指向同一条。
 *
 * 图在前台时这些槽位归标准 promote 路径（`promoteBackgroundRuntime` /
 * `session.open`）管，不要碰。
 */
function markParkedForegroundSession(
  factory: WorkspaceGraphFactory,
  graph: WorkspaceGraph,
  runtime: PixieParkedRuntime,
): void {
  if (factory.getGraph() === graph) return;
  // The session the graph was built with keeps being referenced by nothing but
  // this slot once the placement below takes over, so drop its subscription
  // first — otherwise it stays attached with no owner left to detach it.
  if (graph.unsubscribeAgent && graph.unsubscribeAgent !== runtime.unsubscribeAgent) {
    try {
      graph.unsubscribeAgent();
    } catch {
      /* best-effort */
    }
  }
  graph.agentSession = runtime.agentSession;
  graph.sessionManager = runtime.sessionManager;
  graph.sessionSnapshot = runtime.sessionSnapshot;
  graph.unsubscribeAgent = runtime.unsubscribeAgent;
}

/** 在小精灵工作区图里新建一个正式会话并驻留到 backgroundSessions。 */
async function createPixieSessionInGraph(
  factory: WorkspaceGraphFactory,
  graph: WorkspaceGraph,
  parentSession?: string | null,
): Promise<{ sessionId: string; sessionPath: string; runtime: PixieParkedRuntime }> {
  const agentDir = factory.deps.agentDir;
  const pixieCwd = graph.canonicalCwd;
  // 人格文件要在 resourceLoader 之前落盘，本次创建的会话才吃得到。
  ensurePixiePersonaFile(agentDir, pixieCwd);
  const settingsManager = workspaceSettingsManager(pixieCwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: pixieCwd, agentDir, settingsManager });
  await resourceLoader.reload();
  // parentSession 写进 header：插件的段索引与 pixie_recall 优先按它认「上一段」，
  // 没有才退回按时间猜（跨目录或被别的会话插队时会认错）。
  const sessionManager = SessionManager.create(pixieCwd, undefined, {
    ...(parentSession ? { parentSession } : {}),
  });
  const created = await createHostAgentSession({
    cwd: pixieCwd,
    agentDir,
    modelRuntime: requireHostModelRuntime(),
    settingsManager,
    resourceLoader,
    sessionManager,
    modelRef: parsePixieModelRef(readPixieEnv("PI_PIXIE_MODEL", "PIABYSS_PIXIE_MODEL")),
  });
  const session = created.session;
  // 段名不在新建时写入：首条用户消息到达时由 agent-controller 的首句兜底落名。
  // v4.3 会话缓存：小精灵自己的工作区会话也登记（role=pixie），供交代与查会话。
  rememberPixieSegmentSession(agentDir, pixieCwd, session);
  const snapshot = buildSessionSnapshot({
    session,
    sessionManager,
    cwd: pixieCwd,
    sessionId: session.sessionId,
    revision: 0,
    workspaceId: graph.workspaceId,
    toolRevision: graph.toolRevision,
  });
  const runtime: PixieParkedRuntime = {
    sessionId: session.sessionId,
    sessionRevision: 0,
    sessionManager,
    agentSession: session,
    resourceLoader,
    extensionsResult: created.extensionsResult,
    toolRevision: graph.toolRevision,
    sessionSnapshot: snapshot,
    // 与 createSession 完全同一事件接线：前台活动会话 → 全量流式；
    // 前台后台/停驻图 → handleAgentEvent 内部按规则过滤（终态/运行态）。
    unsubscribeAgent: session.subscribe((event) => factory.handleAgentEvent(graph, session, event)),
    extensionUiActivate: null,
    extensionUiCleanup: null,
    extensionUiUpdateIdentity: null,
    extensionUiReplayState: null,
  };
  graph.backgroundSessions.set(session.sessionId, runtime);
  markParkedForegroundSession(factory, graph, runtime);
  return { sessionId: session.sessionId, sessionPath: session.sessionFile ?? "", runtime };
}

/** 小精灵会话的 resource loader（不带状态桥扩展，与建段路径一致）。 */
async function createPixieResourceLoader(
  factory: WorkspaceGraphFactory,
  cwd: string,
): Promise<DefaultResourceLoader> {
  const agentDir = factory.deps.agentDir;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: workspaceSettingsManager(cwd, agentDir),
  });
  await resourceLoader.reload();
  return resourceLoader;
}

/** Host 重启后把指针指向的 JSONL 重新打开进图（等价 openSession 的驻留路径）。 */
async function openPixieSessionInGraph(
  factory: WorkspaceGraphFactory,
  graph: WorkspaceGraph,
  sessionPath: string,
): Promise<{ sessionId: string; sessionPath: string; runtime: PixieParkedRuntime }> {
  const agentDir = factory.deps.agentDir;
  const pixieCwd = graph.canonicalCwd;
  const opened = await openSessionIntoGraph(factory, graph, sessionPath, {
    // 人格文件要在 resourceLoader 之前落盘，本次打开的会话才吃得到。
    beforeOpen: () => {
      ensurePixiePersonaFile(agentDir, pixieCwd);
    },
    createResourceLoader: (cwd) => createPixieResourceLoader(factory, cwd),
    modelRef: parsePixieModelRef(readPixieEnv("PI_PIXIE_MODEL", "PIABYSS_PIXIE_MODEL")),
    // 小精灵图从未走过前台：会话四个槽位一起补（详见 markParkedForegroundSession）。
    adoptForegroundSlots: true,
    // v4.3 会话缓存：小精灵自己的工作区会话也登记（role=pixie）。
    onOpened: ({ session }) => rememberPixieSegmentSession(agentDir, pixieCwd, session),
  });
  if ("error" in opened) {
    throw new Error(opened.error.message);
  }
  return {
    sessionId: opened.sessionId,
    sessionPath: opened.sessionPath,
    runtime: opened.runtime,
  };
}

/* ── 当前段对账（创建时间最新的那条会话就是当前段）─────────────────── */

/** The settle listener: usage accounting at the run boundary. */
function subscribeSettle(state: PixieRunner, session: AgentSession): void {
  state.unsubscribeSettle?.();
  state.settleSessionId = session.sessionId;
  state.unsubscribeSettle = session.subscribe((event) => {
    if (event.type !== "agent_settled") return;
    if (state.settleSessionId !== session.sessionId) return;
    recordPixieInteraction(state.agentDir);
  });
}

/** Windows 上盘符与分隔符大小写不稳定，路径比较一律归一。 */
function samePathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSamePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return samePathKey(a) === samePathKey(b);
}

/** 单个会话 jsonl 的创建时间：header.timestamp，读不到退回文件名里的 ISO。 */
function segmentCreatedMs(file: string): number {
  try {
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const bytesRead = readSync(fd, buffer, 0, 4096, 0);
      const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
      const header = JSON.parse(firstLine) as { type?: unknown; timestamp?: unknown };
      if (header.type === "session" && typeof header.timestamp === "string") {
        const ms = Date.parse(header.timestamp);
        if (Number.isFinite(ms)) return ms;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    /* 头部读不到就按文件名判 */
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(basename(file));
  if (!match) return 0;
  const ms = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

/** 会话目录里创建时间最新的一条段（目录空或都读不到 → null）。 */
export function latestSegmentOfDir(sessionDir: string): { path: string; createdMs: number } | null {
  let names: string[];
  try {
    names = readdirSync(sessionDir);
  } catch {
    return null;
  }
  let best: { path: string; createdMs: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(sessionDir, name);
    const createdMs = segmentCreatedMs(path);
    if (!createdMs) continue;
    if (!best || createdMs > best.createdMs) best = { path, createdMs };
  }
  return best;
}

/** 会话路径 → 图里已经驻留的那条会话（前台槽位或后台运行时）。 */
function findResidentSessionByPath(graph: WorkspaceGraph, sessionPath: string): string | null {
  if (isSamePath(graph.sessionSnapshot?.sessionPath, sessionPath)) {
    return graph.sessionSnapshot?.sessionId ?? null;
  }
  for (const [sessionId, runtime] of graph.backgroundSessions) {
    if (isSamePath(runtime.sessionSnapshot?.sessionPath, sessionPath)) return sessionId;
  }
  for (const [sessionId, runtime] of graph.idleSessionCache ?? []) {
    if (isSamePath(runtime.sessionSnapshot?.sessionPath, sessionPath)) return sessionId;
  }
  return null;
}

/**
 * 指针与盘面对账：当前段 = 工作区里**创建时间最新**的那条会话（不是最后被写入
 * 的那条）。
 *
 * 认段的正路是 `notePixieUserTurn`（用户在段里发出首条消息时当场认下）；这里
 * 只是兜底——Host 重启、别的通道往小精灵工作区里建了会话（委派引擎新建的目标
 * 会话、TG 注入等）时，扫一遍会话目录把创建最新的那条追平。
 *
 * 指针指向一个还没落盘的会话时不动它：刚建的空段比盘上任何一条都新，只是还没有
 * 文件可比（Pi 只在会话出现首条消息时才建文件）。
 */
async function reconcilePointer(
  state: PixieRunner,
  factory: WorkspaceGraphFactory,
  graph: WorkspaceGraph,
): Promise<void> {
  // 指针指向的会话还没有落点路径：SDK 只在会话出现首条消息时才建 jsonl，而认段
  // （notePixieUserTurn / adoptPixieSegment）发生在消息真正发出之前——那一刻拿不到
  // 路径。路径空着会让 `pixie.ensureCurrent` 返回空 sessionPath，前端的
  // `session.open` 直接判 blocked（「回到最新」点了没反应）。只要它还驻留在图里，
  // 就把路径补上并保留指针：刚建出来的空段比盘上任何一条都新，不该被别的文件抢走。
  if (state.pointer.sessionId && !state.pointer.sessionPath) {
    const found = findCurrentRuntime(graph, state.pointer.sessionId);
    if (found) {
      const path =
        found.where === "active"
          ? (found.session.sessionFile ?? "")
          : (found.runtime.sessionSnapshot.sessionPath ?? "");
      if (path) {
        state.pointer = { ...state.pointer, sessionPath: path };
        saveRunnerState(state);
      }
      return;
    }
  }
  const latest = latestSegmentOfDir(
    sessionStorageDirs(state.agentDir, graph.canonicalCwd).activeDir,
  );
  if (!latest) return;
  if (isSamePath(state.pointer.sessionPath, latest.path)) {
    if (state.pointer.createdMs !== latest.createdMs) {
      state.pointer = { ...state.pointer, createdMs: latest.createdMs };
      saveRunnerState(state);
    }
    return;
  }
  if (state.pointer.createdMs >= latest.createdMs) return;
  const residentId = findResidentSessionByPath(graph, latest.path);
  if (residentId) {
    state.pointer = {
      sessionId: residentId,
      sessionPath: latest.path,
      createdMs: latest.createdMs,
    };
    saveRunnerState(state);
    emit("pixie.segmentChanged", { segmentId: residentId, phase: "started" });
    logger.info("Pixie adopted the newest resident segment", { sessionId: residentId });
    return;
  }
  try {
    const opened = await openPixieSessionInGraph(factory, graph, latest.path);
    state.pointer = {
      sessionId: opened.sessionId,
      sessionPath: opened.sessionPath,
      createdMs: latest.createdMs,
    };
    saveRunnerState(state);
    emit("pixie.segmentChanged", { segmentId: opened.sessionId, phase: "started" });
    logger.info("Pixie adopted the newest segment from the session directory", {
      sessionId: opened.sessionId,
    });
  } catch (error) {
    logger.warn("Pixie segment adoption failed", {
      sessionPath: latest.path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 把某条会话认作当前段（指针 + `pixie.segmentChanged`）。调用方：
 * `notePixieUserTurn`（用户在段里发出首条消息）与 `acquireCurrentSession` 的懒建
 * 分支。认段之后委派回传、页面锚点与「首条用户消息」判定才有落点。
 */
function adoptPixieSegment(
  agentDir: string,
  args: { sessionId: string; sessionPath?: string | null; createdMs?: number },
): void {
  const state = ensureRunner(agentDir);
  if (
    state.pointer.sessionId === args.sessionId &&
    isSamePath(state.pointer.sessionPath, args.sessionPath)
  ) {
    return;
  }
  state.pointer = {
    sessionId: args.sessionId,
    sessionPath: args.sessionPath ?? "",
    createdMs: args.createdMs ?? Date.now(),
  };
  saveRunnerState(state);
  emit("pixie.segmentChanged", { segmentId: args.sessionId, phase: "started" });
  logger.info("Pixie adopted a segment as current", {
    sessionId: args.sessionId,
    sessionPath: args.sessionPath ?? null,
  });
}

/** 下一次「新会话」的 header 该指向哪一段（新建的小精灵会话链到上一段）。 */
function pixieParentSessionPath(factory: WorkspaceGraphFactory, agentDir: string): string | null {
  const state = ensureRunner(agentDir);
  if (state.pointer.sessionPath && existsSync(state.pointer.sessionPath)) {
    return state.pointer.sessionPath;
  }
  const graph = factory.graph;
  if (!graph) return null;
  return (
    latestSegmentOfDir(sessionStorageDirs(agentDir, graph.canonicalCwd).activeDir)?.path ?? null
  );
}

/**
 * 「新会话」在小精灵工作区里建新段时要带的参数：把上一段路径写进新段 header 的
 * `parentSession`，插件的段索引与 `pixie_recall` 才不用靠时间猜上一段。
 *
 * 当前段还是空的（一句话都没说）时返回 `{}`：通用创建路径的 pristine 复用会把
 * 这次点击变成 no-op，而不是攒出一串空段。
 */
export function pixieNewSessionOptions(factory: WorkspaceGraphFactory): {
  parentSession?: string;
} {
  const agentDir = factory?.deps?.agentDir;
  const graph = factory?.graph;
  if (!agentDir || !graph || !isPixieWorkspaceCwd(factory, graph.canonicalCwd)) return {};
  if (graph.agentSession && graph.agentSession.messages.length === 0) return {};
  const parent = pixieParentSessionPath(factory, agentDir);
  return parent ? { parentSession: parent } : {};
}

/**
 * 用户在小精灵工作区里**真的发出了一条消息**：这条会话这时才被认作当前段。
 *
 * 点「新会话」只建出一条一句话都没说的空会话，**不算数**。空段当上当前段之后，
 * `pixie.ensureCurrent`、委派回执的落点与前端的「回到最新」判定全都会指向它，
 * 用户看到的症状就是「点完新会话、再回上一段，小精灵的当前会话变成了那条空段」。
 * 改由首条用户消息触发认段：与 `reconcilePointer`（按盘上创建时间最新的会话认段）
 * 殊途同归，但**当场**生效，不用等下一次取段，也就不会出现「刚聊过的段还不是
 * 当前段」的错位窗口。
 *
 * 只在**本段的首条用户消息**上动指针：在历史段里补一句话不该把当前段拽走
 * （`needsSegmentPreamble` 正是「这条会话还没有用户消息」的判定）。
 */
export function notePixieUserTurn(
  factory: WorkspaceGraphFactory,
  snapshot: { sessionId?: string | null; sessionPath?: string | null } | null | undefined,
  session: AgentSession | null,
): void {
  const agentDir = factory?.deps?.agentDir;
  const graph = factory?.graph;
  const sessionId = snapshot?.sessionId;
  if (!agentDir || !graph || !sessionId) return;
  if (!isPixieWorkspaceCwd(factory, graph.canonicalCwd)) return;
  if (!session || !needsSegmentPreamble(session)) return;
  if (ensureRunner(agentDir).pointer.sessionId === sessionId) return;
  adoptPixieSegment(agentDir, {
    sessionId,
    sessionPath: snapshot?.sessionPath ?? null,
  });
}

/**
 * 小精灵给会话段改名（控制面 `POST /api/pixie/name`）。段名走 SDK 的
 * `setSessionName` → jsonl 里的 `session_info` 条目，插件的段索引只读它。
 *
 * `sessionId` = 插件自己那条会话：用户可能在旧段里继续聊并改名，只认「创建最新
 * 的那段」会把名字写到别的段上。图里没有这条会话时报错，不做兜底改名。
 */
export async function renamePixieSegment(
  factory: WorkspaceGraphFactory,
  args: { agentDir: string; name: string; sessionId?: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = clipSegmentName(args.name);
  if (!name) return { ok: false, error: "会话名不能为空" };
  const acquired = await acquireCurrentSession(factory, args.agentDir);
  if (!acquired) return { ok: false, error: "当前没有进行中的会话段" };
  const wanted = args.sessionId?.trim();
  const found = wanted ? findCurrentRuntime(acquired.graph, wanted) : null;
  if (wanted && !found) {
    return {
      ok: false,
      error: "那段会话当前没有驻留，改不了名；请在会话列表里改名，或回到那段继续聊。",
    };
  }
  const session =
    found?.where === "active"
      ? found.session
      : found?.where === "parked"
        ? found.runtime.agentSession
        : acquired.session;
  try {
    session.setSessionName(name);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "会话名写入失败",
    };
  }
  logger.info("Pixie segment renamed", { sessionId: session.sessionId, name });
  return { ok: true };
}

/* ── 当前会话获取与投递 ─────────────────────────────────────────── */

/** 当前段换了会话就重挂 settle 监听（用量统计只认活动中的那一条订阅）。 */
function subscribeSettleIfNeeded(state: PixieRunner, session: AgentSession): void {
  if (state.settleSessionId === session.sessionId) return;
  subscribeSettle(state, session);
}

/**
 * 取当前会话（与盘面对账 → 图内解析 → 重启重开 → 懒建），带单飞守卫。绝不为了
 * 读而建图之外的东西：建会话只发生在指针缺失时（页面打开/投递路径都是写语义）。
 */
async function acquireCurrentSession(
  factory: WorkspaceGraphFactory,
  agentDir: string,
): Promise<PixieAcquisition | null> {
  const state = ensureRunner(agentDir);
  if (state.acquireInFlight) return state.acquireInFlight;
  const task = (async (): Promise<PixieAcquisition | null> => {
    const graph = await ensurePixieGraph(factory, agentDir);
    if (!graph) return null;
    // 当前段的权威是「工作区里创建最新的会话」：用户在界面点「新会话」走通用
    // session.create，runner 不在那条路径上，靠这里追平。
    await reconcilePointer(state, factory, graph);
    if (state.pointer.sessionId) {
      const found = findCurrentRuntime(graph, state.pointer.sessionId);
      if (found?.where === "active") {
        subscribeSettleIfNeeded(state, found.session);
        return {
          graph,
          session: found.session,
          sessionId: state.pointer.sessionId,
          sessionPath: state.pointer.sessionPath ?? "",
        };
      }
      if (found?.where === "parked") {
        subscribeSettleIfNeeded(state, found.runtime.agentSession);
        return {
          graph,
          session: found.runtime.agentSession,
          sessionId: found.runtime.sessionId,
          sessionPath: found.runtime.sessionSnapshot.sessionPath ?? state.pointer.sessionPath ?? "",
        };
      }
    }
    if (state.pointer.sessionPath && existsSync(state.pointer.sessionPath)) {
      try {
        const opened = await openPixieSessionInGraph(factory, graph, state.pointer.sessionPath);
        state.pointer = {
          ...state.pointer,
          sessionId: opened.sessionId,
          sessionPath: opened.sessionPath,
        };
        saveRunnerState(state);
        subscribeSettle(state, opened.runtime.agentSession);
        logger.info("Pixie session reopened after restart", { sessionId: opened.sessionId });
        return {
          graph,
          session: opened.runtime.agentSession,
          sessionId: opened.sessionId,
          sessionPath: opened.sessionPath,
        };
      } catch (error) {
        logger.warn("Failed to reopen the pixie session; starting fresh", {
          sessionPath: state.pointer.sessionPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const created = await createPixieSessionInGraph(factory, graph);
    state.pointer = {
      sessionId: created.sessionId,
      sessionPath: created.sessionPath,
      createdMs: Date.now(),
    };
    saveRunnerState(state);
    subscribeSettle(state, created.runtime.agentSession);
    emit("pixie.segmentChanged", { segmentId: created.sessionId, phase: "started" });
    return {
      graph,
      session: created.runtime.agentSession,
      sessionId: created.sessionId,
      sessionPath: created.sessionPath,
    };
  })();
  state.acquireInFlight = task;
  try {
    return await task;
  } finally {
    state.acquireInFlight = null;
  }
}

/**
 * 本段是否还没有用户消息：按会话条目本身判定，不用进程内的全局位——用户在
 * 界面里「新会话」开出的段、Host 重启与段切换都不会让它重复或漏发（认段指针
 * 与「首条用户消息」判定共用这一条）。
 */
function needsSegmentPreamble(session: AgentSession): boolean {
  try {
    return messagesOf(session).every((message) => message.role !== "user");
  } catch {
    return false;
  }
}

/**
 * Unified prompt-injection entry（控制面 inject 与委派回调信封）。Handles:
 * 把回调送回派单的那一段、以及忙时 steer 非交互信封。UI 用户消息不走这里——
 * 它们是标准 agent.prompt。
 */
async function deliverToSegment(
  factory: WorkspaceGraphFactory,
  args: {
    agentDir: string;
    text: string;
    source: "ui" | "tg" | "system";
    /** Interactive send → refuse when busy; callback/envelope → steer in. */
    interactive: boolean;
    /** 随消息一并发送的图片（UI 附件，透传给 session.prompt/steer）。 */
    images?: ImageContent[];
    /**
     * 派单那一段的会话 id：用户在旧段里继续聊并派活时，回执要回到旧段，而不是
     * 「创建最新的那段」。图里没有这条会话时退回当前段。
     */
    targetSessionId?: string | null;
  },
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  const acquired = await acquireCurrentSession(factory, args.agentDir);
  if (!acquired) return { ok: false, error: "小精灵工作区图不可用" };
  const target = args.targetSessionId?.trim();
  const found = target ? findCurrentRuntime(acquired.graph, target) : null;
  const session =
    found?.where === "active"
      ? found.session
      : found?.where === "parked"
        ? found.runtime.agentSession
        : acquired.session;
  // 每条投递消息恰好一个 `[pixie|<source>]` 标记行，标签反映真实来源。
  const tagged = `[pixie|${args.source}]\n${args.text}`;
  if (session.isStreaming) {
    if (args.interactive) return { ok: false, error: "上一条回复还在生成中" };
    // Non-interactive envelopes must not be lost: steer into the running turn.
    void session.steer(tagged, args.images).catch(() => undefined);
    return { ok: true, sessionId: session.sessionId };
  }
  void session
    .prompt(tagged, args.images?.length ? { images: args.images } : undefined)
    .catch((error: unknown) => {
      logger.warn("Pixie envelope delivery failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return { ok: true, sessionId: session.sessionId };
}

/** Inject a gateway/inject-endpoint message (non-interactive). */
export async function injectPixieMessage(
  factory: WorkspaceGraphFactory,
  args: {
    agentDir: string;
    text: string;
    source: "ui" | "tg" | "system";
  },
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  return deliverToSegment(factory, { ...args, interactive: false });
}

/* ── 页面入口 ─────────────────────────────────────────────────── */

/**
 * Desktop 页面打开时的入口（pixie.ensureCurrent）：确保图与当前会话存在（顺带
 * 与盘面对账，认下用户在界面里新开的段），返回前端应当打开的会话。前端随后走
 * 标准的 workspace.setCurrent + session.open。
 */
export async function ensurePixieCurrent(
  factory: WorkspaceGraphFactory,
  agentDir: string,
): Promise<
  { ok: true; cwd: string; sessionId: string; sessionPath: string } | { ok: false; error: string }
> {
  const acquired = await acquireCurrentSession(factory, agentDir);
  if (!acquired) return { ok: false, error: "小精灵工作区图不可用" };
  return {
    ok: true,
    // 返回 canonicalize 后的路径：前端拿它与 workspace.canonicalCwd 严格比较
    // （ready 门控 / already-active 判定），避免原始拼接串与 Host 归一化结果
    // 的差异（盘符大小写、symlink 等）让页面卡在加载态。
    cwd: factory.canonicalizeCwd(resolvePixieWorkspacePath(agentDir)),
    sessionId: acquired.sessionId,
    sessionPath: acquired.sessionPath,
  };
}

/**
 * 会话是否属于小精灵工作区（防御性：测试桩/非常规工厂按非小精灵处理）。
 * agent-controller 用它决定「新会话」是否要链上上一段。
 */
function isPixieWorkspaceCwd(factory: WorkspaceGraphFactory, sessionCwd: string): boolean {
  const agentDir = factory?.deps?.agentDir;
  if (!agentDir || typeof factory?.canonicalizeCwd !== "function") return false;
  // 防御：小精灵工作区目录可能不存在（全新安装 / 自定义路径未建），
  // canonicalizeCwd 会在这种时候抛 WORKSPACE_SWITCH_FAILED —— 比较用途
  // 不应把错误泄进 agent.prompt 等调用方，按「非小精灵会话」处理。
  let pixieCwd: string;
  try {
    pixieCwd = factory.canonicalizeCwd(resolvePixieWorkspacePath(agentDir));
  } catch {
    return false;
  }
  return sessionCwd === pixieCwd;
}

/* ── 消息投影 ────────────────────────────────────────────────────── */

/** Project a session message into the wire shape (automation runner projection). */
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

/* ── 回调回流（done / error / ask → 小精灵会话）────────────────────── */

/**
 * Deliver a settled delegation back into the CURRENT pixie segment as a
 * user-turn envelope. The record is already mutated by the caller
 * (settleDispatch / failDispatch / askDispatch); this only handles the
 * feedback prompt + event emission.
 */
export async function deliverDispatchCallback(
  factory: WorkspaceGraphFactory,
  args: {
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
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
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
  const delivered = await deliverToSegment(factory, {
    agentDir: args.agentDir,
    text: envelope.join("\n"),
    source: "system",
    interactive: false,
    // 回执送回派单的那一段（用户在旧段里派的活）；图里找不到才退回当前段。
    targetSessionId: record.originSessionId,
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
