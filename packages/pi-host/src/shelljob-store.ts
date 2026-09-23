/**
 * Read access to pi's background shell job store (`~/.pi/shelljob/jobs/<id>/`).
 *
 * The shelljob tool is a pi built-in extension: it persists each job as
 * `job.json` (command/cwd/sessionId/createdAt), `status.json`
 * (status/pid/startedAt/finishedAt) and a growing `output.log`. None of this
 * is a public contract — everything here must stay tolerant of missing or
 * malformed files (the directory also accumulates test debris), and all
 * layout knowledge is intentionally confined to this module.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ShellJobStatus, ShellJobSummary } from "@piabyss/protocol";

/** Directory may contain test debris; keep scans bounded. */
const MAX_JOBS = 200;

type ShellJobRecord = {
  id?: unknown;
  command?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
  createdAt?: unknown;
  title?: unknown;
};

type ShellJobStatusRecord = {
  status?: unknown;
  pid?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
};

export function shelljobJobsRoot(): string {
  return join(homedir(), ".pi", "shelljob", "jobs");
}

function shelljobDir(jobId: string, root: string): string {
  return join(root, jobId);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function mapStatus(status: unknown): ShellJobStatus {
  return status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "killed"
    ? status
    : "unknown";
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Read every parseable job under the store, newest first. */
export function readShellJobs(root: string = shelljobJobsRoot()): ShellJobSummary[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const jobs: ShellJobSummary[] = [];
  for (const name of entries.slice(0, 1024)) {
    if (!name.startsWith("job_")) continue;
    const dir = shelljobDir(name, root);
    const job = readJson<ShellJobRecord>(join(dir, "job.json"));
    if (!job || typeof job !== "object") continue;
    const id = typeof job.id === "string" && job.id ? job.id : name;
    const command = typeof job.command === "string" ? job.command : "";
    const cwd = typeof job.cwd === "string" ? job.cwd : "";
    const sessionId = typeof job.sessionId === "string" ? job.sessionId : "";
    const createdAt = asPositiveInt(job.createdAt);
    if (!command || !sessionId || createdAt === undefined) continue;
    const status = readJson<ShellJobStatusRecord>(join(dir, "status.json"));
    const summary: ShellJobSummary = {
      id,
      command,
      cwd,
      sessionId,
      createdAt,
      status: mapStatus(status?.status),
      ...(typeof job.title === "string" && job.title.trim() ? { title: job.title.trim() } : {}),
      ...(asPositiveInt(status?.pid) !== undefined ? { pid: asPositiveInt(status?.pid) } : {}),
      ...(asPositiveInt(status?.startedAt) !== undefined
        ? { startedAt: asPositiveInt(status?.startedAt) }
        : {}),
      ...(asPositiveInt(status?.finishedAt) !== undefined
        ? { finishedAt: asPositiveInt(status?.finishedAt) }
        : {}),
    };
    jobs.push(summary);
    if (jobs.length >= MAX_JOBS) break;
  }
  jobs.sort((left, right) => right.createdAt - left.createdAt);
  return jobs;
}

/** Read a single job's summary; null when the job directory is gone. */
export function readShellJob(
  jobId: string,
  root: string = shelljobJobsRoot(),
): ShellJobSummary | null {
  return readShellJobs(root).find((job) => job.id === jobId) ?? null;
}
