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
/**
 * Pixie (小精灵) runner — v5「回标准控制面」。
 *
 * 小精灵不再是自管会话的旁路体系：她的当前会话就是 workspace/pixie 这个真实
 * 工作区图里的一个标准会话（活动槽位或后台驻留），与普通会话共用同一套快照
 * 推送、事件流与 session.open 语义；桌面端的小精灵页面只是普通工作区视图的
 * 一层主题皮肤。runner 保留的只有 Host 自动化职责：
 *
 *   1. 当前会话指针 + 打盹状态（pixie-state.json；v4 timeline.json 首启自动迁移）；
 *   2. 换段自动化：pixie_rest / 打个盹 / rollover 轮数预算 / 每日打盹 → 在图内
 *      建新会话并切换（前台时 promoteBackgroundRuntime，快照自动推给前端）；
 *   3. 委派回调与控制面 inject 的信封投递（session.prompt/steer，与委派落点
 *      同一机制）；
 *   4. 首条用户消息的 <pixie-context> 前导注入（agent-controller 的 prompt
 *      路径调 maybeWrapPixiePrompt；控制面通道在 deliverToCurrentSegment 内）。
 *
 * 委派登记表（dispatches.json，done/error/ask 回调）依旧住在这里——它跟会话
 * 所有权无关。pi-pixie 插件的环回控制面端点契约保持不变。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { upsertPixieSession } from "./pixie-session-cache.js";
import { watchMessageEntryId } from "./session-entry-anchor.js";
import {
  composeDailyNapHandoff,
  dailyNapPhrase,
  localDayKey,
  shouldDailyNap,
  type DailyNapInput,
} from "./pixie-daily-nap.js";
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
 * 与 Host 注入的 `<pixie-context>` 分工：
 * - 这里 = **人格与工作方式**（身份、语气、分工、指挥台怎么用）——可以直接手改，
 *   改完从下一个新段生效（SDK 的 context files 在段会话创建/恢复时 reload）。
 * - 那边 = **与 Host 行为绑定的契约 + 运行期数据**（落点规则、排队、回调总则、
 *   模型授权、已知工作区列表、上一段交接摘要）——必须跟实现同源，不放文件里。
 */
const PIXIE_PERSONA_TEMPLATE = `# 小精灵（PiAbyss 常驻小助手）

> 这份文件是小精灵的**人格与工作方式**，可以直接改；改完从**下一个新段**开始生效（当段不会重载）。
> 「已知工作区列表」「上一段交接摘要」等运行期信息由 PiAbyss 注入，不在这里。

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
- 话题收尾了，可以打个盹换段
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

/** Fallback sleep phrases when the pixie does not pick one herself. */
const SLEEP_PHRASES = [
  "我先打个盹~",
  "我去转一圈，回来再聊~",
  "眯一会儿，有活随时喊我",
  "打个哈欠……这一段先存档啦",
  "小憩片刻 💤",
];

/** 换段归档名长度上限（超出截断加省略号；列表本身也会 truncate）。 */
const SEGMENT_NAME_MAX_LENGTH = 40;

/**
 * 换段时给旧会话起的段名：title（小精灵自拟的本段标题）> handoff（交接
 * 摘要）> 睡觉短语，压成单行并截断。会话名不再带「🧚 小精灵」前缀——
 * 全列表本就只含小精灵会话，前缀只会让每行看起来一模一样。
 */
export function segmentSessionName(
  title: string | null | undefined,
  handoff: string | null | undefined,
  phrase: string,
): string {
  const raw = title?.trim() || handoff?.trim() || phrase.trim();
  const oneLine = raw.replace(/\s+/g, " ").trim();
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

type PixieSegmentReason = "agent" | "user" | "rollover" | "daily";

/** 每日打盹状态（随 timeline 落盘，跨 Host 重启保留）。 */
type PixieNapState = {
  /** 最后一次用户侧活动时间（"最长空窗"的起点）。 */
  lastActivityAt?: number;
  /** 上次打盹完成时间。 */
  lastNapAt?: number;
  /** 上次打盹的自然日（本地 YYYY-MM-DD）。 */
  lastNapDate?: string;
  /** 历史静默间隔样本（毫秒，最多保留 50 条，供自适应阈值用）。 */
  idleSamples?: number[];
};

/** 旧 timeline.json 的段指针（仅迁移读取用；协议层类型已随 pixie.state 退役）。 */
type PixieSegmentRecord = {
  id: string;
  sessionId: string;
  sessionPath: string;
  startedAt: number;
  endedAt: number | null;
  separator: string | null;
  reason: "agent" | "user" | "rollover" | "daily" | null;
  handoff: string | null;
};

type PixieTimelineFile = { version: 1; segments: PixieSegmentRecord[]; nap?: PixieNapState };

/** 容错读取 nap 状态（字段非法就丢弃，不因此让整个时间线失效）。 */
function parseNapState(file: unknown): PixieNapState | null {
  const raw = (file as { nap?: unknown }).nap;
  if (typeof raw !== "object" || raw === null) return null;
  const nap = raw as Partial<PixieNapState>;
  const out: PixieNapState = {};
  if (typeof nap.lastActivityAt === "number" && Number.isFinite(nap.lastActivityAt)) {
    out.lastActivityAt = nap.lastActivityAt;
  }
  if (typeof nap.lastNapAt === "number" && Number.isFinite(nap.lastNapAt)) {
    out.lastNapAt = nap.lastNapAt;
  }
  if (typeof nap.lastNapDate === "string" && nap.lastNapDate) out.lastNapDate = nap.lastNapDate;
  if (Array.isArray(nap.idleSamples)) {
    out.idleSamples = nap.idleSamples
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value) && value > 0,
      )
      .slice(-50);
  }
  return out;
}

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
          record.reason === "agent" ||
          record.reason === "user" ||
          record.reason === "rollover" ||
          record.reason === "daily"
            ? record.reason
            : null,
        handoff: typeof record.handoff === "string" ? record.handoff : null,
      });
    }
    const nap = parseNapState(parsed);
    return nap ? { version: 1, segments, nap } : { version: 1, segments };
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
      // v4.4 每日打盹（机会型）：只对已绑定图里的当前会话生效——不在这里强行
      // 建图；从未打开过小精灵工作区时交给 ensurePixieCurrent / 投递路径的懒兜底。
      const state = runner && runner.agentDir === agentDir ? runner : null;
      if (!state || state.pendingRest !== null || state.pendingUserRest) return;
      if (!state.pointer.sessionId) return;
      const pixieCwd = resolvePixieWorkspacePath(agentDir);
      const graph = factory.findBoundGraph(factory.canonicalizeCwd(pixieCwd));
      if (!graph) return;
      const found = findCurrentRuntime(graph, state.pointer.sessionId);
      const session =
        found?.where === "active"
          ? found.session
          : found?.where === "parked"
            ? found.runtime.agentSession
            : null;
      if (!session || session.isStreaming) return;
      maybeDailyNap(state, factory, session);
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

/**
 * 记录一条委派的消息锚点（session entry id）：dispatchMessageId = 派发消息注入
 * 目标会话的位置；reportMessageId = 回调信封注入小精灵段会话的位置。两者都与
 * dispatchId 关联，前端据此跳转滚动定位。只在尚未记录时写入（同一任务的重派/
 * 续跑会产生新的信封，但锚点认的是这条记录第一次落位的那条消息）。
 */
export function setDispatchMessageAnchor(
  id: string,
  agentDir: string,
  anchor: { dispatchMessageId?: string | null; reportMessageId?: string | null },
): PixieDispatch | null {
  const record = dispatches.find((d) => d.id === id);
  if (!record) return null;
  let changed = false;
  if (anchor.dispatchMessageId && !record.dispatchMessageId) {
    record.dispatchMessageId = anchor.dispatchMessageId;
    changed = true;
  }
  if (anchor.reportMessageId && !record.reportMessageId) {
    record.reportMessageId = anchor.reportMessageId;
    changed = true;
  }
  if (!changed) return null;
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

/* ── 运行器 v5：图内托管的标准会话 ───────────────────────────────── */

type PixiePointer = { sessionId: string | null; sessionPath: string | null };

type PixieRunner = {
  agentDir: string;
  pointer: PixiePointer;
  nap: PixieNapState;
  /** 上一段交接摘要（下一会话首条消息的 preamble 用）。 */
  lastHandoff: string | null;
  /** 当前会话还没吃过 <pixie-context> 前导（首条用户消息时注入并清位）。 */
  needsPreamble: boolean;
  /** 当前会话已完成的用户回合数（rollover 预算）。 */
  turnsInCurrentSession: number;
  /** Set by pixie_rest / 打个盹 / rollover; finalized on agent_settled. */
  pendingRest: {
    phrase: string | null;
    handoff: string | null;
    /** 小精灵自拟的本段标题（换段归档名首选；见 segmentSessionName）。 */
    title: string | null;
    reason: PixieSegmentReason;
  } | null;
  /** 打个盹 requested while the pixie decides; forced finalize on settle. */
  pendingUserRest: boolean;
  unsubscribeSettle: (() => void) | null;
  settleSessionId: string | null;
  /** Single-flight for rotation（settle 路径与 watcher 可能并发触发）. */
  rotateInFlight: Promise<boolean> | null;
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

function randomSleepPhrase(): string {
  return SLEEP_PHRASES[Math.floor(Math.random() * SLEEP_PHRASES.length)]!;
}

/* ── 指针状态文件（pixie-state.json；v4 timeline.json 首启自动迁移）── */

type PixieStateFile = {
  version: 1;
  sessionId: string | null;
  sessionPath: string | null;
  nap: PixieNapState;
  lastHandoff: string | null;
  needsPreamble: boolean;
};

function pixieStatePath(agentDir: string): string {
  return join(pixieDir(agentDir), "pixie-state.json");
}

function loadRunnerState(
  agentDir: string,
): Pick<PixieRunner, "pointer" | "nap" | "lastHandoff" | "needsPreamble"> {
  try {
    const parsed = JSON.parse(readFileSync(pixieStatePath(agentDir), "utf8")) as PixieStateFile;
    if (parsed && parsed.version === 1) {
      return {
        pointer: {
          sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
          sessionPath: typeof parsed.sessionPath === "string" ? parsed.sessionPath : null,
        },
        nap: parseNapState({ nap: parsed.nap }) ?? {},
        lastHandoff: typeof parsed.lastHandoff === "string" ? parsed.lastHandoff : null,
        needsPreamble: parsed.needsPreamble === true,
      };
    }
  } catch {
    /* first run or unreadable */
  }
  // v4 迁移：timeline.json 里最后一段还开着（endedAt=null）→ 收编为当前指针；
  // 打盹状态与交接摘要一并接管。迁移后 timeline.json 保留不动（只读历史）。
  try {
    const timeline = loadTimeline(agentDir);
    const last = timeline.segments[timeline.segments.length - 1];
    return {
      pointer:
        last && last.endedAt === null
          ? { sessionId: last.sessionId, sessionPath: last.sessionPath }
          : { sessionId: null, sessionPath: null },
      nap: timeline.nap ?? {},
      lastHandoff: last?.handoff ?? null,
      needsPreamble: false, // 旧段首条消息早已吃过前导
    };
  } catch {
    return {
      pointer: { sessionId: null, sessionPath: null },
      nap: {},
      lastHandoff: null,
      needsPreamble: false,
    };
  }
}

function saveRunnerState(state: PixieRunner): void {
  try {
    mkdirSync(pixieDir(state.agentDir), { recursive: true });
    const file: PixieStateFile = {
      version: 1,
      sessionId: state.pointer.sessionId,
      sessionPath: state.pointer.sessionPath,
      nap: state.nap,
      lastHandoff: state.lastHandoff,
      needsPreamble: state.needsPreamble,
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
    nap: loaded.nap,
    lastHandoff: loaded.lastHandoff,
    needsPreamble: loaded.needsPreamble,
    turnsInCurrentSession: 0, // acquire/reopen 时按会话消息数重算
    pendingRest: null,
    pendingUserRest: false,
    unsubscribeSettle: null,
    settleSessionId: null,
    rotateInFlight: null,
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
): Promise<{ sessionId: string; sessionPath: string; runtime: PixieParkedRuntime }> {
  const agentDir = factory.deps.agentDir;
  const pixieCwd = graph.canonicalCwd;
  // 人格文件要在 resourceLoader 之前落盘，本次创建的会话才吃得到。
  ensurePixiePersonaFile(agentDir, pixieCwd);
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
  const session = created.session;
  // 会话名不在新建时写入——刚建段看不出内容，定了也全是误差。段名统一在
  // 打盹收尾（rotateToNewSession）时按本段内容起（pixie_rest 的 title /
  // handoff），见 segmentSessionName。
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

/** Host 重启后把指针指向的 JSONL 重新打开进图（等价 openSession 的驻留路径）。 */
async function openPixieSessionInGraph(
  factory: WorkspaceGraphFactory,
  graph: WorkspaceGraph,
  sessionPath: string,
): Promise<{ sessionId: string; sessionPath: string; runtime: PixieParkedRuntime }> {
  const agentDir = factory.deps.agentDir;
  const pixieCwd = graph.canonicalCwd;
  ensurePixiePersonaFile(agentDir, pixieCwd);
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
  const session = created.session;
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
    unsubscribeAgent: session.subscribe((event) => factory.handleAgentEvent(graph, session, event)),
    extensionUiActivate: null,
    extensionUiCleanup: null,
    extensionUiUpdateIdentity: null,
    extensionUiReplayState: null,
  };
  graph.backgroundSessions.set(session.sessionId, runtime);
  markParkedForegroundSession(factory, graph, runtime);
  return { sessionId: session.sessionId, sessionPath: session.sessionFile ?? sessionPath, runtime };
}

/* ── 换段（打盹 / rollover / 每日打盹）─────────────────────────── */

/** The settle listener: rotation at the run boundary. */
function subscribeSettle(
  state: PixieRunner,
  factory: WorkspaceGraphFactory,
  graph: WorkspaceGraph,
  session: AgentSession,
): void {
  state.unsubscribeSettle?.();
  state.settleSessionId = session.sessionId;
  state.unsubscribeSettle = session.subscribe((event) => {
    if (event.type !== "agent_settled") return;
    if (state.settleSessionId !== session.sessionId) return;
    state.turnsInCurrentSession += 1;
    recordPixieInteraction(state.agentDir);
    saveRunnerState(state);
    const pending =
      state.pendingRest ??
      (state.pendingUserRest
        ? { phrase: null, handoff: null, title: null, reason: "user" as const }
        : null);
    state.pendingRest = null;
    state.pendingUserRest = false;
    if (pending) {
      void rotateToNewSession(factory, state, {
        reason: pending.reason,
        phrase: pending.phrase,
        handoff: pending.handoff,
        title: pending.title,
        oldSession: session,
      });
      return;
    }
    if (state.turnsInCurrentSession >= pixieSegmentMaxTurns()) {
      void rotateToNewSession(factory, state, {
        reason: "rollover",
        phrase: null,
        handoff: null,
        title: null,
        oldSession: session,
      });
    }
  });
}

/**
 * 换段：旧会话按本段内容起名归档（title/handoff > 睡觉短语，见
 * segmentSessionName），图内新建会话并接任当前指针。前台图时提升为活动
 * 会话（promoteBackgroundRuntime → 快照推送，前端自动跟随，即「打盹 =
 * 切换新会话」的产品语义）；后台图时只更新指针，页面下次打开时
 * ensurePixieCurrent 会拿到新会话。
 */
async function rotateToNewSession(
  factory: WorkspaceGraphFactory,
  state: PixieRunner,
  args: {
    reason: PixieSegmentReason;
    phrase: string | null;
    handoff: string | null;
    title: string | null;
    oldSession: AgentSession | null;
  },
): Promise<boolean> {
  if (state.rotateInFlight) return state.rotateInFlight;
  const task = (async (): Promise<boolean> => {
    const graph = await ensurePixieGraph(factory, state.agentDir);
    if (!graph) {
      logger.warn("Pixie rotation skipped: the pixie workspace graph is unavailable", {
        reason: args.reason,
      });
      return false;
    }
    const phrase = args.phrase?.trim() || randomSleepPhrase();
    if (args.oldSession) {
      try {
        args.oldSession.setSessionName(segmentSessionName(args.title, args.handoff, phrase));
      } catch {
        /* cosmetic */
      }
    }
    if (args.reason === "daily") {
      const now = Date.now();
      state.nap.lastNapAt = now;
      state.nap.lastNapDate = localDayKey(now);
    }
    state.lastHandoff = args.handoff?.trim() || null;
    state.pendingRest = null;
    state.pendingUserRest = false;
    state.pointer = { sessionId: null, sessionPath: null };
    state.unsubscribeSettle?.();
    state.unsubscribeSettle = null;
    state.settleSessionId = null;
    saveRunnerState(state);
    let created;
    try {
      created = await createPixieSessionInGraph(factory, graph);
    } catch (error) {
      logger.warn("Pixie rotation failed to create the follow-up session", {
        reason: args.reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    state.pointer = { sessionId: created.sessionId, sessionPath: created.sessionPath };
    state.needsPreamble = true;
    state.turnsInCurrentSession = 0;
    saveRunnerState(state);
    subscribeSettle(state, factory, graph, created.runtime.agentSession);
    emit("pixie.segmentChanged", { segmentId: created.sessionId, phase: "started" });
    if (factory.getGraph()?.canonicalCwd === graph.canonicalCwd) {
      try {
        await factory.promoteBackgroundRuntime(graph, created.runtime);
      } catch (error) {
        logger.warn("Pixie rotation could not promote the fresh session", {
          sessionId: created.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.info("Pixie rotated to a fresh session", {
      reason: args.reason,
      sessionId: created.sessionId,
      phrase,
    });
    return true;
  })();
  state.rotateInFlight = task;
  try {
    return await task;
  } finally {
    state.rotateInFlight = null;
  }
}

/** 当前会话最后一条小精灵回复（交接摘要用）。 */
function lastAssistantTextOf(session: AgentSession): string | null {
  const messages = messagesOf(session);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.text.trim()) return message.text;
  }
  return null;
}

/** 还没走到终态的委派（交接摘要用）。 */
function unfinishedDispatchesForHandoff(agentDir: string): { task: string; status: string }[] {
  try {
    const settled = new Set(["reported", "failed", "stopped", "cancelled"]);
    return listDispatches(50, agentDir)
      .filter((record) => !settled.has(record.status))
      .map((record) => ({ task: record.task, status: record.status }));
  } catch {
    return [];
  }
}

/** 备忘录里未完成的标题（交接摘要用；容错读取，读不到就当没有）。 */
function openMemoTitlesOf(agentDir: string): string[] {
  try {
    const path = join(piabyssDataDir(agentDir), "memo", "notes.json");
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { notes?: unknown };
    if (!Array.isArray(parsed.notes)) return [];
    const titles: string[] = [];
    for (const raw of parsed.notes) {
      if (!raw || typeof raw !== "object") continue;
      const note = raw as { title?: unknown; status?: unknown };
      if (note.status !== "open" && note.status !== "in_progress") continue;
      if (typeof note.title === "string" && note.title.trim()) titles.push(note.title.trim());
      if (titles.length >= 3) break;
    }
    return titles;
  } catch {
    return [];
  }
}

/**
 * 记一次用户侧活动：先按上一次活动算一个静默间隔样本，再刷新最后活动时间。
 */
function notePixieActivity(state: PixieRunner, at: number): void {
  const nap = state.nap ?? (state.nap = {});
  const previous = nap.lastActivityAt;
  if (typeof previous === "number" && previous > 0 && at > previous) {
    const gap = at - previous;
    // 超过 7 天的间隔属于"把工具搁置了"，不是睡了一觉：不进样本。
    if (gap < 7 * 24 * 3_600_000) {
      const samples = nap.idleSamples ?? (nap.idleSamples = []);
      samples.push(gap);
      if (samples.length > 50) samples.splice(0, samples.length - 50);
    }
  }
  nap.lastActivityAt = at;
  saveRunnerState(state);
}

/**
 * 每日打盹判定（watcher tick / 打开页面 / 投递路径共用）。成立就换段并返回
 * true（旋转是异步的，调用方按需 await rotateInFlight）。
 */
function maybeDailyNap(
  state: PixieRunner,
  factory: WorkspaceGraphFactory,
  session: AgentSession,
): boolean {
  const input: DailyNapInput = {
    now: Date.now(),
    lastActivityAt: state.nap.lastActivityAt ?? null,
    lastNapAt: state.nap.lastNapAt ?? null,
    turnsInCurrentSegment: state.turnsInCurrentSession,
    streaming: session.isStreaming,
    idleSamples: state.nap.idleSamples ?? [],
  };
  const decision = shouldDailyNap(input);
  if (!decision.nap) return false;
  const handoff = composeDailyNapHandoff({
    lastAssistantText: lastAssistantTextOf(session),
    unfinishedDispatches: unfinishedDispatchesForHandoff(state.agentDir),
    openMemoTitles: openMemoTitlesOf(state.agentDir),
  });
  void rotateToNewSession(factory, state, {
    reason: "daily",
    phrase: dailyNapPhrase(Date.now()),
    handoff,
    title: null,
    oldSession: session,
  });
  logger.info("Pixie daily nap rotation started", { hadHandoff: handoff !== null });
  return true;
}

/* ── 当前会话获取与投递 ─────────────────────────────────────────── */

/**
 * 取当前会话（图内解析 → 重启重开 → 懒建），带单飞守卫。绝不为了读而建图之外
 * 的东西：建会话只发生在指针缺失时（页面打开/投递路径都是写语义）。
 */
async function acquireCurrentSession(
  factory: WorkspaceGraphFactory,
  agentDir: string,
): Promise<PixieAcquisition | null> {
  const state = ensureRunner(agentDir);
  if (state.acquireInFlight) return state.acquireInFlight;
  const task = (async (): Promise<PixieAcquisition | null> => {
    if (state.rotateInFlight) {
      try {
        await state.rotateInFlight;
      } catch {
        /* rotation failure falls through to normal acquisition */
      }
    }
    const graph = await ensurePixieGraph(factory, agentDir);
    if (!graph) return null;
    if (state.pointer.sessionId) {
      const found = findCurrentRuntime(graph, state.pointer.sessionId);
      if (found?.where === "active") {
        return {
          graph,
          session: found.session,
          sessionId: state.pointer.sessionId,
          sessionPath: state.pointer.sessionPath ?? "",
        };
      }
      if (found?.where === "parked") {
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
        state.pointer = { sessionId: opened.sessionId, sessionPath: opened.sessionPath };
        state.turnsInCurrentSession = messagesOf(opened.runtime.agentSession).filter(
          (message) => message.role === "user",
        ).length;
        // 空会话（建好还没说过话）仍需前导。
        if (
          !state.needsPreamble &&
          messagesOf(opened.runtime.agentSession).every((message) => message.role !== "user")
        ) {
          state.needsPreamble = true;
        }
        saveRunnerState(state);
        subscribeSettle(state, factory, graph, opened.runtime.agentSession);
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
    state.pointer = { sessionId: created.sessionId, sessionPath: created.sessionPath };
    state.needsPreamble = true;
    state.turnsInCurrentSession = 0;
    saveRunnerState(state);
    subscribeSettle(state, factory, graph, created.runtime.agentSession);
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
 * Unified prompt-injection entry for the CURRENT session（控制面 inject 与
 * 委派回调信封）。Handles: lazy daily nap (non-system), the fresh-session
 * context preamble, and busy steering for non-interactive envelopes.
 * UI 用户消息不走这里——它们是标准 agent.prompt，前导由 maybeWrapPixiePrompt
 * 在 prompt 路径注入。
 */
async function deliverToCurrentSegment(
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
     * 委派回调信封的归属 id：armed 后第一条含该 id 标记的 user 消息落位即记下
     * entry id 作为 reportMessageId 锚点（面板点击「跳到结果回执」的落点）。
     */
    anchorDispatchId?: string | null;
  },
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  const state = ensureRunner(args.agentDir);
  let acquired = await acquireCurrentSession(factory, args.agentDir);
  if (!acquired) return { ok: false, error: "小精灵工作区图不可用" };
  if (
    args.source !== "system" &&
    state.pendingRest === null &&
    !state.pendingUserRest &&
    !acquired.session.isStreaming
  ) {
    // v4.4 每日打盹（懒兜底）：非 system 注入在投递之前先判一次。
    if (maybeDailyNap(state, factory, acquired.session)) {
      if (state.rotateInFlight) {
        try {
          await state.rotateInFlight;
        } catch {
          /* fall through with whatever the pointer holds now */
        }
      }
      const again = await acquireCurrentSession(factory, args.agentDir);
      if (!again) return { ok: false, error: "小精灵换段后工作区图不可用" };
      acquired = again;
    }
  }
  const session = acquired.session;
  const preamble = state.needsPreamble
    ? buildSegmentContextPreamble(args.agentDir, state.lastHandoff)
    : null;
  state.needsPreamble = false;
  saveRunnerState(state);
  // 记一次用户侧活动（静默样本 + 最后活动时间）。
  notePixieActivity(state, Date.now());
  const anchorDispatchId = args.anchorDispatchId?.trim() || null;
  if (anchorDispatchId) {
    // 必须在注入之前武装：信封可能是 steer/followUp，落位晚于本次调用返回。
    watchMessageEntryId({
      session,
      marker: `dispatchId="${anchorDispatchId}"`,
      onFound: (entryId) =>
        setDispatchMessageAnchor(anchorDispatchId, args.agentDir, { reportMessageId: entryId }),
    });
  }
  if (session.isStreaming) {
    if (args.interactive) return { ok: false, error: "上一条回复还在生成中" };
    // Non-interactive envelopes must not be lost: steer into the running turn.
    void session
      .steer(`${preamble ? `${preamble}\n` : ""}[pixie|${args.source}]\n${args.text}`, args.images)
      .catch(() => undefined);
    return { ok: true, sessionId: session.sessionId };
  }
  const prompt = `${preamble ? `${preamble}\n` : ""}[pixie|${args.source}]\n${args.text}`;
  void session
    .prompt(prompt, args.images?.length ? { images: args.images } : undefined)
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
  return deliverToCurrentSegment(factory, { ...args, interactive: false });
}

/** 打个盹 button (pixie.newSegment): instruct the pixie, force on refusal. */
export async function requestPixieSegment(
  factory: WorkspaceGraphFactory,
  args: { agentDir: string },
): Promise<{ ok: true }> {
  const state = ensureRunner(args.agentDir);
  const acquired = await acquireCurrentSession(factory, args.agentDir);
  if (!acquired) return { ok: true }; // nothing open: the next message starts fresh
  // 新建会话界面（还没说过一句话的空会话）不支持打盹：没有可收尾的内容，
  // 段名也无从谈起——直接 no-op（与"没有打开会话"同一语义）。
  if (messagesOf(acquired.session).length === 0) return { ok: true };
  state.pendingUserRest = true;
  const instruction = [
    "[pixie|ui]",
    "<pixie-nap-request>",
    "用户请你打个盹。请调用 pixie_rest 工具收尾本段：title 用几个词概括本段会话聊了什么（打盹后它会成为本段的归档会话名），phrase 填你喜欢的睡觉短语，handoff 用一句话写给下一段自己的交接摘要。",
    "</pixie-nap-request>",
  ].join("\n");
  const session = acquired.session;
  if (session.isStreaming) {
    void session.steer(instruction).catch(() => undefined);
    return { ok: true };
  }
  void session.prompt(instruction).catch(() => undefined);
  return { ok: true };
}

/** pixie_rest tool landing (control plane): rest at the next run boundary. */
export async function requestPixieRest(
  factory: WorkspaceGraphFactory,
  args: {
    agentDir: string;
    phrase?: string | null;
    handoff?: string | null;
    title?: string | null;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const state = ensureRunner(args.agentDir);
  const acquired = await acquireCurrentSession(factory, args.agentDir);
  if (!acquired) return { ok: false, error: "当前没有进行中的会话段" };
  state.pendingRest = {
    phrase: args.phrase?.trim() || null,
    handoff: args.handoff?.trim() || null,
    title: args.title?.trim() || null,
    reason: "agent",
  };
  state.pendingUserRest = false;
  return { ok: true };
}

/* ── 页面入口与 prompt 前导 ─────────────────────────────────────── */

/**
 * Desktop 页面打开时的入口（pixie.ensureCurrent）：确保图与当前会话存在，
 * 顺手做每日打盹的懒判定，返回前端应当打开的会话。前端随后走标准的
 * workspace.setCurrent + session.open。
 */
export async function ensurePixieCurrent(
  factory: WorkspaceGraphFactory,
  agentDir: string,
): Promise<
  { ok: true; cwd: string; sessionId: string; sessionPath: string } | { ok: false; error: string }
> {
  const state = ensureRunner(agentDir);
  let acquired = await acquireCurrentSession(factory, agentDir);
  if (!acquired) return { ok: false, error: "小精灵工作区图不可用" };
  if (
    state.pendingRest === null &&
    !state.pendingUserRest &&
    !acquired.session.isStreaming &&
    maybeDailyNap(state, factory, acquired.session)
  ) {
    // 每日打盹成立：等旋转完成再返回，前端打开的就是干净的新会话。
    if (state.rotateInFlight) {
      try {
        await state.rotateInFlight;
      } catch {
        /* fall through with whatever the pointer holds now */
      }
    }
    const again = await acquireCurrentSession(factory, agentDir);
    if (again) acquired = again;
  }
  notePixieActivity(state, Date.now());
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
 * agent-controller 用它把小精灵会话从「新建即自动起名」的路径摘出来——
 * 段名统一等打盹收尾时再定（见 segmentSessionName）。
 */
export function isPixieWorkspaceCwd(factory: WorkspaceGraphFactory, sessionCwd: string): boolean {
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

/**
 * agent-controller prompt 路径的前导注入：会话属于小精灵工作区且还没吃过
 * <pixie-context> 时，把身份 + 交接 + 已知工作区前导包在首条用户消息外层。
 */
export function maybeWrapPixiePrompt(
  factory: WorkspaceGraphFactory,
  sessionCwd: string,
  text: string,
): string {
  // 防御：测试桩/非常规工厂可能没有 deps —— 此时按「非小精灵会话」处理。
  const agentDir = factory?.deps?.agentDir;
  if (!agentDir || typeof factory?.canonicalizeCwd !== "function") return text;
  const state = runner && runner.agentDir === agentDir ? runner : ensureRunner(agentDir);
  if (!isPixieWorkspaceCwd(factory, sessionCwd)) return text;
  if (!state.needsPreamble) return text;
  state.needsPreamble = false;
  saveRunnerState(state);
  notePixieActivity(state, Date.now());
  return `${buildSegmentContextPreamble(agentDir, state.lastHandoff)}\n${text}`;
}

/**
 * 新会话段的时间锚点。前导只吃一次（段的首条用户消息），所以这行写的是「本段
 * 开始」的时刻；不注入的话，模型会拿备忘录里的「周一」这类线索硬猜今天。
 */
export function pixieClockLine(now: Date): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const offsetHours = -now.getTimezoneOffset() / 60;
  const zone = `UTC${offsetHours < 0 ? "−" : "+"}${Math.abs(offsetHours)}`;
  return `本段开始时间：${date}（${weekday}）${time}，${zone}。判断「今天/周几/是否逾期」以它为准，跨天了先跑一次 date 校准，不要凭记忆推。`;
}

/** Built-in identity + handoff + known-workspaces preamble for a fresh session. */
function buildSegmentContextPreamble(agentDir: string, handoff: string | null): string {
  const workspaces = knownWorkspacesOf(agentDir);
  const lines = [
    "[pixie|ui]",
    "<pixie-context>",
    "你是小精灵，PiAbyss 桌面里的常驻小助手（人格、语气与工作方式见工作区 CLAUDE.md）。",
    pixieClockLine(new Date()),
    "委派落点：默认只复用【你自己创建的】会话，没有就新开一个。用户自己在界面里创建的会话不要自动复用；只有用户明确给出会话 id 时，才用 sessionId 参数指定（找不到会直接报错，不要改派到别的会话）。",
    "排队：目标会话有活在跑时，新任务会排队并返回排队说明——不要重复派单，也不用自己数着等，对方回调时你会收到信封。",
    "回调：信封自带处理要求，照它办。总则——完成只转述、不代写总结；报错在「原样重试 / 调整委派词再派 / 如实报告」里选，但同一任务连败 3 次就别再试，带全部现场升级给用户；询问立刻转述给用户、不要代答，用户的下一条消息就是答复。",
    "模型与推理深度：默认不传 model / thinkingLevel（跟随会话当前设置）。仅当用户在对话中明确指定（如「用 xxx 模型跑」「深度调到 high」）时才传，绝不主动更换。",
    "委派目标 cwd 必须来自下方已知工作区列表（或用户当前打开的工作区）；用户手动指令的优先级最高。",
    ...(handoff ? [`刚睡醒。上一段的小结：${handoff}`] : []),
    ...(workspaces.length > 0
      ? ["已知的 PiAbyss 工作区：", ...workspaces.map((path) => `- ${path}`)]
      : []),
    "</pixie-context>",
  ];
  return lines.join("\n");
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
  const delivered = await deliverToCurrentSegment(factory, {
    agentDir: args.agentDir,
    text: envelope.join("\n"),
    source: "system",
    interactive: false,
    // 锚点只认终态结果回执（pixie_report 的 done/error）；ask/progress/stopped
    // 也走这条注入通道，但它们不是「结果落位」的那条消息。
    anchorDispatchId: args.kind === "done" || args.kind === "error" ? record.id : null,
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
