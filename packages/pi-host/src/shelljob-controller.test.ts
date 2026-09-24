import { afterEach, describe, expect, it, vi } from "vitest";
import { createShellJobHandlers } from "./shelljob-controller.js";
import type { HandlerContext } from "./server.js";
import type { ShellJobSummary } from "@piabyss/protocol";

const SESSION_ID = "0195c9e7-7b1a-7e12-9c34-5f6a7b8c9d01";
const JOB: ShellJobSummary = {
  id: "job_abc123",
  command: "npm run build",
  cwd: "/repo",
  sessionId: SESSION_ID,
  createdAt: 1_700_000_000_000,
  status: "running",
};

vi.mock("node:fs", () => ({ readFileSync: vi.fn(() => "secret-token") }));
vi.mock("node:os", () => ({ homedir: () => "/home/test" }));
vi.mock("./shelljob-store.js", () => ({
  readShellJob: vi.fn(() => JOB),
  readShellJobs: vi.fn(() => [JOB]),
}));

function context(params: unknown): HandlerContext {
  return { params } as HandlerContext;
}

afterEach(() => vi.restoreAllMocks());

describe("shelljobs.stop handler", () => {
  it("delegates the stop to the authenticated pi-shelljob endpoint with the job session", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, status: "killed", jobId: JOB.id }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const handler = createShellJobHandlers()["shelljobs.stop"]!;

    const outcome = await handler(context({ jobId: JOB.id }));

    expect(outcome).toEqual({ result: { stopped: true } });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18767/api/jobs/stop",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-pi-shelljob-token": "secret-token",
          "x-pi-session-id": SESSION_ID,
        }),
        body: JSON.stringify({ jobId: JOB.id }),
      }),
    );
  });

  it("does not report failed plugin stops as successful", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, status: "failed", jobId: JOB.id }), {
            status: 500,
          }),
      ),
    );
    const handler = createShellJobHandlers()["shelljobs.stop"]!;

    const outcome = await handler(context({ jobId: JOB.id }));

    expect("error" in outcome).toBe(true);
  });
});
