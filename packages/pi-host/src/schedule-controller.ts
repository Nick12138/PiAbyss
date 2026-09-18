/**
 * Handlers for the pi-schedule plugin control plane (schedule.* methods).
 *
 * Thin proxy: protocol params → plugin HTTP endpoints (see the plugin's
 * docs/CONTRACT.md). No local state; the plugin owns jobs.json and the
 * scheduler. Health is a liveness probe — when the plugin isn't loaded the
 * loopback port is closed and schedule.status reports available:false
 * instead of failing the whole request.
 */
import { createHostError, type HostError } from "@piabyss/protocol";
import type { MethodHandler } from "./server.js";
import { scheduleApi, type ScheduleApiOutcome } from "./schedule-api.js";
import {
  abortAgent,
  agentState,
  agentTranscriptFrom,
  continueAgentConversation,
  listAgentSessions,
  sendAgentMessage,
  startAgentConversation,
} from "./schedule-agent-runner.js";

/** Health probe: short timeout, the port is closed when the plugin is off. */
const HEALTH_TIMEOUT_MS = 2_500;
/** run_now / reply wait for the execution to finish — give it headroom. */
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
      return createHostError("INTERNAL_ERROR", `定时任务控制面错误（HTTP ${outcome.status}）：${outcome.error}`);
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

export function createScheduleHandlers(agentDir: string): Partial<Record<string, MethodHandler>> {
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
      return expectOk(outcome);
    },

    "schedule.listRuns": async (ctx) => {
      const params = (ctx.params ?? {}) as { jobId?: string | null; limit?: number };
      const search = new URLSearchParams();
      if (params.jobId) search.set("jobId", params.jobId);
      if (params.limit !== undefined) search.set("limit", String(params.limit));
      const query = search.toString();
      const base = params.jobId
        ? `/api/jobs/${params.jobId}/runs`
        : "/api/runs";
      const outcome = await scheduleApi<{ runs: unknown[] }>(
        query ? `${base}?${query}` : base,
        "GET",
      );
      return expectOk(outcome);
    },

    "schedule.getRunTranscript": async (ctx) => {
      const params = ctx.params as { runId: string };
      const outcome = await scheduleApi<{
        runId: string;
        sessionPath: string | null;
        entries: unknown[];
      }>(`/api/runs/${params.runId}/transcript`, "GET");
      return expectOk(outcome);
    },

    "schedule.replyToRun": async (ctx) => {
      const params = ctx.params as { runId: string; text: string };
      const outcome = await scheduleApi<{ run: unknown }>(
        `/api/runs/${params.runId}/reply`,
        "POST",
        { body: { text: params.text }, timeoutMs: RUN_NOW_TIMEOUT_MS },
      );
      return expectOk(outcome);
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

    "schedule.agentStart": async (ctx) => {
      const params = ctx.params as { cwd: string; requirement: string };
      try {
        return { result: await startAgentConversation({ ...params, agentDir }) };
      } catch (error) {
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    },

    "schedule.agentList": async () => {
      try {
        return { result: { sessions: listAgentSessions() } };
      } catch (error) {
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    },

    "schedule.agentSend": async (ctx) => {
      const params = ctx.params as { sessionId: string; text: string };
      const result = await sendAgentMessage(params);
      if (result.ok) return { result: { sessionId: params.sessionId } };
      return { error: createHostError("INVALID_REQUEST", result.error) };
    },

    "schedule.agentContinue": async (ctx) => {
      const params = ctx.params as { sessionPath: string; cwd: string; text: string };
      try {
        const result = await continueAgentConversation({ ...params, agentDir });
        if ("ok" in result) {
          return { error: createHostError("RESOURCE_NOT_FOUND", result.error) };
        }
        return { result: { sessionId: result.sessionId, sessionPath: result.sessionPath } };
      } catch (error) {
        return {
          error: createHostError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    },

    "schedule.agentState": async (ctx) => {
      const params = ctx.params as { sessionId: string };
      return { result: agentState(params.sessionId) };
    },

    "schedule.agentTranscript": async (ctx) => {
      const params = ctx.params as { sessionPath: string };
      const messages = agentTranscriptFrom(params.sessionPath);
      return { result: { found: messages.length > 0, messages } };
    },

    "schedule.agentAbort": async (ctx) => {
      const params = ctx.params as { sessionId: string };
      return { result: { ok: abortAgent(params.sessionId) } };
    },
  };
}
