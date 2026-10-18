/**
 * Handlers for the pi-schedule plugin control plane (schedule.* methods).
 *
 * Thin proxy: protocol params → plugin HTTP endpoints (see the plugin's
 * docs/CONTRACT.md). No local state; the plugin owns jobs.json and the
 * scheduler. Health is a liveness probe — when the plugin isn't loaded the
 * loopback port is closed and schedule.status reports available:false
 * instead of failing the whole request.
 */
import { isAbsolute, join, relative, resolve } from "node:path";
import { createHostError, type HostError } from "@piabyss/protocol";
import type { MethodHandler } from "./server.js";
import { scheduleApi, scheduleRoot, type ScheduleApiOutcome } from "./schedule-api.js";
import { agentTranscriptFrom } from "./jsonl-transcript.js";

/** Health probe: short timeout, the port is closed when the plugin is off. */
const HEALTH_TIMEOUT_MS = 2_500; /** run_now / reply wait for the execution to finish — give it headroom. */
const RUN_NOW_TIMEOUT_MS = 31 * 60 * 1000;

function mapHttpError(outcome: { status: number | null; error: string }): HostError {
  if (outcome.status === null) {
    // Transport failure: plugin not loaded / port closed.
    return createHostError("CATALOG_UNAVAILABLE", `定时任务插件不可用：${outcome.error}`, {
      retryable: true,
    });
  }
  switch (outcome.status) {
    case 400:
      return createHostError("INVALID_REQUEST", outcome.error);
    case 401:
      return createHostError("AUTH_REQUIRED", `定时任务控制面鉴权失败：${outcome.error}`);
    case 404:
      return createHostError("RESOURCE_NOT_FOUND", outcome.error);
    case 409:
      // Single-flight conflict: the job is already running.
      return createHostError("AGENT_BUSY", outcome.error, { retryable: true });
    default:
      return createHostError(
        "INTERNAL_ERROR",
        `定时任务控制面错误（HTTP ${outcome.status}）：${outcome.error}`,
      );
  }
}

function expectOk<T>(outcome: ScheduleApiOutcome<T>): { result: T } | { error: HostError } {
  if (outcome.ok) return { result: outcome.data };
  return { error: mapHttpError(outcome) };
}

/** run_now timeout: honor the caller's override so long jobs don't cut off early. */
function runNowTimeout(timeoutMsOverride: number | undefined): number {
  if (
    typeof timeoutMsOverride === "number" &&
    Number.isSafeInteger(timeoutMsOverride) &&
    timeoutMsOverride > 0
  ) {
    return Math.min(timeoutMsOverride + 60_000, 6 * 60 * 60 * 1000 + 60_000);
  }
  return RUN_NOW_TIMEOUT_MS;
}

/**
 * 摘要字段兜底：`tools` / `sessionPath` / `command` 是插件后加的三个字段。
 * 插件是独立安装的包，版本落后于宿主是常态——缺字段要按「没有」如实补默认值，
 * 而不是让整次 listRuns 卡在结果校验上、面板直接打不开。
 */
function normalizeRunSummary(value: unknown): Record<string, unknown> {
  const run = (value ?? {}) as Record<string, unknown>;
  return {
    ...run,
    tools: Array.isArray(run.tools)
      ? run.tools.filter((t): t is string => typeof t === "string")
      : [],
    sessionPath: typeof run.sessionPath === "string" ? run.sessionPath : null,
    command: typeof run.command === "string" ? run.command : null,
  };
}

/**
 * run 的会话文件必须落在本插件的数据根内才允许读盘：这个路径来自控制面的 HTTP 响应，
 * 上游一旦被换成别的实现，宿主不该变成任意文件读取器。
 */
function isInsideScheduleSessions(sessionPath: string): boolean {
  const root = resolve(join(scheduleRoot(), "sessions"));
  const target = resolve(sessionPath);
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function createScheduleHandlers(): Partial<Record<string, MethodHandler>> {
  return {
    "schedule.status": async () => {
      const outcome = await scheduleApi<{
        ok: boolean;
        root: string;
        port: number | null;
        activeJobs: string[];
        tickMs: number;
        maxConcurrent: number;
      }>("/api/health", "GET", { timeoutMs: HEALTH_TIMEOUT_MS });
      if (outcome.ok && outcome.data.ok === true) {
        return {
          result: { available: true, health: outcome.data, error: null },
        };
      }
      return {
        result: {
          available: false,
          health: null,
          error: outcome.ok ? "unexpected health payload" : outcome.error,
        },
      };
    },

    "schedule.listJobs": async () => {
      const outcome = await scheduleApi<{
        jobs: unknown[];
        root: string;
        activeJobs: string[];
      }>("/api/jobs", "GET");
      const mapped = expectOk(outcome);
      if ("error" in mapped) return mapped;
      return {
        result: {
          jobs: mapped.result.jobs,
          activeJobIds: mapped.result.activeJobs,
          root: mapped.result.root,
        },
      };
    },

    "schedule.createJob": async (ctx) => {
      const params = ctx.params as Record<string, unknown>;
      const outcome = await scheduleApi<{ job: unknown }>("/api/jobs", "POST", {
        body: { ...params, by: "piabyss" },
      });
      return expectOk(outcome);
    },

    "schedule.updateJob": async (ctx) => {
      const { id, ...patch } = ctx.params as Record<string, unknown> & { id: string };
      const outcome = await scheduleApi<{ job: unknown }>(`/api/jobs/${id}`, "PATCH", {
        body: { ...patch, by: "piabyss" },
      });
      return expectOk(outcome);
    },

    "schedule.deleteJob": async (ctx) => {
      const params = ctx.params as { id: string; purge?: boolean };
      const path = `/api/jobs/${params.id}${params.purge ? "?purge=1" : ""}`;
      const outcome = await scheduleApi<{ removed: boolean; purged: boolean }>(path, "DELETE");
      return expectOk(outcome);
    },

    "schedule.setJobEnabled": async (ctx) => {
      const params = ctx.params as { id: string; enabled: boolean };
      const outcome = await scheduleApi<{ job: unknown }>(
        `/api/jobs/${params.id}/${params.enabled ? "enable" : "disable"}`,
        "POST",
        { body: {} },
      );
      return expectOk(outcome);
    },

    "schedule.runJobNow": async (ctx) => {
      const params = ctx.params as {
        id: string;
        permission?: string;
        timeoutMs?: number;
      };
      const body: Record<string, unknown> = {};
      if (params.permission !== undefined) body.permission = params.permission;
      if (params.timeoutMs !== undefined) body.timeoutMs = params.timeoutMs;
      const outcome = await scheduleApi<{ run: unknown }>(
        `/api/jobs/${params.id}/run_now`,
        "POST",
        { body, timeoutMs: runNowTimeout(params.timeoutMs) },
      );
      const mapped = expectOk(outcome);
      if ("error" in mapped) return mapped;
      return { result: { run: normalizeRunSummary(mapped.result.run) } };
    },

    "schedule.listRuns": async (ctx) => {
      const params = (ctx.params ?? {}) as { jobId?: string | null; limit?: number };
      const search = new URLSearchParams();
      if (params.jobId) search.set("jobId", params.jobId);
      if (params.limit !== undefined) search.set("limit", String(params.limit));
      const query = search.toString();
      const base = params.jobId ? `/api/jobs/${params.jobId}/runs` : "/api/runs";
      const outcome = await scheduleApi<{ runs: unknown[] }>(
        query ? `${base}?${query}` : base,
        "GET",
      );
      const mapped = expectOk(outcome);
      if ("error" in mapped) return mapped;
      return { result: { runs: mapped.result.runs.map(normalizeRunSummary) } };
    },

    /**
     * 一次执行的**过程**。走读盘而不是插件的 `/runs/:id/transcript`：那个端点把消息
     * 拍平成纯文本、连 `toolResult` 都不返回（源码注释「工具输出噪音大，面板按需另取」），
     * 撑不出「像普通会话那样折叠思考与工具调用」。会话文件本来就在宿主可读的数据根里，
     * 投影直接复用智能创建会话那一套（块结构 + toolCallId/toolName 关联）。
     */
    "schedule.runMessages": async (ctx) => {
      const params = ctx.params as { runId: string };
      const outcome = await scheduleApi<{ run: Record<string, unknown> }>(
        `/api/runs/${encodeURIComponent(params.runId)}`,
        "GET",
      );
      const mapped = expectOk(outcome);
      if ("error" in mapped) return mapped;
      const record = (mapped.result.run ?? {}) as Record<string, unknown>;
      const sessionPath = typeof record.sessionPath === "string" ? record.sessionPath : null;
      const readable = sessionPath !== null && isInsideScheduleSessions(sessionPath);
      const messages = readable ? agentTranscriptFrom(sessionPath as string) : [];
      return {
        result: {
          // 命令型任务没有会话：found=false，面板改用 run 的 summary/outputText
          found: readable && messages.length > 0,
          sessionPath: readable ? sessionPath : null,
          running: record.status === "running",
          messages,
        },
      };
    },

    /**
     * 叫停正在执行的那一轮。只中止这一轮，任务与排期都不动；插件侧把 aborted 排除在
     * 投递计数之外（用户主动中止不消耗 maxRuns 配额）。已终态/宿主重启留下的僵尸 run
     * 由插件返回 409，映射成 AGENT_BUSY，面板据此把「停止」换成「已结束」。
     */
    "schedule.abortRun": async (ctx) => {
      const params = ctx.params as { runId: string };
      const outcome = await scheduleApi<{ aborted: boolean; run: unknown }>(
        `/api/runs/${encodeURIComponent(params.runId)}/abort`,
        "POST",
        { body: {} },
      );
      const mapped = expectOk(outcome);
      if ("error" in mapped) return mapped;
      return {
        result: {
          aborted: mapped.result.aborted === true,
          run: normalizeRunSummary(mapped.result.run),
        },
      };
    },

    "schedule.validateCron": async (ctx) => {
      const params = ctx.params as { cron: string; timezone?: string };
      const search = new URLSearchParams({ cron: params.cron });
      if (params.timezone) search.set("timezone", params.timezone);
      const outcome = await scheduleApi<{ valid: boolean; reason: string | null }>(
        `/api/cron/validate?${search.toString()}`,
        "GET",
      );
      return expectOk(outcome);
    },

    "schedule.listNotifications": async (ctx) => {
      const params = (ctx.params ?? {}) as { limit?: number };
      const query = params.limit !== undefined ? `?limit=${params.limit}` : "";
      const outcome = await scheduleApi<{ entries: unknown[] }>(
        `/api/notifications${query}`,
        "GET",
      );
      return expectOk(outcome);
    },
  };
}
