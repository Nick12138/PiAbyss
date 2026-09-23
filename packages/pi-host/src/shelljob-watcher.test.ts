import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startShellJobWatcher } from "./shelljob-watcher.js";

let root: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => root,
  };
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "piabyss-shelljob-watch-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeJob(jobId: string, status: string): void {
  const dir = join(root, "jobs", jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "job.json"),
    JSON.stringify({
      id: jobId,
      command: "sleep 30",
      cwd: root,
      sessionId: "0195c9e7-7b1a-7e12-9c34-5f6a7b8c9d01",
      createdAt: 1,
    }),
    "utf8",
  );
  writeFileSync(join(dir, "status.json"), JSON.stringify({ status, pid: 7 }), "utf8");
}

describe("shelljob-watcher", () => {
  it("emits the snapshot on change and dedupes unchanged polls", () => {
    vi.useFakeTimers();
    try {
      const events: Array<{ event: string; payload: unknown }> = [];
      const stop = startShellJobWatcher((event, payload) => events.push({ event, payload }), {
        pollMs: 10,
        root: join(root, "jobs"),
      });

      // First poll emits immediately with an empty store.
      expect(events).toHaveLength(1);
      expect(events[0]?.event).toBe("shelljobs.changed");

      writeJob("job_1", "running");
      vi.advanceTimersByTime(35);
      const withJob = events.filter((e) => {
        const jobs = (e.payload as { jobs: Array<{ id: string }> }).jobs;
        return jobs.some((job) => job.id === "job_1");
      });
      expect(withJob.length).toBeGreaterThanOrEqual(1);

      // Stable store → no further emissions.
      const count = events.length;
      vi.advanceTimersByTime(50);
      expect(events.length).toBe(count);

      stop();
      vi.advanceTimersByTime(50);
      expect(events.length).toBe(count); // stopped → no more polls
    } finally {
      vi.useRealTimers();
    }
  });
});
