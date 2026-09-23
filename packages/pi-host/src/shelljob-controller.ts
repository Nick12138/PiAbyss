/**
 * Handlers for the background shell job status bar (shelljobs.* methods).
 *
 * Read paths go through shelljob-store; stop performs a best-effort process
 * tree kill using the pid recorded in status.json. pid reuse is the main
 * hazard: the window between "job running" and our kill is short, and we
 * re-check status.json (single source of truth for the extension) right
 * before signaling — a reused pid whose status.json still says "running" is
 * accepted as residual risk rather than guessing at process cmdlines.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHostError, type HostError } from "@piabyss/protocol";
import type { MethodHandler } from "./server.js";
import { readShellJob, readShellJobs } from "./shelljob-store.js";

const execFileP = promisify(execFile);

/** Grace period between SIGTERM and SIGKILL on POSIX tree kills. */
const POSIX_TERM_GRACE_MS = 1_500;

async function isPidAlive(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      process.kill(pid, 0);
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tree-kill a job's pid. Returns false when nothing matching was alive. */
async function killJobProcess(jobPid: number): Promise<boolean> {
  if (process.platform === "win32") {
    try {
      // /T covers the child tree the pi extension spawns detached.
      await execFileP("taskkill", ["/PID", String(jobPid), "/T", "/F"], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }
  // POSIX: prefer the process group (shelljob workers run detached), fall
  // back to the pid itself; escalate to SIGKILL after the grace period.
  const signal = (negated: boolean, sig: NodeJS.Signals): boolean => {
    try {
      process.kill(negated ? -jobPid : jobPid, sig);
      return true;
    } catch {
      return false;
    }
  };
  const signaled = signal(true, "SIGTERM") || signal(false, "SIGTERM");
  if (!signaled) return false;
  await sleep(POSIX_TERM_GRACE_MS);
  if (await isPidAlive(jobPid)) {
    if (!signal(true, "SIGKILL")) signal(false, "SIGKILL");
  }
  return true;
}

function jobError(code: HostError["code"], message: string): HostError {
  return createHostError(code, message);
}

export function createShellJobHandlers(): Record<string, MethodHandler> {
  return {
    "shelljobs.list": async () => {
      return { result: { jobs: readShellJobs() } };
    },

    "shelljobs.stop": async (ctx) => {
      const jobId = (ctx.params as { jobId: string }).jobId;
      // Fresh read right before signaling: the extension flips status.json on
      // exit, so a stale "running" snapshot is re-checked here.
      const job = readShellJob(jobId);
      if (!job) {
        return { error: jobError("RESOURCE_NOT_FOUND", `后台任务 ${jobId} 不存在`) };
      }
      if (job.status !== "running") {
        return { error: jobError("INVALID_REQUEST", `后台任务 ${jobId} 已结束，无需停止`) };
      }
      if (!job.pid) {
        return { error: jobError("INTERNAL_ERROR", `后台任务 ${jobId} 缺少进程信息，无法停止`) };
      }
      const killed = await killJobProcess(job.pid);
      if (!killed) {
        return {
          error: jobError("INTERNAL_ERROR", `停止后台任务 ${jobId} 失败（进程可能已退出）`),
        };
      }
      // The extension owns status.json and will mark the job killed on its
      // own reap cycle; the watcher picks that up within one poll interval.
      return { result: { stopped: true } };
    },
  };
}
