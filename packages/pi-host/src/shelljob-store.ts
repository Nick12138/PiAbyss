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
import { closeSync, fstatSync, openSync, readSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ShellJobStatus, ShellJobSummary } from "@piabyss/protocol";

/** Directory may contain test debris; keep scans bounded. */
const MAX_JOBS = 200;

/** Tail-read caps so a huge output.log never becomes a memory/UI problem. */
const OUTPUT_TAIL_BYTES = 256 * 1024;
const OUTPUT_MAX_LINES = 500;
const OUTPUT_LINE_MAX_CHARS = 4_000;

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

/**
 * Tail-read a job's `output.log`: the last `limit` lines (1..500, default 200),
 * capped at OUTPUT_TAIL_BYTES from the end of file so long-running jobs stay
 * cheap. Null when there is no output file yet (job not started / debris).
 */
export function readShellJobOutput(
  jobId: string,
  limit: number = 200,
  root: string = shelljobJobsRoot(),
): { lines: string[]; truncated: boolean } | null {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 200, 1), OUTPUT_MAX_LINES);
  let fd: number;
  try {
    fd = openSync(join(shelljobDir(jobId, root), "output.log"), "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const readSize = Math.min(size, OUTPUT_TAIL_BYTES);
    const buffer = Buffer.alloc(readSize);
    readSync(fd, buffer, 0, readSize, Math.max(0, size - readSize));
    let lines = buffer.toString("utf8").split(/\r?\n/);
    let truncated = readSize < size;
    // The read window can start mid-line/mid-character — drop the first fragment.
    if (truncated && lines.length > 0) lines = lines.slice(1);
    // Files usually end with a newline; drop the empty trailing entry.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
    // Defensively cap pathological single lines (minified dumps, progress bars).
    lines = lines.map((line) =>
      line.length > OUTPUT_LINE_MAX_CHARS ? `${line.slice(0, OUTPUT_LINE_MAX_CHARS - 1)}…` : line,
    );
    if (lines.length > boundedLimit) {
      lines = lines.slice(-boundedLimit);
      truncated = true;
    }
    return { lines, truncated };
  } finally {
    closeSync(fd);
  }
}
