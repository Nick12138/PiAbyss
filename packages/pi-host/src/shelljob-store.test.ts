import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readShellJob,
  readShellJobOutput,
  readShellJobs,
  shelljobJobsRoot,
} from "./shelljob-store.js";

let home: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => home,
  };
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "piabyss-shelljob-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const SESSION_ID = "0195c9e7-7b1a-7e12-9c34-5f6a7b8c9d01";

function writeJob(
  jobId: string,
  overrides: { status?: string; command?: string; cwd?: string; sessionId?: string } = {},
): void {
  const dir = join(shelljobJobsRoot(), jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "job.json"),
    JSON.stringify({
      id: jobId,
      title: overrides.command ? `任务 ${jobId}` : undefined,
      command: overrides.command ?? "npm run build",
      cwd: overrides.cwd ?? "D:/repo",
      sessionId: overrides.sessionId ?? SESSION_ID,
      createdAt: 1_700_000_000_000,
    }),
    "utf8",
  );
  writeFileSync(
    join(dir, "status.json"),
    JSON.stringify({
      status: overrides.status ?? "running",
      pid: 4321,
      startedAt: 1_700_000_000_100,
      ...(overrides.status && overrides.status !== "running"
        ? { finishedAt: 1_700_000_060_000 }
        : {}),
    }),
    "utf8",
  );
}

describe("shelljob-store", () => {
  it("lists parseable jobs newest first and skips debris", () => {
    writeJob("job_b", { status: "completed", command: "echo later" });
    writeJob("job_a", { command: "echo earlier" });
    mkdirSync(join(shelljobJobsRoot(), "not_a_job"), { recursive: true });
    mkdirSync(join(shelljobJobsRoot(), "job_broken"), { recursive: true });
    writeFileSync(join(shelljobJobsRoot(), "job_broken", "job.json"), "{oops", "utf8");

    const jobs = readShellJobs();
    expect(jobs.map((job) => job.id)).toEqual(["job_a", "job_b"]);
    expect(jobs[0]).toMatchObject({
      id: "job_a",
      command: "echo earlier",
      status: "running",
      pid: 4321,
    });
    expect(jobs[1]).toMatchObject({
      status: "completed",
      finishedAt: 1_700_000_060_000,
    });
  });

  it("reads a single job", () => {
    writeJob("job_x");
    expect(readShellJob("job_x")?.sessionId).toBe(SESSION_ID);
    expect(readShellJob("job_missing")).toBeNull();
  });

  it("returns null for jobs without output", () => {
    writeJob("job_quiet");
    expect(readShellJobOutput("job_quiet")).toBeNull();
    expect(readShellJobOutput("job_missing")).toBeNull();
  });

  it("tails the last lines and drops the trailing newline", () => {
    writeJob("job_out");
    writeFileSync(join(shelljobJobsRoot(), "job_out", "output.log"), "a\nb\nc\n", "utf8");
    expect(readShellJobOutput("job_out", 10)).toEqual({
      lines: ["a", "b", "c"],
      truncated: false,
    });
    expect(readShellJobOutput("job_out", 2)).toEqual({
      lines: ["b", "c"],
      truncated: true,
    });
  });

  it("clamps the limit and drops the partial first line of a byte-window tail", () => {
    writeJob("job_big");
    const content = `${Array.from({ length: 10_000 }, (_, i) => `${"x".repeat(64)}${i}`).join("\n")}\n`;
    writeFileSync(join(shelljobJobsRoot(), "job_big", "output.log"), content, "utf8");

    const output = readShellJobOutput("job_big", 999);

    expect(output?.lines.length).toBe(500);
    expect(output?.truncated).toBe(true);
    expect(output?.lines[0]).toMatch(/9500$/);
    expect(output?.lines[499]).toMatch(/9999$/);
  });
});
