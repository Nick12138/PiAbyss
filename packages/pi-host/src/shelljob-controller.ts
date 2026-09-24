/**
 * Handlers for the background shell job status bar (shelljobs.* methods).
 * Stop is delegated to pi-shelljob's authenticated loopback control endpoint,
 * so the extension owns process termination, state transition and notification.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHostError, type HostError } from "@piabyss/protocol";
import type { MethodHandler } from "./server.js";
import { readShellJob, readShellJobs } from "./shelljob-store.js";

const DEFAULT_CONTROL_PORT = 18_767;
const CONTROL_TIMEOUT_MS = 15_000;

function controlPort(): number {
  const value = Number.parseInt(process.env.SHELLJOB_CONTROL_PORT ?? "", 10);
  return Number.isInteger(value) && value > 0 && value < 65_536 ? value : DEFAULT_CONTROL_PORT;
}

function controlToken(): string | null {
  const fromEnv = process.env.SHELLJOB_CONTROL_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const token = readFileSync(join(homedir(), ".pi", "shelljob", "token"), "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

function jobError(code: HostError["code"], message: string): HostError {
  return createHostError(code, message);
}

export function createShellJobHandlers(): Record<string, MethodHandler> {
  return {
    "shelljobs.list": async () => ({ result: { jobs: readShellJobs() } }),

    "shelljobs.stop": async (ctx) => {
      const jobId = (ctx.params as { jobId: string }).jobId;
      const job = readShellJob(jobId);
      if (!job) {
        return { error: jobError("RESOURCE_NOT_FOUND", `后台任务 ${jobId} 不存在`) };
      }
      // The plugin is authoritative for terminal/running state. Do not reject
      // from this potentially stale Host snapshot; it handles already-ended and
      // concurrent kill requests idempotently.
      const token = controlToken();
      if (!token) {
        return {
          error: jobError("HOST_NOT_READY", "pi-shelljob 控制接口尚未就绪（缺少认证 token）"),
        };
      }
      // Derive the caller session from the locally persisted owning job record,
      // not from a UI-supplied value. The plugin independently checks that the
      // target job belongs to this session before allowing termination.
      const sessionId = job.sessionId;
      if (!sessionId) {
        return { error: jobError("INVALID_REQUEST", `后台任务 ${jobId} 缺少会话归属`) };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS);
      try {
        const response = await fetch(`http://127.0.0.1:${controlPort()}/api/jobs/stop`, {
          method: "POST",
          // Never forward the bearer token through an HTTP redirect.
          redirect: "error",
          headers: {
            "content-type": "application/json",
            "x-pi-shelljob-token": token,
            "x-pi-session-id": sessionId,
          },
          body: JSON.stringify({ jobId }),
          signal: controller.signal,
        });
        const result = (await response.json().catch(() => null)) as {
          ok?: boolean;
          status?: string;
          error?: string;
        } | null;
        if (
          response.ok &&
          result?.ok &&
          (result.status === "killed" || result.status === "already_ended")
        ) {
          return { result: { stopped: true } };
        }
        if (response.status === 404) {
          return {
            error: jobError("RESOURCE_NOT_FOUND", result?.error ?? `后台任务 ${jobId} 不存在`),
          };
        }
        if (response.status === 403) {
          return {
            error: jobError("INVALID_REQUEST", result?.error ?? "后台任务会话归属校验失败"),
          };
        }
        if (response.status === 401) {
          return { error: jobError("HOST_NOT_READY", "pi-shelljob 控制接口认证失败") };
        }
        return {
          error: jobError(
            response.status === 503 ? "HOST_NOT_READY" : "INTERNAL_ERROR",
            result?.error ?? `pi-shelljob 停止接口返回 HTTP ${response.status}`,
          ),
        };
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        return {
          error: jobError(
            "HOST_NOT_READY",
            timedOut
              ? "等待 pi-shelljob 停止接口超时"
              : `无法连接 pi-shelljob 停止接口：${error instanceof Error ? error.message : String(error)}`,
          ),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
